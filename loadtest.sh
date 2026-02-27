#!/usr/bin/env bash
# ezbase realtime load test
# Hammers a collection with creates, updates, and deletes to stress-test the SSE console.
# Usage: ./loadtest.sh [docs_per_wave] [waves]
#   docs_per_wave: how many docs to create per wave (default: 20)
#   waves:         how many create→update→delete cycles (default: 5)

set -eo pipefail

API="http://localhost:7003/api"
COL="loadtest"
DOCS_PER_WAVE="${1:-20}"
WAVES="${2:-5}"

ts() { python3 -c "import time; print(int(time.time()*1000))"; }

echo "=== ezbase load test ==="
echo "collection:    $COL"
echo "docs per wave: $DOCS_PER_WAVE"
echo "waves:         $WAVES"
echo ""

# Clean slate
echo "[cleanup] deleting existing $COL docs..."
curl -s "$API/collections/$COL" \
  | python3 -c "import sys,json; [print(d['id']) for d in json.load(sys.stdin)]" 2>/dev/null \
  | while read -r id; do
      curl -s -X DELETE "$API/collections/$COL/$id" -o /dev/null &
    done
wait
echo "[cleanup] done"
echo ""

for wave in $(seq 1 "$WAVES"); do
  echo "── wave $wave/$WAVES ──────────────────────────"

  # CREATE: fire off all creates in parallel, collect IDs
  idfile=$(mktemp)
  echo "[create] spawning $DOCS_PER_WAVE docs..."
  for i in $(seq 1 "$DOCS_PER_WAVE"); do
    (
      resp=$(curl -s -X POST "$API/collections/$COL" \
        -H 'Content-Type: application/json' \
        -d "{\"wave\":$wave,\"index\":$i,\"tag\":\"created\",\"ts\":$(ts)}")
      echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null >> "$idfile"
    ) &
  done
  wait

  ids=()
  while IFS= read -r line; do ids+=("$line"); done < "$idfile"
  rm -f "$idfile"
  echo "[create] done — ${#ids[@]} docs created"

  if [ ${#ids[@]} -eq 0 ]; then
    echo "[skip]   no docs to update/delete, skipping rest of wave"
    echo ""
    continue
  fi

  # UPDATE: patch every doc in parallel
  echo "[update] patching all ${#ids[@]} docs..."
  for id in "${ids[@]}"; do
    curl -s -X PATCH "$API/collections/$COL/$id" \
      -H 'Content-Type: application/json' \
      -d "{\"tag\":\"updated\",\"wave_update\":$wave,\"ts\":$(ts)}" \
      -o /dev/null &
  done
  wait
  echo "[update] done"

  # RAPID-FIRE UPDATES: hit a few docs repeatedly
  rapid_targets=("${ids[@]:0:3}")
  echo "[rapid]  10 rapid updates on ${#rapid_targets[@]} docs..."
  for _ in $(seq 1 10); do
    for id in "${rapid_targets[@]}"; do
      curl -s -X PATCH "$API/collections/$COL/$id" \
        -H 'Content-Type: application/json' \
        -d "{\"rapid\":true,\"counter\":$RANDOM,\"ts\":$(ts)}" \
        -o /dev/null &
    done
  done
  wait
  echo "[rapid]  done"

  # DELETE: remove half the docs in parallel
  half=$(( ${#ids[@]} / 2 ))
  echo "[delete] removing $half docs..."
  for id in "${ids[@]:0:$half}"; do
    curl -s -X DELETE "$API/collections/$COL/$id" -o /dev/null &
  done
  wait
  echo "[delete] done"

  echo ""
done

# Final stats
count=$(curl -s "$API/collections/$COL" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "=== done ==="
echo "remaining docs in '$COL': $count"
echo "open http://localhost:7003/console/ and click '$COL' to watch"
