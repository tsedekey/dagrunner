# /verify-seed — Runtime Cluster Setup + Data Seed

Stand up the headless Camunda all-in-one cluster against the worktree build, seed baseline data,
and produce a manual-test document for Gate 3.

You have access to the following env vars (set before this session):

- `$DEVHARNESS_SRC` — permanent camunda/camunda checkout (docker-compose lives here)
- `$DAGRUN_ARTIFACTS` — write all outputs here (manual-test.md, pids.json, aio.log)
- `$DAGRUN_RUN_ID` — the current dagrunner run ID
- `$DAGRUN_WORKTREE` — the worktree path (also your cwd)

## Resilience rule

If any step fails, diagnose the root cause, search for a solution (use web search, any available
MCP tools including Glean if configured), attempt a fix, and retry. Keep trying until the health
check passes or you have exhausted reasonable attempts (cap: 5 retries per step). Log each attempt
and its outcome. A failed node that gives up silently is worse than one that fails loudly with
a clear diagnosis — always report what you tried and why it failed.

## Step 1 — Start Elasticsearch

Check if ES is already healthy:

```bash
curl -sf http://localhost:9200/_cluster/health 2>/dev/null | grep -qE '"status":"(green|yellow)"' && echo "ES already up" || echo "ES needs start"
```

If ES is not up, start it using docker-compose (elasticsearch service only):

```bash
docker-compose -f "$DEVHARNESS_SRC/db/docker-compose.yml" up -d elasticsearch
```

Wait up to 120 s for ES to be ready (poll every 5 s):

```bash
for i in $(seq 24); do
  if curl -sf http://localhost:9200/_cluster/health 2>/dev/null | grep -qE '"status":"(green|yellow)"'; then
    echo "ES ready after $((i*5)) s"
    break
  fi
  echo "Waiting for ES... attempt $i/24"
  sleep 5
done
```

If ES never becomes ready after 120 s, diagnose: check `docker logs elasticsearch`, look for port
conflicts, OOM kills, or misconfigured heap. Fix and retry.

## Step 2 — Determine build scope and build the worktree

Find which modules changed relative to main:

```bash
git diff origin/main...HEAD --name-only
```

Determine the minimal Maven `-pl` scope that covers the changed files plus the `dist` module
(which is always needed for the all-in-one JAR). Build with tests skipped.

Create a writable Maven temp dir first (the sandbox may restrict writes to /tmp directly):

```bash
MAVEN_TMP="$DAGRUN_ARTIFACTS/maven-tmp"
mkdir -p "$MAVEN_TMP"
```

Build using the worktree's Maven wrapper:

```bash
./mvnw -T 1C -am -pl dist clean install -DskipTests -q \
  -Djava.io.tmpdir="$MAVEN_TMP" \
  -Dmaven.tmp="$MAVEN_TMP"
```

If the build fails:

1. Read the error carefully — look for missing deps, compilation errors, or plugin failures.
2. Check if a prior cached build broke things: `./mvnw dependency:resolve -pl dist -q` to
   verify dependencies resolve.
3. Search for the error message online or via available MCPs.
4. Fix the root cause and retry. Common issues:
   - `java.io.tmpdir` permission denied: the `-Djava.io.tmpdir` flag above should prevent this;
     if not, try `-Djava.io.tmpdir=/tmp` or set `export TMPDIR="$MAVEN_TMP"` before running mvnw
   - Port already in use: kill the conflicting process
   - Maven local repo corruption: `./mvnw dependency:purge-local-repository -pl <module>`
   - IntelliJ-generated class file conflicts: `find . -name "*.class" -path "*/out/*" -delete`

## Step 3 — Start the AIO application in the background

Find the distribution JAR:

```bash
JAR=$(find dist/target -name "camunda-dist-*.jar" -not -name "*sources*" -not -name "*javadoc*" | head -1)
echo "JAR: $JAR"
```

If no JAR is found, the build in Step 2 may have failed silently — inspect `dist/target/` and
re-run the build if needed.

Start the AIO in the background (it must survive this session ending):

```bash
CAMUNDA_MODE=all-in-one \
CAMUNDA_INSECURE=true \
CAMUNDA_DEVELOPMENT=true \
CAMUNDA_SECURITY_INITIALIZATION_DEFAULTROLES_ADMIN_USERS_0_=demo \
CAMUNDA_SECURITY_INITIALIZATION_USERS_0_EMAIL=demo@example.com \
CAMUNDA_SECURITY_INITIALIZATION_USERS_0_NAME=Demo \
CAMUNDA_SECURITY_INITIALIZATION_USERS_0_PASSWORD=demo \
CAMUNDA_SECURITY_INITIALIZATION_USERS_0_USERNAME=demo \
nohup java \
  --add-opens=java.base/java.io=ALL-UNNAMED \
  --add-opens=java.base/jdk.internal.misc=ALL-UNNAMED \
  -jar "$JAR" \
  > "$DAGRUN_ARTIFACTS/aio.log" 2>&1 &
AIO_PID=$!
disown $AIO_PID
echo "AIO started with PID $AIO_PID"
```

## Step 4 — Wait for the AIO to be healthy

Poll `localhost:9600/actuator/health` every 10 s for up to 5 minutes (30 attempts):

