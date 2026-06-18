#!/usr/bin/env bash
# stop-schema.sh — Stop hook (no-op).
# classify node removed in Phase 2a; task-type routing will be designed fresh when needed.

# Consume stdin (hook event) so the process doesn't hang.
read -r -d '' _HOOK_EVENT <&0 2>/dev/null || true

exit 0
