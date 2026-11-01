#!/usr/bin/env bash
# Runs scripts/cloud_sync_e2e.ts against a throwaway local PostgreSQL that has
# the real supabase/cloud-store/001_erp_store.sql applied. Needs: bun + the
# PostgreSQL server binaries (e.g. /usr/lib/postgresql/16/bin).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54330}"
DIR="$(mktemp -d /tmp/erp_e2e_pg.XXXXXX)"
chmod 755 "$DIR"
USER_ID="11111111-1111-1111-1111-111111111111"

as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$DIR"
cleanup() { as_pg "$PGBIN/pg_ctl -D '$DIR/data' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

as_pg "$PGBIN/initdb -D '$DIR/data' -A trust -U postgres" >/dev/null
as_pg "$PGBIN/pg_ctl -D '$DIR/data' -o '-p $PORT -k $DIR -c listen_addresses=127.0.0.1' -w -l '$DIR/log' start" >/dev/null

PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "create database erp_e2e" >/dev/null
"${PSQL[@]}" -d erp_e2e -f "$ROOT/supabase/cloud-store/tests/00_shim_supabase.sql" >/dev/null
"${PSQL[@]}" -d erp_e2e -f "$ROOT/supabase/cloud-store/001_erp_store.sql" >/dev/null 2>&1
"${PSQL[@]}" -d erp_e2e -c "insert into auth.users values ('$USER_ID','e2e@example.test'); insert into public.erp_members(user_id, note) values ('$USER_ID','e2e');" >/dev/null

cd "$ROOT"
ERP_TEST_PG_URL="postgres://postgres@127.0.0.1:$PORT/erp_e2e" ERP_TEST_USER_ID="$USER_ID" bun scripts/cloud_sync_e2e.ts
