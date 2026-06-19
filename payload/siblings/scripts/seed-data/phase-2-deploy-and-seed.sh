#!/bin/zsh
# This is one contiguous block — all deployment/instance state lives in shell variables
# across the full loop. Do not split it.
set -euo pipefail

STATE_FILE="${TMPDIR%/}/seed-data-state.json"
SPEC_PATH=$(jq -r .spec_path "$STATE_FILE")
PROFILE=$(jq -r .profile "$STATE_FILE")
SEED_SCRATCH=$(jq -r .seed_scratch "$STATE_FILE")
SPEC=$(cat "$SPEC_PATH")
WORKTREE="${DAGRUN_WORKTREE:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

DEPLOY_COUNT=$(echo "$SPEC" | jq '.deployments | length')
INSTANCE_COUNT=$(echo "$SPEC" | jq '.instances | length')
echo "Deployments to process: $DEPLOY_COUNT"
echo "Instances to start:     $INSTANCE_COUNT"

DEPLOY_RECORDS_FILE="${TMPDIR%/}/seed-data-deploy-records.json"
INSTANCE_RECORDS_FILE="${TMPDIR%/}/seed-data-instance-records.json"
OBS_RECORDS_FILE="${TMPDIR%/}/seed-data-obs-records.json"
echo "[]" > "$DEPLOY_RECORDS_FILE"
echo "[]" > "$INSTANCE_RECORDS_FILE"
echo "[]" > "$OBS_RECORDS_FILE"

# --- Resolve and deploy BPMN resources ---

i=0
while [ "$i" -lt "$DEPLOY_COUNT" ]; do
  DESCRIPTION=$(echo "$SPEC" | jq -r ".deployments[$i].description")
  WHY=$(echo "$SPEC" | jq -r ".deployments[$i].why")
  BPMN_RESOURCE=$(echo "$SPEC" | jq -r ".deployments[$i].bpmn_resource // empty")

  if [ -n "$BPMN_RESOURCE" ]; then
    PROCESS_ID=$(basename "$BPMN_RESOURCE" .bpmn)
  else
    PROCESS_ID=$(echo "$SPEC" | jq -r "[.instances[].process_id] | unique | .[$i] // .[0]")
  fi

  echo ""
  echo "--- Deployment $((i+1))/$DEPLOY_COUNT: process_id='$PROCESS_ID' ---"
  echo "Description: $DESCRIPTION"
  echo "Why:         $WHY"

  BPMN_PATH=""

  if [ -n "$BPMN_RESOURCE" ]; then
    # Expand tilde if present
    BPMN_RESOURCE="${BPMN_RESOURCE/#\~/$HOME}"
    if [ -f "$BPMN_RESOURCE" ]; then
      BPMN_PATH="$BPMN_RESOURCE"
      echo "Using bpmn_resource: $BPMN_PATH"
    else
      echo "NOTE: bpmn_resource '$BPMN_RESOURCE' not found — falling back to worktree search."
    fi
  fi

  if [ -z "$BPMN_PATH" ]; then
    TASK_FREE=$(grep -rl "id=\"${PROCESS_ID}\"" "$WORKTREE" --include="*.bpmn" \
                 | grep -v "/target/" | grep -v "/node_modules/" \
                 | while read -r f; do
                     grep -qE "serviceTask|ServiceTask|userTask|UserTask" "$f" || echo "$f"
                   done | head -1 || true)
    if [ -n "$TASK_FREE" ]; then
      BPMN_PATH="$TASK_FREE"
      echo "Found task-free fixture (start→end, completes immediately): $BPMN_PATH"
    else
      NO_SVC=$(grep -rl "id=\"${PROCESS_ID}\"" "$WORKTREE" --include="*.bpmn" \
                | grep -v "/target/" | grep -v "/node_modules/" \
                | while read -r f; do
                    grep -q "serviceTask\|ServiceTask" "$f" || echo "$f"
                  done | head -1 || true)
      if [ -n "$NO_SVC" ]; then
        BPMN_PATH="$NO_SVC"
        echo "Found no-service-task fixture (may have user task — instance stays ACTIVE): $BPMN_PATH"
      else
        ANY=$(grep -rl "id=\"${PROCESS_ID}\"" "$WORKTREE" --include="*.bpmn" \
               | grep -v "/target/" | grep -v "/node_modules/" | head -1 || true)
        if [ -n "$ANY" ]; then
          BPMN_PATH="$ANY"
          echo "Found fixture (has service/user task — instance may not complete): $BPMN_PATH"
        fi
      fi
    fi
  fi

  if [ -z "$BPMN_PATH" ]; then
    GEN_PATH="$SEED_SCRATCH/generated/${PROCESS_ID}.bpmn"
    echo "No fixture found — generating BPMN with service task (instance stays ACTIVATABLE): $GEN_PATH"
    cat > "$GEN_PATH" << BPMN_END
