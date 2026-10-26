#!/usr/bin/env bash
# Boot the latest published release with data shaped like what broke real upgrades,
# then boot the new image on the same volume and require that nothing changed.
#
#   .github/upgrade-check.sh [new-image] [previous-image]
set -Eeuo pipefail

NEW=${1:-ezbase:ci}
OLD=${2:-ghcr.io/ezwrld/ezbase:latest}
KEY=upgrade-check
PORT=7390
URL=http://127.0.0.1:$PORT/api
VOLUME=ezbase-upgrade-check
NAME=ezbase-upgrade-check
H="Authorization: Bearer $KEY"

cleanup() {
  docker rm -f "$NAME" "$NAME-restore" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" "$VOLUME-restore" >/dev/null 2>&1 || true
  if [[ -n ${TMP:-} ]]; then rm -rf "$TMP"; fi
}
cleanup
TMP=$(mktemp -d)
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; docker logs "$NAME" 2>&1 | tail -40 >&2 || true; exit 1; }
check() { printf '  ok  %s\n' "$*"; }

boot() { # boot <image> [container] [volume] [port]
  local image=$1 name=${2:-$NAME} volume=${3:-$VOLUME} port=${4:-$PORT}
  docker run -d --name "$name" -p "127.0.0.1:$port:7003" -e ADMIN_KEY=$KEY -e EZBASE_URL=http://127.0.0.1:$port \
    -v "$volume:/data" "$image" >/dev/null
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && return
    sleep 1
  done
  fail "$image did not become healthy"
}

count() { curl -s -H "$H" "$URL/collections/$1/stats" | jq -r .count; }
rows() { curl -s -H "$H" "$URL/collections/$1${2:-}" | jq 'if type == "array" then length else .error end'; }

docker pull -q "$OLD" >/dev/null
printf 'Seeding %s\n' "$OLD"
boot "$OLD"
OLD_VERSION=$(curl -s "$URL/health" | jq -r .version)

# The first write creates each table; bulk rows go straight into it.
for c in bookingFormVisits events; do
  id=$(curl -sf -X POST -H "$H" -H 'Content-Type: application/json' -d '{}' "$URL/collections/$c" | jq -r .id)
  curl -sf -X DELETE -H "$H" "$URL/collections/$c/$id" >/dev/null
done
docker exec -i "$NAME" su postgres -c 'psql -q -v ON_ERROR_STOP=1 -d ezbase' <<'SQL'
INSERT INTO db_default."col_bookingFormVisits" (id, data, created_at, updated_at)
  SELECT 'v' || g, jsonb_build_object('visitId', 'v' || g, 'step', g % 7, 'campus', CASE WHEN g % 2 = 0 THEN 'auburn' ELSE 'oxford' END),
         1790000000000 + g, 1790000000000 + g
  FROM generate_series(1, 250) g;
INSERT INTO db_default.col_events (id, data, created_at, updated_at)
  SELECT 'e' || g, jsonb_build_object('event', 'page_viewed', 'source', CASE WHEN g % 3 = 0 THEN 'landing' ELSE 'booking_form' END, 'n', g),
         1790000000000 + g, 1790000000000 + g
  FROM generate_series(1, 12500) g;
SQL

head -c 2200000 /dev/zero | tr '\0' 'x' | jq -Rs '{blob: ., kind: "snapshot"}' > "$TMP/big.json"
BIG=0
curl -sf -X PUT -H "$H" -H 'Content-Type: application/json' --data-binary @"$TMP/big.json" "$URL/collections/snapshots/big" >/dev/null && BIG=1
curl -sf -X PUT -H "$H" -H 'Content-Type: application/json' -d '{"kind":"small"}' "$URL/collections/snapshots/small" >/dev/null

USER_ID=$(curl -sf -X POST -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
  -d '{"email":"upgrade@check.test","password":"upgrade-check-pw","name":"upgrade"}' "$URL/auth/sign-up/email" | jq -r .user.id)
curl -sf -X PATCH -H "$H" -H 'Content-Type: application/json' -d '{"orgIds":["org-1"]}' "$URL/auth/users/$USER_ID/claims" >/dev/null

printf 'upgrade-check file\n' > "$TMP/file.txt"
curl -sf -X POST -H "$H" -F "file=@$TMP/file.txt" "$URL/storage/assets/check/file.txt" >/dev/null

