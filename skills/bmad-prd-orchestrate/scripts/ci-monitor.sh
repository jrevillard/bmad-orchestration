#!/usr/bin/env bash
# Wait for a GitLab pipeline to reach terminal state.
# Usage: ci-monitor.sh <pipeline_id> [poll_seconds]
# Env: GITLAB_HOST (default opensource.unicc.org), GITLAB_PROJECT_ID (default 90)
#
# Token resolution: $GITLAB_TOKEN > glab config > error

set -u

PID="${1:-}"
POLL="${2:-30}"
HOST="${GITLAB_HOST:-opensource.unicc.org}"
PROJ="${GITLAB_PROJECT_ID:-90}"

if [[ -z "$PID" ]]; then
  echo "Usage: $0 <pipeline_id> [poll_seconds]" >&2
  exit 2
fi

TOKEN="${GITLAB_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$HOME/.config/glab-cli/config.yml" ]]; then
  TOKEN=$(uv run python -c "
import sys, yaml
try:
    d = yaml.safe_load(open('$HOME/.config/glab-cli/config.yml'))
    print(d.get('hosts', {}).get('$HOST', {}).get('token', '') or '')
except Exception:
    print('')
" 2>/dev/null)
fi

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: no token (set GITLAB_TOKEN or login via glab)" >&2
  exit 2
fi

URL="https://$HOST/api/v4/projects/$PROJ/pipelines/$PID"

# Pre-flight: confirm pipeline exists
HTTP=$(curl -sk -o /tmp/ci-monitor-resp.json -w "%{http_code}" \
  -H "PRIVATE-TOKEN: $TOKEN" -H "Accept: application/json" "$URL")
if [[ "$HTTP" != "200" ]]; then
  echo "ERROR: pipeline $PID not accessible (HTTP $HTTP)" >&2
  cat /tmp/ci-monitor-resp.json >&2
  exit 3
fi

echo "$(date +%H:%M:%S) watching pipeline #$PID on $HOST (poll=${POLL}s)"

while true; do
  RAW=$(curl -sk -w "\n%{http_code}" \
    -H "PRIVATE-TOKEN: $TOKEN" -H "Accept: application/json" "$URL")
  HTTP=$(echo "$RAW" | tail -1)
  BODY=$(echo "$RAW" | sed '$d')

  if [[ "$HTTP" != "200" ]]; then
    echo "$(date +%H:%M:%S) WARN: HTTP $HTTP — sleeping"
    sleep "$POLL"
    continue
  fi

  STATUS=$(echo "$BODY" | uv run python -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
  echo "$(date +%H:%M:%S) status=$STATUS"

  case "$STATUS" in
    success|failed|canceled|skipped)
      echo "TERMINAL:$STATUS"
      exit 0
      ;;
    *) sleep "$POLL" ;;
  esac
done
