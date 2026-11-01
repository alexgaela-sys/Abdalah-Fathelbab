#!/usr/bin/env bash
# shellcheck shell=bash
# =====================================================================
# scripts/lib/test_db_url.sh
#
# Resolves TEST_DATABASE_URL to exactly ONE usable postgres URI.
#
# Why this exists: the workspace value was observed to hold several
# documentation-template URIs concatenated with newlines, e.g.
#
#   postgresql://postgres.<ref>:<password>@aws-0-[REGION].pooler.supabase.com:5432/postgres
#   (blank line)
#   postgresql://postgres.<ref>:<pass-A>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres
#   postgresql://postgres.<ref>:<pass-B>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres
#
# The old inline parser applied a per-line `sed` to the whole value, so it
# produced a multi-line "host" and psql was handed an unusable URI. The failure
# then surfaced as "authentication failed", which hides the real cause.
#
# Contract:
#   * RESOLVED_TEST_DB_URL  set to the single usable URI (empty on failure)
#   * TD_HOST / TD_PORT / TD_DB / TD_USER  non-secret components of that URI
#   * resolves to exactly one candidate; refuses template hosts and refuses
#     conflicting candidates instead of guessing which one to use
#   * NEVER echoes or logs the URI or the password (masked host only)
# =====================================================================

TD_ERROR=""
RESOLVED_TEST_DB_URL=""
TD_HOST=""
TD_PORT=""
TD_DB=""
TD_USER=""
TD_CANDIDATES=0
TD_TEMPLATES=0
TD_INCOMPLETE=0

tdb_trim() {
  local s="$1"
  s="${s%$'\r'}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Extracts one component without ever printing the full URI.
# $1 = uri, $2 = user|host|port|db
tdb_field() {
  local uri="$1" field="$2" rest authority
  rest="${uri#*://}"
  authority="${rest%%/*}"
  case "$field" in
    user) printf '%s' "${authority%@*}" | sed -E 's#:.*$##' ;;
    host) local h="${authority##*@}"; printf '%s' "${h%%:*}" ;;
    port) local h="${authority##*@}"; case "$h" in *:*) printf '%s' "${h##*:}" ;; *) printf '5432' ;; esac ;;
    db)   local p="${rest#*/}"; printf '%s' "${p%%\?*}" ;;
  esac
}

# True when the host is a documentation placeholder, not a real endpoint.
tdb_is_template_host() {
  case "$1" in
    *'['*|*']'*|*'<'*|*'>'*|'') return 0 ;;
    *) return 1 ;;
  esac
}

tdb_fail() {
  TD_ERROR="$1"
  RESOLVED_TEST_DB_URL=""
  TD_HOST=""
  TD_PORT=""
  TD_DB=""
  TD_USER=""
  return 1
}

# resolve_test_db_url <raw value>
resolve_test_db_url() {
  local raw="$1" line uri
  local -a usable=()
  TD_ERROR=""
  RESOLVED_TEST_DB_URL=""
  TD_CANDIDATES=0
  TD_TEMPLATES=0
  TD_INCOMPLETE=0

  if [ -z "$(tdb_trim "$raw")" ]; then
    tdb_fail "TEST_DATABASE_URL is empty."
    return 1
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    uri="$(tdb_trim "$line")"
    [ -z "$uri" ] && continue
    case "$uri" in
      postgres://*|postgresql://*) : ;;
      *) continue ;;
    esac
    # A complete URI needs scheme://user[:pass]@host[:port]/database.
    case "$uri" in
      *'@'*/*) : ;;
      *)
        TD_INCOMPLETE=$((TD_INCOMPLETE + 1))
        continue
        ;;
    esac
    local host; host="$(tdb_field "$uri" host)"
    if tdb_is_template_host "$host"; then
      TD_TEMPLATES=$((TD_TEMPLATES + 1))
      continue
    fi
    # Deduplicate identical lines (the same URI pasted twice is not a conflict).
    local dup=0 seen
    for seen in "${usable[@]}"; do
      [ "$seen" = "$uri" ] && dup=1 && break
    done
    [ "$dup" -eq 1 ] && continue
    usable+=("$uri")
  done <<EOF
$raw
EOF

  TD_CANDIDATES=${#usable[@]}

  if [ "$TD_CANDIDATES" -eq 0 ]; then
    if [ "$TD_TEMPLATES" -gt 0 ] && [ "$TD_INCOMPLETE" -gt 0 ]; then
      tdb_fail "TEST_DATABASE_URL has $TD_TEMPLATES template/placeholder and $TD_INCOMPLETE incomplete line(s); no usable connection string."
    elif [ "$TD_TEMPLATES" -gt 0 ]; then
      tdb_fail "TEST_DATABASE_URL holds only template/placeholder URIs ($TD_TEMPLATES), no real connection string."
    elif [ "$TD_INCOMPLETE" -gt 0 ]; then
      tdb_fail "TEST_DATABASE_URL has $TD_INCOMPLETE incomplete line(s); no complete postgresql://user:password@host:port/database URI."
    else
      tdb_fail "TEST_DATABASE_URL contains no complete postgresql://user:password@host:port/database URI."
    fi
    return 1
  fi

  if [ "$TD_CANDIDATES" -gt 1 ]; then
    # Two different connection strings cannot both be right: refuse instead of
    # silently picking one (picking the wrong one is how a write lands on the
    # wrong project).
    local a="${usable[0]}" b="${usable[1]}"
    local ha hb ua ub
    ha="$(tdb_field "$a" host)"; hb="$(tdb_field "$b" host)"
    ua="$(tdb_field "$a" user)"; ub="$(tdb_field "$b" user)"
    tdb_fail "TEST_DATABASE_URL holds $TD_CANDIDATES different connection strings (${ua}@${ha} vs ${ub}@${hb}). Keep exactly one."
    return 1
  fi

  RESOLVED_TEST_DB_URL="${usable[0]}"
  TD_HOST="$(tdb_field "$RESOLVED_TEST_DB_URL" host)"
  TD_PORT="$(tdb_field "$RESOLVED_TEST_DB_URL" port)"
  TD_DB="$(tdb_field "$RESOLVED_TEST_DB_URL" db)"
  TD_USER="$(tdb_field "$RESOLVED_TEST_DB_URL" user)"
  return 0
}