BACKUP=$(curl -sf -X POST -H "$H" -H 'Content-Type: application/json' -d '{}' "$URL/backups" | jq -r .name)
docker exec "$NAME" cat "/data/files/.backups/$BACKUP" > "$TMP/old-backup.tar.gz"

for c in bookingFormVisits events snapshots; do printf -v "before_$c" '%s' "$(count "$c")"; done
before() { local v="before_$1"; printf '%s' "${!v}"; }
docker stop "$NAME" >/dev/null && docker rm "$NAME" >/dev/null

printf 'Upgrading %s → %s on the same volume\n' "$OLD_VERSION" "$NEW"
boot "$NEW"

for c in bookingFormVisits events snapshots; do
  [[ $(count "$c") == "$(before "$c")" ]] || fail "$c count $(count "$c") != $(before "$c") before upgrade"
done
check "document counts unchanged (bookingFormVisits $(before bookingFormVisits), events $(before events), snapshots $(before snapshots))"

[[ $(rows bookingFormVisits) == "$(before bookingFormVisits)" ]] || fail "admin list of bookingFormVisits: $(rows bookingFormVisits)"
check "capitalized collection lists in full"
[[ $(rows events) == "$(before events)" ]] || fail "admin list of events without limit: $(rows events)"
check "admin read without limit returns all $(before events) events"
[[ $(rows events '?limit=25') == 25 ]] || fail "limit=25 returned $(rows events '?limit=25')"
check "explicit limit honored"
W=$(jq -rn '[["source","==","landing"]] | @uri')
[[ $(rows events "?where=$W&limit=10000") == 4166 ]] || fail "filtered read: $(rows events "?where=$W&limit=10000")"
check "filtered read returns every match"
AGG=$(curl -s -X POST -H "$H" -H 'Content-Type: application/json' -d '{"groupBy":["campus"],"select":{"n":["count"]},"orderBy":"campus"}' "$URL/collections/bookingFormVisits/aggregate" | jq -c 'map(.n)')
[[ $AGG == '[125,125]' ]] || fail "aggregate on capitalized collection: $AGG"
check "aggregate on capitalized collection"

if [[ $BIG == 1 ]]; then
  [[ $(curl -s -H "$H" "$URL/collections/snapshots/big" | jq '.data.blob | length') == 2200000 ]] || fail "2.2 MB document unreadable"
  curl -sf -X PUT -H "$H" -H 'Content-Type: application/json' --data-binary @"$TMP/big.json" "$URL/collections/snapshots/big2" >/dev/null \
    || fail "new image rejected a 2.2 MB document the old one accepted"
  check "large documents read and write"
fi

TOKEN=$(curl -sf -X POST -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
  -d '{"email":"upgrade@check.test","password":"upgrade-check-pw"}' "$URL/auth/sign-in/email" | jq -r .token)
[[ $(curl -s -H "Authorization: Bearer $TOKEN" "$URL/auth/me" | jq -r '.claims.orgIds[0] // .user.claims.orgIds[0] // empty') == org-1 ]] \
  || fail "existing user cannot sign in with claims intact"
check "existing user signs in with claims"

[[ $(curl -sf -H "$H" "$URL/storage/assets/check/file.txt") == 'upgrade-check file' ]] || fail "stored file unreadable"
check "stored file readable"

for _ in $(seq 1 60); do
  docker exec "$NAME" ls /data/files/.backups 2>/dev/null | grep -q -- '-upgrade-' && break
  sleep 1
done
docker exec "$NAME" ls /data/files/.backups | grep -q -- '-upgrade-' || fail "no restore point written on upgrade"
check "restore point written on first boot"

boot "$NEW" "$NAME-restore" "$VOLUME-restore" $((PORT + 1))
RESTORE=$(curl -s -X POST -H "$H" -H 'Content-Type: application/gzip' --data-binary @"$TMP/old-backup.tar.gz" \
  "http://127.0.0.1:$((PORT + 1))/api/restore?options=%7B%7D")
for c in bookingFormVisits events snapshots; do
  got=$(jq -r ".documents[\"default/$c\"].restored // \"missing\"" <<<"$RESTORE")
  [[ $got == "$(before "$c")" ]] || fail "restore of $OLD_VERSION backup: $c restored $got, expected $(before "$c") ($RESTORE)"
done
check "backup taken by $OLD_VERSION restores on the new image"

printf 'Upgrade from %s passed\n' "$OLD_VERSION"
