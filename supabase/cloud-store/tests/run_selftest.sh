#!/usr/bin/env bash
# Runs the cloud-store SQL self-test on a throwaway local PostgreSQL.
# Needs the PostgreSQL server binaries (e.g. /usr/lib/postgresql/16/bin) and to
# be able to start them (root is fine: the server is started as the postgres user).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54329}"
DIR="$(mktemp -d /tmp/erp_store_pg.XXXXXX)"
chmod 755 "$DIR"

run_pg_user() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$DIR"

cleanup() { run_pg_user "$PGBIN/pg_ctl -D '$DIR/data' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

run_pg_user "$PGBIN/initdb -D '$DIR/data' -A trust -U postgres" >/dev/null
run_pg_user "$PGBIN/pg_ctl -D '$DIR/data' -o '-p $PORT -k $DIR -c listen_addresses=' -w -l '$DIR/log' start" >/dev/null

PSQL=(psql -h "$DIR" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "create database erp_test" >/dev/null
for f in "$HERE/00_shim_supabase.sql" "$HERE/../001_erp_store.sql"; do
  "${PSQL[@]}" -d erp_test -f "$f" >/dev/null
done

echo "--- running self-test"
"${PSQL[@]}" -d erp_test -f "$HERE/erp_store_selftest.sql" 2>&1 | grep -E "^(psql:|ERROR|FAILED|NOTICE:  ok|ALL PASSED)" | sed 's/^NOTICE:  //'

echo "--- re-applying the migration (must be idempotent)"
"${PSQL[@]}" -d erp_test -f "$HERE/../001_erp_store.sql" >/dev/null && echo "idempotent: ok"
echo "--- rollback script"
"${PSQL[@]}" -d erp_test -f "$HERE/../002_erp_store_down.sql" >/dev/null && echo "rollback: ok"

echo "--- upgrading a database that already had members (pre-role, pre-status schema)"
"${PSQL[@]}" -d postgres -c "create database erp_legacy" >/dev/null
"${PSQL[@]}" -d erp_legacy -f "$HERE/00_shim_supabase.sql" >/dev/null
"${PSQL[@]}" -d erp_legacy -c "
  insert into auth.users values ('99999999-9999-9999-9999-999999999999','old@example.test');
  create table public.erp_members (user_id uuid primary key references auth.users(id) on delete cascade, note text, added_at timestamptz not null default now());
  insert into public.erp_members (user_id, note) values ('99999999-9999-9999-9999-999999999999','pre-existing');" >/dev/null
"${PSQL[@]}" -d erp_legacy -f "$HERE/../001_erp_store.sql" >/dev/null 2>&1
"${PSQL[@]}" -d erp_legacy -tA -c "select case when status='approved' and role='admin' then 'ok  - an existing member keeps access after the upgrade (approved + admin)' else 'FAILED: legacy member is '||status||'/'||coalesce(role,'null') end from public.erp_members" | tee /dev/stderr | grep -q '^ok' || exit 1
