#!/bin/zsh
set -euo pipefail

COUNT=$(jq '.new_or_edited | length' /tmp/pr-triage-tick.json)

if [ "$COUNT" = "0" ]; then
  jq '. + {"noop": true}' /tmp/pr-triage-tick.json > /tmp/pr-triage-tick-tmp.json
  mv /tmp/pr-triage-tick-tmp.json /tmp/pr-triage-tick.json
  echo "No new or edited comments — tick is a no-op. Nothing to triage."
  exit 0
fi

echo "Found ${COUNT} new/edited comment(s) to triage."
jq '. + {"noop": false}' /tmp/pr-triage-tick.json > /tmp/pr-triage-tick-tmp.json
mv /tmp/pr-triage-tick-tmp.json /tmp/pr-triage-tick.json
