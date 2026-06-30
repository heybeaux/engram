#!/usr/bin/env bash
set -euo pipefail

# Block real-looking Engram API key literals from being committed.
# Placeholder docs such as eg_sk_your_key_here are intentionally allowed.

patterns=(
  '[Ee][Nn][Gg][Rr][Aa][Mm]_[[:alnum:]]{15,}'
  '[Ee][Gg]_[Ss][Kk]_[[:alnum:]]{16,}'
  '[Ee][Nn][Gg]_[[:alnum:]_]{20,}'
)

exclude_pathspecs=(
  ':(exclude)package-lock.json'
  ':(exclude)pnpm-lock.yaml'
  ':(exclude)yarn.lock'
  ':(exclude)scripts/check-no-hardcoded-secrets.sh'
)

failed=0
for pattern in "${patterns[@]}"; do
  matches=""
  set +e
  matches=$(git grep -n -E "$pattern" -- . "${exclude_pathspecs[@]}" 2>&1)
  grep_status=$?
  set -e

  case "$grep_status" in
    0)
      echo "❌ Found hardcoded Engram API key-like literal(s):" >&2
      echo "$matches" | sed -E 's/([A-Za-z]+_[A-Za-z0-9_]{6})[A-Za-z0-9_]+/\1…REDACTED/g' >&2
      failed=1
      ;;
    1)
      # No matches for this pattern.
      ;;
    *)
      echo "❌ git grep failed while checking for hardcoded Engram API keys:" >&2
      echo "$matches" >&2
      failed=1
      ;;
  esac
done

if [[ "$failed" -ne 0 ]]; then
  cat >&2 <<'MSG'

Replace real keys with environment variables, for example:
  ENGRAM_API_KEY
  ENGRAM_USER_ID

Docs may use placeholders such as eg_sk_your_key_here.
MSG
  exit 1
fi

echo "✅ No hardcoded Engram API key-like literals found."
