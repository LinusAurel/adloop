# adloop

Turns ad data into action: watches what runs on Meta, spots creatives wearing out,
generates replacements, and publishes them — with a human in front of every expensive step.

**Conversion-goal agnostic.** Purchase, lead, traffic, engagement — the primary metric is a
numerator/denominator contract, not a hardcoded objective.

## What's in it

| | |
|---|---|
| **Chat** | agent with tools, approvals and playbooks |
| **Creative Strategist** | pulse indices, funnel position, creative strain, actions |
| **Image workshop** | generation across swappable providers, with idempotency |
| **Launch** | Meta publishing as a step chain — always `PAUSED` |

## Running it

```bash
cp .env.example .env     # fill it in
docker compose up
pnpm migrate
```

Four containers: `web`, `worker`, `db`, `storage` (MinIO). No managed service in the core —
self-hosting needs `docker compose up` and a `.env`, nothing else.

## Two hard rules

**Everything publishes as `PAUSED`.** Activation is a human decision in Ads Manager. There
is no switch, no option and no tool for it — the request schema has no status field at all.

**Only a human sets budgets.** The agent may not propose, supply or change them. Without a
budget the publish aborts with `budget_required` instead of picking a default.

## Making it yours

Colours, fonts and radii come from `theme/default.css`. A fork replaces that one file and
has its own look — no component knows a colour value. State roles (`--good`, `--warn`,
`--crit`, `--none`) carry meaning, not colour, so recolouring never changes what the UI
says.

## Bilingual by design

German and English on three independent axes: interface, agent replies, and the language of
**generated ad copy**. A German operator running English ads for the US market is the normal
case, not an edge case — so those are separate settings.

## Deploying

`render.yaml` is a Render Blueprint: dashboard → New Blueprint Instance → this repo. It
creates Postgres plus a web and a worker service, runs migrations on boot and health-checks
`/api/health`.

Two things it cannot do for you:

- **Object storage.** Render has no S3-compatible service, so the local MinIO container has
  no counterpart. Point `S3_*` at Cloudflare R2, AWS S3 or Backblaze B2.
- **Private playbooks.** `PLAYBOOK_DIR` must resolve to a mounted directory at runtime.
  Without it every agent run aborts with `playbook_missing` — deliberately, so a
  misconfigured path can never silently fall back to a synthetic fixture.

## Developing

```bash
pnpm test                  # 199 tests, sequential (Testcontainers)
pnpm test:meta-contract    # field contract against the live Meta API
pnpm test:meta-publish     # publish against a Meta sandbox ad account
```

Decisions and their reasoning: [`DECISIONS.md`](DECISIONS.md).
