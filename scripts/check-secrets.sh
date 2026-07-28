#!/usr/bin/env bash
# Blocks commits that would leak credentials. Runs against staged content only,
# so it sees exactly what is about to enter history -- not what happens to sit
# in the working tree.
#
#   scripts/check-secrets.sh            # staged changes (pre-commit)
#   scripts/check-secrets.sh --all      # whole tree, tracked files (audit)
#
# This exists because the Meta app secret reached a chat before it reached a
# gitignored file. A hook cannot fix that, but it can stop the next one.

set -uo pipefail

mode="${1:-staged}"
fail=0

# Files that must never be committed, whatever their content.
BLOCKED_PATHS='(^|/)\.env($|\.)|\.pem$|\.key$|(^|/)id_(rsa|ed25519)$|(^|/)\.npmrc$'
# .env.example is documentation, not a secret.
ALLOWED_PATHS='(^|/)\.env\.example$'

if [ "$mode" = "--all" ]; then
  files=$(git ls-files)
else
  files=$(git diff --cached --name-only --diff-filter=ACM)
fi

[ -z "$files" ] && exit 0

while IFS= read -r f; do
  [ -z "$f" ] && continue

  if printf '%s' "$f" | grep -Eq "$BLOCKED_PATHS" && ! printf '%s' "$f" | grep -Eq "$ALLOWED_PATHS"; then
    echo "  refused: $f -- credential file, keep it out of git"
    fail=1
    continue
  fi

  if [ "$mode" = "--all" ]; then
    content=$(cat "$f" 2>/dev/null)
  else
    content=$(git show ":$f" 2>/dev/null)
  fi
  [ -z "$content" ] && continue

  # Provider-specific shapes. Each is distinctive enough not to fire on prose.
  hits=$(printf '%s' "$content" | grep -nE \
    -e 'sk-ant-[A-Za-z0-9_-]{20,}' \
    -e 'AKIA[0-9A-Z]{16}' \
    -e 'EAA[A-Za-z0-9]{60,}' \
    -e 'ghp_[A-Za-z0-9]{30,}' \
    -e 'glpat-[A-Za-z0-9_-]{15,}' \
    -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
    -e '(app_?secret|client_?secret|api_?key|access_?token|password)["'"'"']?\s*[:=]\s*["'"'"'][^"'"'"'$][^"'"'"']{15,}' \
    2>/dev/null | head -5)

  if [ -n "$hits" ]; then
    echo "  refused: $f"
    printf '%s\n' "$hits" | sed 's/^/    /'
    fail=1
  fi
done <<< "$files"

if [ "$fail" -ne 0 ]; then
  cat <<'MSG'

Commit blocked: the staged changes look like they carry a credential.

If it is a real secret: unstage it, move the value into a gitignored file,
and rotate it -- once a value is written down in the wrong place, treat it
as compromised.

If it is a false positive: git commit --no-verify, and tell us which pattern
fired so it can be narrowed.
MSG
  exit 1
fi

exit 0
