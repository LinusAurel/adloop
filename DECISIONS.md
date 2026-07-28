# Decisions

Places where PROMPT-etappe-1.md left something open, or where a second
adversarial review corrected the auftrag itself. One sentence of reasoning
each, per §10.

## State machine (corrected mid-build by a second review)

- **Fencing applies only to worker mutations, not to the cancel API.**
  §4.4's `WHERE lease_token = $token` is for writes made *through a lease*
  (progress, heartbeat, terminal writes); the cancel API never holds a
  lease, so `sql/cancel.ts` uses a status-only compare-and-set instead.
- **Terminal writes (`completed`/`failed`/`timed_out`) are only reachable
  from `status = 'claimed'`, never from `cancel_requested`.** This is what
  makes test case 7 decidable: the race is between the worker's completion
  write and the cancel API's `claimed -> cancel_requested` write, both
  gated on the *same* `status = 'claimed'` precondition — whichever commits
  first wins outright, with no second, looser condition that could let both
  "win". The worker's own cancellation finalize is a separate transition,
  gated on `status = 'cancel_requested'` instead.
- **Added `retry_scheduled -> cancelled`** (`sql/cancel.ts`): cancelling a
  job that's waiting between retries has to work, and needs to skip the
  claim step entirely — otherwise it would run one more time before the
  cancellation could take effect.
- **Added a reaper for stranded `cancel_requested` jobs**
  (`reapOrphanedCancellations` in `sql/reap.ts`, test case 9): if the
  worker that received a cancel request dies before finalizing, nothing
  else ever moves the job out of `cancel_requested` — it would be stuck
  forever. The reaper treats an expired lease on a `cancel_requested` job
  the same way it treats one on a `claimed` job, except it resolves to
  `cancelled`, not `queued` (the job was on its way out, not merely
  interrupted).

## Runtime / build

- **`env.ts` validates lazily (on first property access via a Proxy), not
  eagerly at import time.** The first version threw at import if
  `DATABASE_URL` was unset, which broke `next build`'s route-collection
  phase (it imports every route module to inspect exports, without a real
  runtime environment). Every real code path still validates before it
  reads a value — it just no longer validates before it's needed.
- **`worker.js` and `migrate.js` are esbuild-bundled *without*
  `--packages=external`, i.e. fully self-contained.** Next's standalone
  output only traces dependencies actually imported by the Next app;
  `node-pg-migrate` is never imported there, so it would be missing from
  `node_modules` in the runtime image if the worker/migrate bundles relied
  on it being present. Bundling everything sidesteps that entirely.
- **`.nvmrc` / Dockerfiles pin Node `22.12.0`** — a concrete released 22 LTS
  patch, not the floating `22-alpine` tag, so a rebuild six months from now
  doesn't silently pick up a different Node minor.
- **pnpm pinned via `packageManager` in package.json and installed
  explicitly in the Dockerfile (`npm install -g pnpm@<version>`)** rather
  than relying on `corepack enable` fetching it over the network during the
  build — one less thing that can fail in a sandboxed build environment.

## Data model

- **`job.run_id` carries a `UNIQUE` constraint.** The auftrag states
  "genau ein Job je Run" for Etappe 1 as a fact, not explicitly as a
  constraint; enforcing it in the schema makes `createRun`'s idempotency
  logic simple and correct under real concurrency (`ON CONFLICT`-style
  reasoning) instead of relying on application discipline. A later stage
  that allows multiple jobs per run drops this constraint in a new forward
  migration (migrations are forward-only, per the auftrag).
- **`run.status` transitions to `'running'` on first claim** (`sql/claim.ts`),
  and stays there through `retry_scheduled` cycles until a terminal job
  status lands. The auftrag's `run` schema implies this (the status enum
  includes `running`) but never says who sets it — nobody did, until the
  first real verification pass against the running stack surfaced a run
  stuck showing `queued` while its job was already `claimed`.
- **Migrations are `.sql` files with `-- Up Migration` / `-- Down
  Migration` markers, no real down migrations.** The auftrag requires
  forward-only, idempotent migrations; down sections are present only
  because node-pg-migrate's SQL format expects the marker, not because
  they're meant to be run.
- **Seed IDs are simple, recognizable fixed UUIDs**
  (`00000000-...-0001` / `...-0002`), not UUIDv7-shaped ones. The auftrag
  asks for UUIDv7 as the *generation strategy* for app-created IDs; a
  fixed, human-recognizable seed value is a different concern and reads
  better in logs/fixtures during Etappe 1's manual verification.

## Queue mechanics

- **Cancellation delivery is NOTIFY-first with heartbeat-poll as fallback.**
  §4.9 specifies this pattern for job claiming ("Polling bleibt als
  Rückfallebene"); applying the same pattern to cancellation is what makes
  the 2-second budget in test case 6 comfortably achievable — a `job_cancelled`
  NOTIFY reaches a running handler in low tens of milliseconds, while the
  heartbeat-only fallback path (used when a job is driven outside the full
  worker loop, e.g. directly in tests) still lands well inside 2s at the
  default `JOB_HEARTBEAT_INTERVAL_MS`.
- **`always_fails` and `sleeps_forever` carry `backoffBaseMs`/`backoffMaxMs`
  overrides on the family definition**, a field the auftrag's minimal
  family interface (§4.10) doesn't list. Needed so retry tests (case 2)
  don't spend real wall-clock time on the production 1s/2s/4s schedule;
  documented as an optional, backward-compatible extension.
- **`evaluateAccessPolicy` recognizes an unused `'member'` role** in
  addition to `'owner'` (only `'owner'` is seeded in Etappe 1), and denies
  everything for any unrecognized role instead of throwing. Makes it an
  actual tree lookup instead of a single-case stub, and gives a safe
  default for a role the current seed never produces.
- **`GET /api/runs` also accepts no `status` filter** (returns the 50 most
  recent runs for the seed tenant), in addition to the required
  `?status=active`. Purely additive — the UI needs to show a just-completed
  run's result, which disappears from the `active` filter the moment it
  terminates.

## Testing

- **Testcontainers, not a second compose service**, for `pnpm test`
  (§8 leaves the choice open). Each test file starts its own ephemeral
  `postgres:16-alpine` container, migrated with the exact same
  `migrations/*.sql` the app uses — no parallel schema definition that
  could drift from what Docker Compose actually runs.
- **Tests call the queue primitives (`claimNextJob`, `finalizeJob`,
  `requestCancel`, ...) directly** rather than going through HTTP or the
  full worker process, for the load-bearing cases (4, 5, 7, 9). This is
  white-box testing of the exact functions that provide the atomicity
  guarantees, which is the right level for proving those guarantees — a
  black-box HTTP test could pass by accident (bad timing happening to work
  out) in a way these can't, since case 5 and case 7 use an explicit
  barrier to force real concurrency rather than two sequential calls.