```bash
for i in $(seq 30); do
  STATUS=$(curl -sf http://localhost:9600/actuator/health 2>/dev/null | grep -o '"status":"[^"]*"' | head -1)
  if echo "$STATUS" | grep -q '"UP"'; then
    echo "AIO healthy after $((i*10)) s"
    break
  fi
  echo "Waiting for AIO... attempt $i/30 (status: $STATUS)"
  sleep 10
done
```

If not healthy after 5 min, check `$DAGRUN_ARTIFACTS/aio.log` for errors. Common issues:

- Port 8080/26500/9600 already in use: identify the conflicting PID with `lsof -i :9600` and
  kill it, then restart the AIO.
- Elasticsearch connection refused: ensure ES from Step 1 is still running.
- Out-of-memory: increase heap with `-Xmx2g` added to the java command.
- Missing Elasticsearch index templates: wait longer (ES schema setup can take >1 min).

If you fix an issue and need to restart, kill the current AIO process first:

```bash
kill $AIO_PID 2>/dev/null; sleep 3
```

Then repeat the start command from Step 3.

## Step 5 — Seed baseline data

Write a minimal BPMN process file:

```bash
cat > /tmp/dagrunner-verify-$DAGRUN_RUN_ID.bpmn << 'BPMN'
<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions
  xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  id="dagrunner-verify"
  targetNamespace="http://dagrunner">
  <bpmn:process id="dagrunner-verify-seed" name="DagRunner Verify Seed" isExecutable="true">
    <bpmn:startEvent id="start" />
    <bpmn:endEvent id="end" />
    <bpmn:sequenceFlow id="flow1" sourceRef="start" targetRef="end" />
  </bpmn:process>
</bpmn:definitions>
BPMN
```

Deploy the process (Camunda 8 REST API, port 8080; auth: demo/demo):

```bash
DEPLOY_RESPONSE=$(curl -sf -u demo:demo \
  -X POST http://localhost:8080/v2/deployments \
  -H "Accept: application/json" \
  -F "files=@/tmp/dagrunner-verify-$DAGRUN_RUN_ID.bpmn")
echo "Deploy response: $DEPLOY_RESPONSE"
PROCESS_KEY=$(echo "$DEPLOY_RESPONSE" | grep -o '"processDefinitionKey":[0-9]*' | head -1 | grep -o '[0-9]*')
```

If deployment fails (404, auth error, API not ready), wait 30 s and retry — the REST API may
not be fully initialised even after the health check passes.

Start one process instance:

```bash
INSTANCE_RESPONSE=$(curl -sf -u demo:demo \
  -X POST http://localhost:8080/v2/process-instances \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{\"processDefinitionKey\": $PROCESS_KEY, \"variables\": {\"seededBy\": \"dagrunner\", \"runId\": \"$DAGRUN_RUN_ID\"}}")
echo "Instance response: $INSTANCE_RESPONSE"
INSTANCE_KEY=$(echo "$INSTANCE_RESPONSE" | grep -o '"processInstanceKey":[0-9]*' | head -1 | grep -o '[0-9]*')
```

## Step 6 — Write outputs

Write `$DAGRUN_ARTIFACTS/pids.json` so cleanup can stop the cluster:

```json
{
  "aio": <AIO_PID>,
  "aio_log": "<DAGRUN_ARTIFACTS>/aio.log",
  "es_container": "elasticsearch"
}
```

Write `$DAGRUN_ARTIFACTS/manual-test.md` — this is what Gate 3 presents to the human:

```markdown
# Manual Verification Test

## What Was Seeded

| Item                   | Value                 |
| ---------------------- | --------------------- |
| Process definition     | dagrunner-verify-seed |
| Process definition key | <PROCESS_KEY>         |
| Process instance key   | <INSTANCE_KEY>        |
| Seeded by run          | <DAGRUN_RUN_ID>       |
| AIO PID                | <AIO_PID>             |

## Health Endpoints

- Application: http://localhost:9600/actuator/health
- Elasticsearch: http://localhost:9200/\_cluster/health

## Verification Steps

1. Open Camunda Operate: http://localhost:8080/operate  
   Login: demo / demo
2. Navigate to **Process Instances** and search for process `dagrunner-verify-seed`.
3. Confirm the instance with key `<INSTANCE_KEY>` appears and has reached end state.
4. (Optional) Open **Elasticsearch** index: `GET http://localhost:9200/camunda-*/_search?q=*`
   and verify the process instance event appears.

## Notes

The cluster runs independently until `dagrun cleanup <DAGRUN_RUN_ID>`.
AIO logs: <DAGRUN_ARTIFACTS>/aio.log

## Additional Context on This Feature Branch

Summarise any relevant observations about how the feature branch changes interact with
the running application — anything that the human tester should look for beyond the
baseline seeded-instance check.
```

Substitute all `<PLACEHOLDER>` values with the actual values from the steps above.

If any step fails after retries, write `$DAGRUN_ARTIFACTS/manual-test.md` with a FAILURE section
explaining exactly what was tried and what failed, so the Gate 3 reviewer has full context.
The node must not silently succeed — a partial manual-test.md with a clear failure diagnosis
is better than no file.
