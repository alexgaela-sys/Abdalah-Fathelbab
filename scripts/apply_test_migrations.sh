#!/usr/bin/env bash
# Apply the SnakDip ERP schema migrations to the Supabase TEST project.
#
# NOT run by the agent. Requires direct Postgres credentials for TEST
# (TEST_DATABASE_URL). It refuses to run against anything it cannot confirm as
# the TEST project ref, takes a restorable dump FIRST, applies each migration
# in its own transaction, and records what it applied.
#
# Usage:
#   bash scripts/apply_test_migrations.sh --check          # read-only: connect + ref + pending
#   bash scripts/apply_test_migrations.sh                 # dry run: list pending
#   bash scripts/apply_test_migrations.sh --apply --yes   # apply for real
#
# Rollback = restore the dump the script wrote (supabase/backups/). There is
# deliberately no DROP-based rollback file: dropping ERP tables would destroy
# live rows, and this migration set is additive.

set -euo pipefail

PROJECT_REF_EXPECTED="${PROJECT_REF_EXPECTED:-xrqksgjtqzddzqcwfnaj}"
DB_RAW="${TEST_DATABASE_URL:-}"
DB_FILE="${TEST_DATABASE_URL_FILE:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIG_DIR="$ROOT/supabase/migrations"
BACKUP_DIR="$ROOT/supabase/backups"
APPLY=0
ASSUME_YES=0
CHECK=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --yes)   ASSUME_YES=1 ;;
    --check) CHECK=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$DB_RAW" ] && [ -z "$DB_FILE" ]; then
  echo "TEST_DATABASE_URL is not set. Nothing was applied." >&2
  echo "Set it in the workspace environment (Keys/Environment), then re-run." >&2
  exit 2
fi

# Resolve the value to ONE usable URI. The workspace value has been observed to
# hold several documentation-template URIs concatenated with newlines, which the
# old inline sed parser turned into a multi-line "host" (psql then reported a
# misleading authentication failure). The resolver deduplicates, skips template
# hosts, refuses conflicting candidates, and never prints the secret.
# shellcheck source=scripts/lib/test_db_url.sh
source "$ROOT/scripts/lib/test_db_url.sh"

# Resolution order:
#   1. TEST_DATABASE_URL               (inline value, if it resolves to one URI)
#   2. TEST_DATABASE_URL_FILE          (path to a gitignored file holding it,
#      so the secret never has to live in the environment UI or a commit)
DB_SOURCE="TEST_DATABASE_URL"
if ! resolve_test_db_url "$DB_RAW"; then
  FIRST_ERROR="$TD_ERROR"
  if [ -n "$DB_FILE" ]; then
    if [ ! -f "$DB_FILE" ]; then
      echo "$FIRST_ERROR" >&2
      echo "TEST_DATABASE_URL_FILE points at '$DB_FILE', which does not exist." >&2
      echo "Refusing to continue. Nothing was applied." >&2
      exit 2
    fi
    if ! resolve_test_db_url "$(cat "$DB_FILE")"; then
      echo "$FIRST_ERROR" >&2
      echo "TEST_DATABASE_URL_FILE ($DB_FILE): $TD_ERROR" >&2
      echo "Refusing to continue. Nothing was applied." >&2
      exit 2
    fi
    DB_SOURCE="TEST_DATABASE_URL_FILE ($DB_FILE)"
  else
    echo "$FIRST_ERROR" >&2
    echo "Refusing to continue. Nothing was applied." >&2
    echo "Provide one TEST pooler URI, or set TEST_DATABASE_URL_FILE to a file that holds it." >&2
    exit 2
  fi
fi
DB_URL="$RESOLVED_TEST_DB_URL"
HOST="$TD_HOST"
DBNAME="$TD_DB"
DB_USER="$TD_USER"

echo "source      : $DB_SOURCE"
echo "target host : $HOST"
echo "target db   : $DBNAME"
echo "uri lines   : $TD_CANDIDATES usable, $TD_TEMPLATES template/incomplete ignored"