<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
                  id="Definitions_seed_${PROCESS_ID}"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="${PROCESS_ID}" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" name="Start">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="Task_1" name="Work">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="${PROCESS_ID}" />
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="EndEvent_1" name="End">
      <bpmn:incoming>Flow_2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="EndEvent_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${PROCESS_ID}">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="152" y="82" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_1_di" bpmnElement="Task_1">
        <dc:Bounds x="240" y="60" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1">
        <dc:Bounds x="392" y="82" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="188" y="100" />
        <di:waypoint x="240" y="100" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2">
        <di:waypoint x="340" y="100" />
        <di:waypoint x="392" y="100" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
BPMN_END
    BPMN_PATH="$GEN_PATH"
  fi

  echo "Deploying $BPMN_PATH..."
  DEPLOY_RESULT=$(c8ctl deploy "$BPMN_PATH" --profile "$PROFILE" --json 2>&1)

  # c8ctl outputs mixed NDJSON lines + a final JSON array; check for error line first
  if echo "$DEPLOY_RESULT" | grep -q '"status":"error"'; then
    echo ""
    echo "ERROR: Deploy failed for $BPMN_PATH"
    echo "$DEPLOY_RESULT" | grep '"status":"error"' | jq -r '.message // .' 2>/dev/null || echo "$DEPLOY_RESULT"
    exit 1
  fi

  # Extract deployment key from the success NDJSON line
  DEPLOY_KEY=$(echo "$DEPLOY_RESULT" | grep '"status":"success"' | jq -r '.key // "unknown"' 2>/dev/null || echo "unknown")
  # Extract definition key from the trailing JSON array (c8ctl format: [{File, Type, ID, Version, Key}])
  DEF_KEY=$(printf '%s' "$DEPLOY_RESULT" | awk '/^\[/{found=1} found{print}' | jq -r '.[0].Key // "unknown"' 2>/dev/null || echo "unknown")
  echo "Deployed. deployment_key=$DEPLOY_KEY  process_definition_key=$DEF_KEY"

  RECORD=$(jq -n \
    --arg pid "$PROCESS_ID" \
    --arg dk "$DEPLOY_KEY" \
    --arg defk "$DEF_KEY" \
    --arg bpmn "$BPMN_PATH" \
    '{"process_id":$pid,"deployment_key":$dk,"process_definition_key":$defk,"bpmn_path":$bpmn}')
  DEPLOY_TMP="${TMPDIR%/}/seed-data-deploy-records-tmp.json"
  jq --argjson r "$RECORD" '. + [$r]' "$DEPLOY_RECORDS_FILE" > "$DEPLOY_TMP"
  mv "$DEPLOY_TMP" "$DEPLOY_RECORDS_FILE"

  i=$((i + 1))
done

# --- Start process instances ---

j=0
while [ "$j" -lt "$INSTANCE_COUNT" ]; do
  PROCESS_ID=$(echo "$SPEC" | jq -r ".instances[$j].process_id")
  VARIABLES=$(echo "$SPEC" | jq -c ".instances[$j].variables // {}")
  WHY=$(echo "$SPEC" | jq -r ".instances[$j].why")

  echo ""
  echo "--- Instance $((j+1))/$INSTANCE_COUNT: process_id='$PROCESS_ID' ---"
  echo "Variables: $VARIABLES"
  echo "Why:       $WHY"

  PI_RESULT=$(c8ctl create pi \
    --id "$PROCESS_ID" \
    --variables "$VARIABLES" \
    --profile "$PROFILE" \
    --json 2>&1)

  if echo "$PI_RESULT" | jq -e 'select(.status == "error")' > /dev/null 2>&1; then
    echo ""
    echo "ERROR: Failed to start process instance for '$PROCESS_ID'"
    echo "$PI_RESULT" | jq -r '.message // .'
    exit 1
  fi

  PI_KEY=$(echo "$PI_RESULT" | jq -r '.processInstanceKey // .key // "unknown"' 2>/dev/null)
  if [ "$PI_KEY" = "null" ] || [ -z "$PI_KEY" ]; then
    echo "WARNING: Could not extract instance key. Raw response:"
    echo "$PI_RESULT"
    PI_KEY="unknown"
  fi
  echo "Started. processInstanceKey=$PI_KEY"

  RECORD=$(jq -n \
    --arg pid "$PROCESS_ID" \
    --arg k "$PI_KEY" \
    '{"process_id":$pid,"instance_key":$k}')
  INSTANCE_TMP="${TMPDIR%/}/seed-data-instance-records-tmp.json"
  jq --argjson r "$RECORD" '. + [$r]' "$INSTANCE_RECORDS_FILE" > "$INSTANCE_TMP"
  mv "$INSTANCE_TMP" "$INSTANCE_RECORDS_FILE"

  j=$((j + 1))
