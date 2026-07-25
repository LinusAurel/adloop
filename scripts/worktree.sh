#!/usr/bin/env bash
# Worktree-Helper: Branch-Arbeit passiert IMMER in einem Worktree unter
# .worktrees/, nie im Haupt-Checkout (der bleibt dauerhaft auf main).
#
#   scripts/worktree.sh new <type> <short-desc> [issue-nr]   # anlegen + Setup
#   scripts/worktree.sh list                                 # Überblick
#   scripts/worktree.sh done <branch|slug>                   # aufräumen
#
# Branch-Konvention: <type>/<issue-nr>-<short-desc> (Issue-Nr wenn vorhanden),
# lowercase, ASCII, kebab-case. Beispiel: scripts/worktree.sh new feat board-ui 12
set -euo pipefail

die() { echo "worktree: $*" >&2; exit 1; }

# .git-common-dir zeigt auch aus einem Worktree heraus auf das Haupt-Repo.
main_root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
base_dir="$main_root/.worktrees"
cmd="${1:-list}"

case "$cmd" in
  new)
    type="${2:-}"; desc="${3:-}"; issue="${4:-}"
    { [ -n "$type" ] && [ -n "$desc" ]; } || die "usage: worktree.sh new <type> <short-desc> [issue-nr]"
    case "$type" in
      feat|fix|chore|docs|refactor|test|spike) ;;
      *) die "ungültiger Typ '$type' (erlaubt: feat fix chore docs refactor test spike)" ;;
    esac
    branch="${type}/${issue:+${issue}-}${desc}"
    path="$base_dir/$(printf '%s' "$branch" | tr '/' '-')"
    [ -e "$path" ] && die "existiert schon: $path"

    base_ref="main"
    if git -C "$main_root" remote get-url origin >/dev/null 2>&1; then
      git -C "$main_root" fetch origin main --quiet && base_ref="origin/main" || true
    fi
    # --no-track: kein Upstream auf main, sonst meldet git den Branch als
    # "behind origin/main"; push.default=current macht `git push` trotzdem trivial.
    git -C "$main_root" worktree add "$path" -b "$branch" --no-track "$base_ref"
    git -C "$path" config push.default current

    # Bootstrap: eigener node_modules-Baum pro Worktree, Hooks aktivieren.
    if [ -f "$path/package.json" ]; then
      (
        cd "$path"
        if [ -f pnpm-lock.yaml ]; then pnpm install --silent; else npm install --silent; fi
        npx lefthook install >/dev/null 2>&1 || true
      )
    fi
    echo "worktree bereit: $path  (Branch: $branch)"
    ;;

  list)
    git -C "$main_root" worktree list
    ;;

  done)
    name="${2:-}"; [ -n "$name" ] || die "usage: worktree.sh done <branch|slug>"
    path="$base_dir/$(printf '%s' "$name" | tr '/' '-')"
    [ -d "$path" ] || die "kein Worktree unter $path"
    branch="$(git -C "$path" branch --show-current)"
    git -C "$main_root" worktree remove "$path" \
      || die "Worktree hat uncommittete Änderungen — erst committen/verwerfen."
    git -C "$main_root" branch -d "$branch" 2>/dev/null \
      || echo "Hinweis: Branch '$branch' nicht gelöscht (nicht gemerged?). Bewusst: git branch -D $branch"
    echo "aufgeräumt: $path"
    ;;

  *)
    die "unbekanntes Kommando '$cmd' (new | list | done)"
    ;;
esac
