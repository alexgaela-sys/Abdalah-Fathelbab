#!/usr/bin/env bash
# Validate the Supabase migration set on a THROWAWAY local database.
#
# Proves that the migrations parse, that they re-apply cleanly (idempotency)
# and that the accounting/inventory guards actually fire. It does NOT prove
# anything about the hosted TEST project: auth.users, the real JWT claims, the
# deployed RPC bodies and the existing ERP rows only exist there.
#
# It never contacts Supabase and drops the scratch database at the end.
#
# Usage:  bash scripts/validate_supabase_migrations.sh
# Prereq: a reachable local PostgreSQL (psql in PATH).

set -euo pipefail

DB_NAME="${DB_NAME:-erp_migration_validate}"
PSQL="${PSQL:-psql}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

run_db() { "$PSQL" -v ON_ERROR_STOP=1 -q -d "$DB_NAME" "$@"; }

cleanup() { "$PSQL" -q -d postgres -c "drop database if exists $DB_NAME;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== creating scratch database $DB_NAME"
"$PSQL" -q -d postgres -c "drop database if exists $DB_NAME;" >/dev/null
"$PSQL" -q -d postgres -c "create database $DB_NAME;" >/dev/null

echo "== applying local auth shim (never applied to a hosted project)"
run_db -f "$ROOT/supabase/tests/shim_supabase_auth.sql"

echo "== applying migrations in order"
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  printf '   - %s\n' "$(basename "$f")"
  run_db -f "$f"
done

echo "== re-applying every migration (idempotency)"
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  run_db -f "$f" 2>/dev/null
done

echo "== running the accounting/inventory guard self-test"
run_db -f "$ROOT/supabase/tests/accounting_guards_selftest.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /   /'

echo "OK: migrations apply, re-apply, and every guard rejects what it must reject."