done

# --- Discover Elasticsearch endpoint ---

ES_URL="http://localhost:9200"
if [ -d "$WORKTREE/.c8dev/envs" ]; then
  for compose in "$WORKTREE"/.c8dev/envs/*/docker-compose.yml; do
    [ -f "$compose" ] || continue
    port=$(grep -o '"[0-9]*:9200"' "$compose" 2>/dev/null | head -1 | tr -d '"' | cut -d: -f1)
    if [ -n "$port" ]; then
      ES_URL="http://localhost:$port"
      break
    fi
  done
fi
echo ""
echo "Elasticsearch endpoint: $ES_URL"

ES_REACHABLE=false
ES_CHECK=$(curl -s --connect-timeout 5 "$ES_URL/_cluster/health" 2>&1)
if echo "$ES_CHECK" | jq -e '.status' > /dev/null 2>&1; then
  echo "ES reachable (cluster status: $(echo "$ES_CHECK" | jq -r '.status'))"
  ES_REACHABLE=true
else
  echo "WARNING: Elasticsearch not reachable at $ES_URL"
  echo "ES observation checks will be skipped."
fi

# --- Confirm expected observations ---

FIRST_INSTANCE_KEY=$(jq -r '.[0].instance_key // "unknown"' "$INSTANCE_RECORDS_FILE")
FIRST_PROCESS_ID=$(jq -r '.[0].process_id // ""' "$INSTANCE_RECORDS_FILE")
OBS_COUNT=$(echo "$SPEC" | jq '.expected_observations | length')
PROFILE_URL=$(c8ctl list profiles --json 2>/dev/null | jq -r --arg p "$PROFILE" '.[] | select(.Name == $p) | .URL' 2>/dev/null | head -1 || echo "")
BASE_URL="${PROFILE_URL%/v2}"

k=0
while [ "$k" -lt "$OBS_COUNT" ]; do
  WHERE=$(echo "$SPEC" | jq -r ".expected_observations[$k].where")
  WHAT=$(echo "$SPEC" | jq -r ".expected_observations[$k].what")
  EXPECTED=$(echo "$SPEC" | jq -r ".expected_observations[$k].expected_value")

  echo ""
  echo "--- Observation $((k+1))/$OBS_COUNT: where=$WHERE ---"
  echo "What:           $WHAT"
  echo "Expected value: $EXPECTED"

  if [ "$WHERE" = "elasticsearch" ]; then
    if [ "$ES_REACHABLE" != "true" ]; then
      OBS_REC=$(jq -n --arg w "$WHERE" --arg wh "$WHAT" \
        '{"where":$w,"status":"SKIPPED","reason":"ES not reachable","what":$wh}')
      echo "SKIPPED: ES not reachable."
    else
      TIMEOUT_S=90
      INTERVAL_S=5
      ELAPSED=0
      CONFIRMED=false

      echo "Polling ES for instance key $FIRST_INSTANCE_KEY (timeout ${TIMEOUT_S}s)..."
      while [ "$ELAPSED" -lt "$TIMEOUT_S" ]; do
        if [ -n "$FIRST_INSTANCE_KEY" ] && [ "$FIRST_INSTANCE_KEY" != "unknown" ]; then
          ES_RESP=$(curl -s "$ES_URL/operate-list-view*/_search" \
            -H 'Content-Type: application/json' \
            -d "{\"query\":{\"term\":{\"key\":$FIRST_INSTANCE_KEY}},\"size\":1}" 2>&1)
        else
          ES_RESP=$(curl -s "$ES_URL/operate-list-view*/_search" \
            -H 'Content-Type: application/json' \
            -d "{\"query\":{\"term\":{\"bpmnProcessId\":\"$FIRST_PROCESS_ID\"}},\"size\":1}" 2>&1)
        fi
        HIT_COUNT=$(echo "$ES_RESP" | jq -r '.hits.total.value // 0' 2>/dev/null)
        if [ "${HIT_COUNT:-0}" -gt "0" ]; then
          CONFIRMED=true
          echo "ES observation confirmed after ${ELAPSED}s ($HIT_COUNT document(s))."
          break
        fi
        sleep "$INTERVAL_S"
        ELAPSED=$((ELAPSED + INTERVAL_S))
      done

      if [ "$CONFIRMED" = "true" ]; then
        OBS_REC=$(jq -n \
          --arg w "$WHERE" --arg wh "$WHAT" --argjson e "$ELAPSED" \
          '{"where":$w,"status":"CONFIRMED","waitSeconds":$e,"what":$wh}')
      else
        echo ""
        echo "WARNING: ES export not confirmed after ${TIMEOUT_S}s. Check manually:"
        echo "  curl '$ES_URL/operate-list-view*/_search?q=key:${FIRST_INSTANCE_KEY}'"
        echo ""
        echo "Available list-view indices (to rule out an index-name mismatch):"
        curl -s "$ES_URL/_cat/indices/*list-view*?h=index" 2>/dev/null || echo "  (none found — check index naming)"
        OBS_REC=$(jq -n \
          --arg w "$WHERE" --arg wh "$WHAT" --argjson e "$ELAPSED" \
          --arg warn "export lag exceeded timeout" \
          '{"where":$w,"status":"UNCONFIRMED","waitSeconds":$e,"what":$wh,"warn":$warn}')
      fi
    fi

  elif [ "$WHERE" = "rest-api" ]; then
    OBS_REC=$(jq -n \
      --arg w "$WHERE" --arg wh "$WHAT" --arg ev "$EXPECTED" \
      --arg base "${BASE_URL:-http://localhost:8080}" \
      '{"where":$w,"status":"RECORDED","what":$wh,"expected_value":$ev,
        "ready_to_run":{"base_url":$base,"note":"Use Postman — see postman-collection.json","what":$wh}}')
    echo "REST observation recorded (see postman-collection.json)."
    echo "Base URL: ${BASE_URL:-http://localhost:8080}"

  elif [ "$WHERE" = "operate" ]; then
    OBS_REC=$(jq -n \
      --arg w "$WHERE" --arg wh "$WHAT" \
      '{"where":$w,"status":"SKIPPED","reason":"UI observation — use rest-api or elasticsearch instead","what":$wh}')
    echo "NOTE: 'operate' observation skipped — testing uses REST API (Postman) and Elasticsearch (ElasticVue), not Operate UI."
    echo "Convert to a rest-api or elasticsearch observation in the seeding-spec.json for future runs."

  else
    OBS_REC=$(jq -n \
      --arg w "$WHERE" --arg wh "$WHAT" \
      '{"where":$w,"status":"NOT_CHECKED","reason":"observation type not handled","what":$wh}')
    echo "NOTE: '$WHERE' observations are not checked by seed-data. Review manually."
  fi

  OBS_TMP="${TMPDIR%/}/seed-data-obs-records-tmp.json"
  jq --argjson r "$OBS_REC" '. + [$r]' "$OBS_RECORDS_FILE" > "$OBS_TMP"
  mv "$OBS_TMP" "$OBS_RECORDS_FILE"

  k=$((k + 1))
done

# --- Write seeded.json to run artifacts dir ---

SEEDED_JSON=$(jq -n \
  --arg spec "$SPEC_PATH" \
  --arg profile "$PROFILE" \
  --arg seed_scratch "$SEED_SCRATCH" \
  --argjson deployments "$(cat "$DEPLOY_RECORDS_FILE")" \
  --argjson instances "$(cat "$INSTANCE_RECORDS_FILE")" \
  --argjson observations "$(cat "$OBS_RECORDS_FILE")" \
  '{seeding_spec:$spec, profile:$profile, seed_scratch:$seed_scratch, deployments:$deployments, instances:$instances, observations:$observations}')

echo "$SEEDED_JSON" > "$SEED_SCRATCH/seeded.json"
echo ""
echo "Wrote $SEED_SCRATCH/seeded.json"
echo "$SEEDED_JSON" | jq .

rm -f "$DEPLOY_RECORDS_FILE" "$INSTANCE_RECORDS_FILE" "$OBS_RECORDS_FILE"
# Note: state file is deleted by phase-3