# Hard stop on any host that looks like a production pooler/host for another ref.
if ! printf '%s' "$HOST" | grep -q "supabase"; then
  echo "Target does not look like a Supabase host. Refusing to apply migrations." >&2
  exit 2
fi

# The connection itself must prove the TEST ref; CONFIRM_TEST_PROJECT alone is
# not proof of where it lands. Supabase puts the ref in the host for direct
# connections (db.<ref>.supabase.co) and in the USERNAME for pooler connections
# (postgres.<ref>@aws-*.pooler.supabase.com), so accept either — but never the
# password, which is not parsed here.
REF_SOURCE=""
if printf '%s' "$HOST" | grep -q -- "$PROJECT_REF_EXPECTED"; then
  REF_SOURCE="host"
elif printf '%s' "$DB_USER" | grep -q -- "$PROJECT_REF_EXPECTED"; then
  REF_SOURCE="username"
fi
if [ -z "$REF_SOURCE" ]; then
  echo "Refusing: neither the target host nor the connection username contains" >&2
  echo "the TEST project ref $PROJECT_REF_EXPECTED." >&2
  exit 2
fi
echo "ref proof   : $PROJECT_REF_EXPECTED found in $REF_SOURCE"

if ! psql "$DB_URL" -At -c "select 1" >/dev/null 2>&1; then
  echo "Authentication to the target failed. Nothing was applied." >&2
  echo "Reconnect the repository / refresh the TEST database password, then re-run." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# read-only check: connect, prove the target, list pending — no DDL, no dump
# ---------------------------------------------------------------------------
if [ "$CHECK" -eq 1 ]; then
  echo
