#!/usr/bin/env bash
# orchestrate-helper.sh — grouped state helpers for bmad-prd-orchestrate.
#
# Reads sprint-status + returns both current story status and every dep status
# in one call. Replaces 2 separate general-purpose agents (read-status +
# dep-check) with 1 bash invocation, halving system-prompt overhead per
# loop iteration.
#
# Subcommand:
#   all-read  <sprintStatusPath> <storyKey> <comma-deps>
#     → {"currentStatus": "<status>", "depStatuses": {"<dep>": "<status>", ...}}
#
# Usage from workflow script:
#   await agent("Run bash ${prdWorktreePath}/.claude/scripts/orchestrate-helper.sh all-read ARGS",
#     { schema: {...}, agentType: 'general-purpose' })
#
# Exit codes: 0 success, 1 bad args, 2 file not found.

set -euo pipefail

cmd="${1:-}"

case "$cmd" in
  all-read)
    [ $# -eq 4 ] || { echo "usage: all-read <sprintStatusPath> <storyKey> <comma-deps>" >&2; exit 1; }
    SP="$2"; SK="$3"; DEPS_CSV="$4"
    [ -f "$SP" ] || { echo "{\"error\":\"sprintStatus not found: $SP\"}" >&2; exit 2; }
    uv run python - "$SP" "$SK" "$DEPS_CSV" <<'PYEOF'
import sys, json, re
sp, sk, deps_csv = sys.argv[1], sys.argv[2], sys.argv[3]
deps = [d for d in deps_csv.split(',') if d]
content = open(sp).read()

def get_status(key):
    # development_status[<key>]: <status>
    m = re.search(r'^\s*' + re.escape(key) + r':\s*(\S+)\s*$', content, re.MULTILINE)
    return m.group(1) if m else 'missing'

current = get_status(sk)
out = {"currentStatus": current, "depStatuses": {d: get_status(d) for d in deps}}
print(json.dumps(out))
PYEOF
    ;;

  *)
    echo "usage: $0 all-read <sprintStatusPath> <storyKey> <comma-deps>" >&2
    exit 1
    ;;
esac
