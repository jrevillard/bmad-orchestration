#!/usr/bin/env bash
# write-state.sh — atomic coupled state.json + deps.json writer.
# Usage: write-state.sh <runDir> <state-json-content-file> <deps-json-content-file>
#   where <state-json-content-file> and <deps-json-content-file> are paths to
#   pre-rendered JSON files (workflow script can't write them itself).
set -euo pipefail
RUN="$1"
STATE_SRC="$2"
DEPS_SRC="$3"
[ -f "$STATE_SRC" ] || { echo "{\"error\":\"state source missing: $STATE_SRC\"}" >&2; exit 2; }
[ -f "$DEPS_SRC" ] || { echo "{\"error\":\"deps source missing: $DEPS_SRC\"}" >&2; exit 2; }
mkdir -p "$RUN"
cp "$STATE_SRC" "$RUN/state.json.tmp" && mv "$RUN/state.json.tmp" "$RUN/state.json"
cp "$DEPS_SRC" "$RUN/deps.json.tmp" && mv "$RUN/deps.json.tmp" "$RUN/deps.json"
uv run python -c "import json; json.load(open('$RUN/state.json')); json.load(open('$RUN/deps.json'))" \
  || { echo '{"error":"post-write JSON validation failed"}' >&2; exit 3; }
echo "{\"written\":true,\"paths\":[\"$RUN/state.json\",\"$RUN/deps.json\"]}"