echo "== read-only check (default_transaction_read_only=on)"
  IDENT="$(PGOPTIONS='-c default_transaction_read_only=on' psql "$DB_URL" -At -v ON_ERROR_STOP=1 -c \
    "select current_database(), current_user, current_setting('server_version'),
            (to_regclass('public.erp_schema_migrations') is not null)")" || {
    echo "Read-only connection check failed. Nothing was applied." >&2
    exit 2
  }
  DB="$(printf '%s' "$IDENT" | cut -d'|' -f1)"
  USR="$(printf '%s' "$IDENT" | cut -d'|' -f2)"
  VER="$(printf '%s' "$IDENT" | cut -d'|' -f3)"
  HAS_LEDGER="$(printf '%s' "$IDENT" | cut -d'|' -f4)"
  echo "connected as : $USR"
  echo "database     : $DB"
  echo "server       : $VER"
  echo "ledger table : $HAS_LEDGER"
  echo
  echo "== pending migrations"
  for f in $(ls "$MIG_DIR"/*.sql | sort); do
    base="$(basename "$f")"
    applied=""
    if [ "$HAS_LEDGER" = "t" ]; then
      applied="$(PGOPTIONS='-c default_transaction_read_only=on' psql "$DB_URL" -At -v ON_ERROR_STOP=1 \
        -c "select checksum from public.erp_schema_migrations where filename = '$base'")"
    fi
    sum="$(sha256sum "$f" | cut -d' ' -f1)"
    if [ -z "$applied" ]; then
      printf '   - %s (new)\n' "$base"
    elif [ "$applied" != "$sum" ]; then
      printf '   ! %s CHANGED since it was applied\n' "$base"
    else
      printf '   = %s already applied\n' "$base"
    fi
  done
  echo
echo "Read-only check complete. Nothing was written."
  exit 0
fi

if [ "${CONFIRM_TEST_PROJECT:-}" != "$PROJECT_REF_EXPECTED" ]; then
  echo "Refusing to apply: set CONFIRM_TEST_PROJECT=$PROJECT_REF_EXPECTED to confirm the target." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# migration ledger
# ---------------------------------------------------------------------------
psql "$DB_URL" -q -v ON_ERROR_STOP=1 -c "
  create table if not exists public.erp_schema_migrations (
    filename   text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  );"

echo
echo "== pending migrations"
PENDING=()
for f in $(ls "$MIG_DIR"/*.sql | sort); do
  base="$(basename "$f")"
  applied="$(psql "$DB_URL" -At -c "select checksum from public.erp_schema_migrations where filename = '$base'")"
  sum="$(sha256sum "$f" | cut -d' ' -f1)"
  if [ -z "$applied" ]; then
    printf '   - %s (new)\n' "$base"
    PENDING+=("$f")
  elif [ "$applied" != "$sum" ]; then
    printf '   ! %s CHANGED since it was applied (checksum mismatch) — review before re-applying\n' "$base"
    PENDING+=("$f")
  else
    printf '   = %s already applied\n' "$base"
  fi
done

if [ "${#PENDING[@]}" -eq 0 ]; then
  echo "Nothing to apply."
  exit 0
fi

if [ "$APPLY" -ne 1 ]; then
  echo
  echo "Dry run only. Re-run with --apply --yes to execute the plan above."
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  echo "Refusing to write without --yes." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# backup FIRST — restorable, timestamped, outside git (supabase/backups/)
# ---------------------------------------------------------------------------
mkdir -p "$BACKUP_DIR"

# pg_dump refuses to dump a NEWER server, so use the newest client installed
# (a stock Ubuntu box ships 14 while TEST now runs 17).
pick_pg_bin() {
  local name="$1" best=""
  for d in $(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V); do
    [ -x "$d/$name" ] && best="$d/$name"
  done
  printf '%s' "${best:-$(command -v "$name")}"
}
PG_DUMP="$(pick_pg_bin pg_dump)"
PG_RESTORE="$(pick_pg_bin pg_restore)"
SERVER_NUM="$(psql "$DB_URL" -At -c 'show server_version_num')"
DUMP_MAJOR="$("$PG_DUMP" --version | sed -E 's/.* ([0-9]+).*/\1/')"
if [ -n "$SERVER_NUM" ] && [ "$((SERVER_NUM / 10000))" -gt "$DUMP_MAJOR" ]; then
  echo "pg_dump $DUMP_MAJOR cannot dump server $(printf '%s' "$SERVER_NUM" | cut -c1-2)." >&2
  echo "Install the matching postgresql-client (e.g. postgresql-client-17). Nothing was applied." >&2
  exit 2
fi

echo
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_DIR/test_${STAMP}.dump"
echo "== backup -> supabase/backups/$(basename "$DUMP")"
"$PG_DUMP" "$DB_URL" --no-owner --no-privileges --format=custom --file="$DUMP"
echo "   size: $(du -h "$DUMP" | cut -f1)"

# The dump must be readable before anything is applied: a corrupt/empty backup
# is not a rollback plan.
TOC="$("$PG_RESTORE" --list "$DUMP" 2>/dev/null)" || {
  echo "Backup is not readable (pg_restore --list failed). Refusing to apply." >&2
  exit 2
}
TOC_ROWS="$(printf '%s\n' "$TOC" | grep -c . || true)"
if [ "${TOC_ROWS:-0}" -lt 10 ]; then
  echo "Backup looks empty ($TOC_ROWS TOC entries). Refusing to apply." >&2
  exit 2
fi
echo "   verified: pg_restore --list ok ($TOC_ROWS TOC entries)"
echo "   restore with: $PG_RESTORE --clean --if-exists --no-owner -d \"\$TEST_DATABASE_URL\" $DUMP"

# ---------------------------------------------------------------------------
# apply, one transaction per file
# ---------------------------------------------------------------------------
for f in "${PENDING[@]}"; do
  base="$(basename "$f")"
  sum="$(sha256sum "$f" | cut -d' ' -f1)"
  echo "== applying $base"
  psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$f"
  psql "$DB_URL" -q -v ON_ERROR_STOP=1 -c \
    "insert into public.erp_schema_migrations (filename, checksum)
     values ('$base', '$sum')
     on conflict (filename) do update set checksum = excluded.checksum, applied_at = now();"
done

echo
echo "Applied ${#PENDING[@]} migration(s). Next: run supabase/verify/verify_schema.sql"
echo "and supabase/verify/verify_rls.sql in the SQL Editor and keep the output."
