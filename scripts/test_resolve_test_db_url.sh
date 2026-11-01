#!/usr/bin/env bash
# Tests for scripts/lib/test_db_url.sh — synthetic values only, no real secret.
# Run: bash scripts/test_resolve_test_db_url.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/test_db_url.sh
source "$ROOT/scripts/lib/test_db_url.sh"

PASS=0
FAIL=0

expect_ok() {
  local name="$1" raw="$2" want_host="$3"
  if resolve_test_db_url "$raw"; then
    if [ "$TD_HOST" = "$want_host" ] && [ -n "$RESOLVED_TEST_DB_URL" ]; then
      printf 'PASS  %s\n' "$name"; PASS=$((PASS + 1))
    else
      printf 'FAIL  %s (host=%s)\n' "$name" "${TD_HOST:-<empty>}"; FAIL=$((FAIL + 1))
    fi
  else
    printf 'FAIL  %s (unexpected reject: %s)\n' "$name" "$TD_ERROR"; FAIL=$((FAIL + 1))
  fi
}

expect_reject() {
  local name="$1" raw="$2" want_substring="$3"
  if resolve_test_db_url "$raw"; then
    printf 'FAIL  %s (unexpectedly resolved)\n' "$name"; FAIL=$((FAIL + 1))
  else
    case "$TD_ERROR" in
      *"$want_substring"*) printf 'PASS  %s\n' "$name"; PASS=$((PASS + 1)) ;;
      *) printf 'FAIL  %s (wrong reason: %s)\n' "$name" "$TD_ERROR"; FAIL=$((FAIL + 1)) ;;
    esac
  fi
}

A='postgresql://postgres.abcdefghij:pwAAA111@aws-1-eu-central-1.pooler.supabase.com:5432/postgres'
B='postgresql://postgres.abcdefghij:pwBBB222@aws-1-eu-central-1.pooler.supabase.com:5432/postgres'
TPL='postgresql://postgres.abcdefghij:tmplPw99@aws-0-[REGION].pooler.supabase.com:5432/postgres'

expect_ok     "single clean URI"                  "$A" "aws-1-eu-central-1.pooler.supabase.com"
expect_ok     "template line + one real URI"      "$TPL
$A" "aws-1-eu-central-1.pooler.supabase.com"
expect_ok     "template + blank + duplicate"      "$TPL

$A
$A" "aws-1-eu-central-1.pooler.supabase.com"
expect_ok     "trailing CRLF line"                "$A
" "aws-1-eu-central-1.pooler.supabase.com"
expect_reject "template only"                     "$TPL" "template"
expect_reject "two conflicting passwords"         "$A
$B" "different connection strings"
expect_reject "truncated value (no db part)"      "postgresql://postgres.abcdefghij:pwAAA111@aws-1-eu-central-1.pooler.supabase.com:5432" "incomplete"
expect_reject "empty value"                       "" "empty"
expect_reject "bare password"                     "pwAAA111" "no complete"

# The resolver must never emit the password on failure paths.
if resolve_test_db_url "$A
$B" >/dev/null 2>&1; then :; fi
case "$TD_ERROR" in
  *pwAAA111*|*pwBBB222*) printf 'FAIL  masked diagnostics (secret leaked in message)\n'; FAIL=$((FAIL + 1)) ;;
  *) printf 'PASS  masked diagnostics\n'; PASS=$((PASS + 1)) ;;
esac

echo
echo "resolver: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
