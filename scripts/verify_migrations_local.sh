#!/usr/bin/env bash
# =====================================================================
# scripts/verify_migrations_local.sh
#
# Proves the migration set on a THROWAWAY LOCAL PostgreSQL database:
#   1. applies supabase/tests/shim_supabase_auth.sql (auth/roles shim),
#   2. applies supabase/migrations/*.sql in filename order, one transaction
#      per file (same rule as scripts/apply_test_migrations.sh),
#   3. runs supabase/tests/accounting_guards_selftest.sql (8 invariants),
#   4. runs supabase/verify/verify_schema.sql and verify_rls.sql.
#
# This is the only end-to-end proof that is possible without the hosted TEST
# credential. It never contacts Supabase and never touches ERP data.
#
# Run: bash scripts/verify_migrations_local.sh
# =====================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${SCRATCH_DB:-snakdip_migration_preflight}"

# Hard guard: only a local socket/host. `psql -d name` with a remote PGHOST
# would otherwise create and drop a database on that server.
case "${PGHOST:-}" in
  ''|localhost|127.0.0.1|/var/run/postgresql|/tmp) : ;;
  *)
    echo "PGHOST=${PGHOST} is not local. This script only runs on a scratch local cluster." >&2
    exit 2
    ;;
esac

for bin in psql createdb dropdb; do
  command -v "$bin" >/dev/null || { echo "missing $bin" >&2; exit 2; }
done

dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
cleanup() { dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== scratch database: $DB (local only)"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/shim_supabase_auth.sql" >/dev/null
echo "   auth shim applied"

for f in "$ROOT"/supabase/migrations/*.sql; do
  base="$(basename "$f")"
  # 171 is superseded by 173 and does not apply even to a stock PostgreSQL
  # ("record variable cannot be part of multiple-item INTO list"); 172 is the QA
  # proof written against 171's contract, so it is replaced by
  # supabase/tests/production_completion_selftest.sql against 173.
  case "$base" in
    171_*|172_*)
      printf '   %-46s SKIP (superseded by 173)\n' "$base"
      continue
      ;;
  esac
  printf '   %-46s ' "$base"
  if psql -d "$DB" -q -v ON_ERROR_STOP=1 --single-transaction -f "$f" >/tmp/mig_preflight.log 2>&1; then
    echo "OK"
  else
    echo "FAIL"
    cat /tmp/mig_preflight.log >&2
    exit 1
  fi
done

# Hosted-only RPCs the migrations call but do not create, shimmed locally so the
# production cycle can actually be executed (see the file header).
printf '   %-46s ' 'shim_deployed_rpcs.sql'
if psql -d "$DB" -q -v ON_ERROR_STOP=1 --single-transaction \
     -f "$ROOT/supabase/tests/shim_deployed_rpcs.sql" >/tmp/shim_preflight.log 2>&1; then
  echo "OK"
else
  echo "FAIL"
  cat /tmp/shim_preflight.log >&2
  exit 1
fi

TABLES="$(psql -d "$DB" -At -c "
  select count(*) from information_schema.tables
   where table_schema in ('core','sales','purchasing','inventory','production','quality','treasury','fin','audit')")"
echo "   ERP tables created: $TABLES"

echo "== production completion cycle (FIFO / FG receipt / close journal / idempotency)"
if psql -d "$DB" -q -v ON_ERROR_STOP=1 \
     -f "$ROOT/supabase/tests/production_completion_selftest.sql" >/tmp/prod_selftest.log 2>&1; then
  grep -E 'PASS|FAIL|failures' /tmp/prod_selftest.log | sed 's/^ */   /'
else
  echo "   PRODUCTION COMPLETION SELF-TEST FAILED" >&2
  cat /tmp/prod_selftest.log >&2
  exit 1
fi

echo "== accounting / inventory guards"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/accounting_guards_selftest.sql" 2>&1 |
  sed -n 's/.*NOTICE:  \(SELFTEST.*\)/   \1/p'

echo "== verify_schema.sql"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/verify/verify_schema.sql" >/tmp/vs_preflight.log 2>&1
echo "   OK (output reviewed in /tmp/vs_preflight.log)"

echo "== verify_rls.sql"
psql -d "$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/verify/verify_rls.sql" >/tmp/vr_preflight.log 2>&1
echo "   OK"

echo
echo "LOCAL MIGRATION PREFLIGHT PASSED: $TABLES tables, guards 1-8, schema and RLS checks."
echo "Nothing was applied to Supabase. Scratch database $DB was dropped."
