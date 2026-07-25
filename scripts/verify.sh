#!/usr/bin/env bash
# Einziges Qualitäts-Gate des Repos. Lokal, lefthook und GitHub CI rufen
# alle DIESES Skript — neue Checks kommen nur hier dazu.
#
#   scripts/verify.sh quick     lint + typecheck            (pre-commit)
#   scripts/verify.sh full      lint + typecheck + test + build  (pre-push, CI)
#   scripts/verify.sh secrets   blockt gestagte .env-Dateien und Key-Muster
#
# Solange kein package.json existiert (App wird erst heute gebaut), sind
# quick/full ein bewusster No-op — das Gate waechst mit der App mit.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
MODE="${1:-full}"

fail() { echo "verify FAILED: $*" >&2; exit 1; }

if [ "$MODE" = "secrets" ]; then
  staged="$(git diff --cached --name-only --diff-filter=ACM)"
  envs="$(printf '%s\n' "$staged" | grep -E '(^|/)\.env(\.[^/]*)?$' | grep -vE '\.env\.example$' || true)"
  if [ -n "$envs" ]; then
    fail ".env-Datei gestaged (gehört in .gitignore): $envs"
  fi
  # Key-Muster: Anthropic (sk-ant-), Meta (EAA...), Firecrawl (fc-), private Keys.
  # Lockfiles ausgenommen — base64-Hashes triggern sonst False-Positives.
  if git diff --cached -U0 -- . ':(exclude)pnpm-lock.yaml' ':(exclude)package-lock.json' ':(exclude)bun.lock' \
    | grep -qE 'sk-ant-[A-Za-z0-9_-]{8,}|EAA[A-Za-z0-9]{24,}|fc-[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY'; then
    fail "Secret-Muster im gestagten Diff (API-Key?). Nie Keys committen — .env nutzen."
  fi
  exit 0
fi

# Anführungszeichen-Check läuft schon vor dem package.json-Guard —
# er braucht nur Node, keine Dependencies.
if command -v node >/dev/null 2>&1; then
  echo "== german-quotes"
  node scripts/check-quotes.mjs
fi

if [ ! -f package.json ]; then
  echo "verify: kein package.json — noch nichts zu prüfen, Gate ok."
  exit 0
fi

PM=npm
[ -f pnpm-lock.yaml ] && PM=pnpm
[ -f bun.lock ] && PM=bun

has_script() { node -e "process.exit((require('./package.json').scripts||{})['$1']?0:1)"; }

run_script() {
  if has_script "$1"; then
    echo "== $1"
    $PM run "$1"
  else
    echo "-- skip: kein '$1'-Script in package.json"
  fi
}

run_script lint

if has_script typecheck; then
  run_script typecheck
elif [ -f tsconfig.json ]; then
  echo "== typecheck (tsc --noEmit)"
  npx tsc --noEmit
else
  echo "-- skip typecheck: kein tsconfig.json"
fi

if [ "$MODE" = "full" ]; then
  run_script test
  run_script build
fi

echo "verify OK ($MODE)"
