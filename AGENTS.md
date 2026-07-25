# AGENTS.md — Process contract

Binding root contract for all coding agents (and a useful guide for human
contributors) in this repo. Kept short on purpose: the process should prevent
mistakes, not cost speed. Anything not listed here is deliberately omitted.

## Sources of truth

- `README.md` — what adloop is and why (product truth).
- `SPEC.md` — blueprint: stack, data model, pipeline contracts.
- `brands/<slug>/` — brand data. Anything company-specific is always data,
  never code in `engine/` or `app/`.
- On contradiction between documents, or between a document and a task:
  stop, name the contradiction, and ask the maintainer. Never silently pick
  one interpretation.

## Workflow: issue → worktree → branch → merge

1. **Issue-first.** Every substantial work package starts with a GitHub issue.
   Obvious mini-fixes (a few minutes) may skip this.
2. **Worktrees are mandatory.** Branch work ALWAYS happens in a worktree,
   never in the main checkout — that one stays on `main` permanently. Create
   one with `scripts/worktree.sh new <type> <short-desc> [issue-nr]`; the
   script creates branch + worktree under `.worktrees/`, installs
   dependencies, and activates the hooks. Parallel work streams never collide.
3. **Branch convention.** `<type>/<issue-nr>-<short-desc>`, lowercase, ASCII,
   kebab-case; types: `feat fix chore docs refactor test spike`.
   Example: `feat/12-board-ui`.
4. **Small commits with issue references.** One logical unit per commit; when
   an issue applies, the subject ends with `(#N)` and the closing commit or PR
   contains `Closes #N`.
5. **Rebase, don't accumulate merges.** Rebase onto current `main` before
   integrating, then fast-forward merge or push — no merge commits out of
   worktrees.
6. **Clean up.** After merging: `scripts/worktree.sh done <branch>` removes
   worktree and branch. Overview: `scripts/worktree.sh list`.

## Language and conventions

- Commit subjects: English, Conventional-Commit style
  `<type>(<scope>): <summary>`. Allowed types:
  `feat fix docs refactor test chore ci build perf revert`.
- Identifiers, file names, branches, env vars: English, ASCII-only.
- Code comments: English, sparse, only for non-obvious logic.
- UI copy targets the German market and uses proper German typography
  (umlauts, `ß`, „…“ quotes); a pre-commit hook auto-fixes wrong quote
  closers (`node scripts/check-quotes.mjs --fix`).

## Working discipline

- Change only the agreed scope. No drive-by cleanups, no style changes in
  unrelated files.
- "It works" may only be claimed when it was proven in the same session
  (route called, response read, UI seen). Mark unverified things as
  unverified.
- Before finishing a work package: everything committed and `verify` green —
  the verified state must equal the pushed state.

## Verify before commit and push (mandatory)

- One single gate: `bash scripts/verify.sh` — lefthook runs it automatically
  (pre-commit: secrets scan + quote autofix + `quick`, pre-push: `full`),
  CI calls the same script. New checks go ONLY into `scripts/verify.sh`.
- Red means fix, not bypass: no weakening assertions, no skipping tests, no
  blanket `eslint-disable`, no `--no-verify`. Sole exception: a proven false
  positive of the secrets scan — then fix the pattern in `scripts/verify.sh`
  in the same change.

## Hard rules (hard stops)

1. **Never commit secrets**: no `.env` files, API keys, or tokens in code,
   fixtures, logs, or docs. `.env.example` stays worthless (empty values).
2. **Meta publishes are always `status: PAUSED`** — campaigns, ad sets, ads.
   Activation is done exclusively by a human: a deliberate click via the
   status route/UI or directly in Ads Manager. No agent ever activates.
3. **Human gates are never automated or skipped**: angle approval, asset
   approval, and ad activation are human decisions.
4. **No budget/spend management by agents** — not even "just for testing".
5. **Guardian self-protection**: `AGENTS.md`, `scripts/`, `lefthook.yml`, and
   `.github/workflows/ci.yml` are only changed with explicit maintainer
   approval — an agent does not disable its own gates.
