# adloop v2 — Etappe 2: Meta connection and raw insight sync

## Run it

```
cp .env.example .env
# edit .env — see below for what each value means
docker compose up --build
```

Open <http://localhost:3000/login> (or whatever `WEB_PORT` you set). Request
a code for `user@example.com`; development delivery writes the six-digit
code to the `web` log. `/connectors` connects Meta, selects an ad account,
starts the background sync, and shows readiness.

`docker compose down -v` for a clean slate (drops the Postgres and MinIO
volumes too).

## What goes in `.env`

Copy `.env.example` to `.env` and fill in real values — `.env.example`
intentionally ships only placeholders (this repo is public; see
PROMPT-etappe-1.md §0).

| Variable | Meaning |
|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Postgres credentials, used only inside the compose network |
| `DATABASE_URL` | Full connection string `web` and `worker` use — must match the three values above |
| `WEB_PORT` | Host port the UI/API is published on (only `web` publishes a port) |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | Local S3-compatible storage credentials |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` | Raw Meta response object storage |
| `SESSION_SECRET` | At least 32 random characters; signs HTTP-only sessions and login-code hashes |
| `META_APP_ID` / `META_APP_SECRET` | Meta app credentials; configure together with the next two values |
| `META_REDIRECT_URI` | Exact registered callback URI, normally `http://localhost:3000/api/auth/meta/callback` |
| `ENCRYPTION_KEY` | Base64-encoded 32-byte key (or 64 hex characters) for Meta tokens |
| `META_GRAPH_API_VERSION` | Explicit Marketing API version, currently `v25.0` |
| `SYNC_BACKFILL_DAYS` | Daily correction window; defaults to 7 |
| `JOB_POLL_INTERVAL_MS` | How often the worker polls when idle (LISTEN/NOTIFY wakes it sooner) |
| `JOB_LEASE_MS` | How long a claimed job's lease lasts without a heartbeat |
| `JOB_HEARTBEAT_INTERVAL_MS` | How often the worker renews the lease of a running job |
| `WORKER_CONCURRENCY` | Jobs a single worker process runs at once |
| `WORKER_SHUTDOWN_GRACE_MS` | How long `SIGTERM` waits for in-flight jobs before the process exits |

## Layout

```
migrations/     node-pg-migrate SQL migrations (schema_migrations table)
scripts/        migrate.ts — runs migrations under a Postgres advisory lock
src/queue/      the queue: transitions, fencing, lease, retry, cancel, families/
src/access/     UI policy tree (not server authorization)
src/auth/       signed sessions, email codes, central tenant guard
src/meta/       typed Graph client, OAuth, insight normalization and sync
src/storage/    S3-compatible raw response storage
src/app/        Next.js App Router — login, connectors, and API routes
worker/         worker process entrypoint, built from the same source tree
test/           Vitest, against real Postgres (Testcontainers) — see DECISIONS.md
```

`web` and `worker` are built from the same Dockerfile/image — only the
command differs (`web` runs migrations then `next start`; `worker` runs the
poll loop). Only `web` publishes a host port; `db` and `minio` are reachable
solely inside the compose network.

## Fixture verification

`pnpm test` runs against ephemeral Postgres containers and recorded,
synthetic responses in `test/fixtures/meta/`. The suite covers corrected
observations, vanished actions, incomplete-run exclusion, pagination,
rate-limit retry, cursor resume, tenant isolation, and per-account sync
concurrency. No live Meta credentials are needed.

`net_new_reach` is deliberately required by the stored response contract,
but Meta's documented v25 Insights fields do not currently expose a field
with that name. Fixture verification is complete; live sync will fail
loudly rather than substitute `reach` and create a false funnel input.

## Everything else

`DECISIONS.md` — points the auftrag left open, and how they were resolved.
