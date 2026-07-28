# adloop v2 — Etappe 1: Fundament und Warteschlange

## Run it

```
cp .env.example .env
# edit .env — see below for what each value means
docker compose up --build
```

Open <http://localhost:3000> (or whatever `WEB_PORT` you set). The page is a
verification tool, not a product surface: it starts an `echo` job and polls
its progress.

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
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO credentials — MinIO runs in Etappe 1 but isn't used yet (Etappe 6) |
| `S3_ENDPOINT` / `S3_BUCKET` | Object storage config, likewise unused until Etappe 6 |
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
src/access/     evaluateAccessPolicy(role) — a pure function, no auth yet
src/app/        Next.js App Router — API routes + the one verification page
worker/         worker process entrypoint, built from the same source tree
test/           Vitest, against real Postgres (Testcontainers) — see DECISIONS.md
```

`web` and `worker` are built from the same Dockerfile/image — only the
command differs (`web` runs migrations then `next start`; `worker` runs the
poll loop). Only `web` publishes a host port; `db` and `minio` are reachable
solely inside the compose network.

## Everything else

`DECISIONS.md` — points the auftrag left open, and how they were resolved.
