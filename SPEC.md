# SPEC — Technical design

> What adloop is built from: stack, data model, API surface, pipeline contracts, and connector details. The README covers the product view; this document covers the implementation.

## 0. Stack & repo layout

- **Next.js 15 (App Router, TypeScript), Tailwind, shadcn/ui** — one app for UI and API routes.
- Persistence: **JSON files under `data/`** — no database dependency, no hosting constraint. The app runs as a persistent Node process so state and long-running requests never hit serverless limits.
- LLM: **Anthropic SDK**, default `claude-sonnet-5` everywhere, at most one Critic rewrite cycle per copy. Model routing is configurable per stage via env.
- Structure:

```
engine/            # generic, open source
  skills/          # *.md prompt modules (research, angles, copy, critic, creative-brief, mining)
  agents/          # TS orchestration per pipeline stage
  connectors/      # firecrawl.ts, fal.ts, meta.ts, elevenlabs.ts
  playbooks/       # media-buying styles as swappable modules
brands/            # data layer — local and private (repo is public):
  _example/        # the only versioned brand (fictional, documents the structure)
  <slug>/          # real brands stay untracked; added via onboarding
app/               # Next.js UI + API routes
data/              # JSON store / run artifacts (gitignored)
```

## 1. Data model (TypeScript types)

```ts
Brand      { slug, name, url, product, conversionGoal: 'website_lead',   // currently fixed: website lead via pixel; chat_start/purchase are on the roadmap
             targetCpa, guardrails: string[], designTokens,
             meta: { adAccountId, pageId, pixelId, leadEventName,        // required assets for the Publisher
                     geoCountries, optimizationGoal: 'OFFSITE_CONVERSIONS',
                     billingEvent: 'IMPRESSIONS', specialAdCategories: [],
                     fixedDailyBudgetCents,                              // set by a human up front; code treats it as immutable (hard stop)
                     campaignId?, adsetId?,                              // stored after first creation -> idempotent publish
                     campaignTarget?: { metric: 'CPL'|'CPA', value } } } // per-campaign target; brand.targetCpa is the fallback/default
Evidence   { id, brandSlug, tag: 'real'|'external'|'hypothesis', source, text, createdBy }
Angle      { id, brandSlug, name, segment, pain, mechanism, hookDirection,
             status: 'draft'|'approved'|'testing'|'validated'|'killed',
             expectedCpl?, measuredCpl?, rationale }
Asset      { id, angleId, kind: 'ad_copy'|'static'|'lp', payload(json),
             criticScore?, criticNotes?, status: 'draft'|'approved'|'rejected'|'published',
             metaIds?: { creativeId?, adId? } }
Run        { id, brandSlug, stage, angleId?, log(jsonl), startedAt, finishedAt,
             status?: 'running'|'finished'|'failed', error?, result? }   // feeds the live ticker + job status
Learning   { id, brandSlug, source: 'meta_insights'|'human_review',
             pattern, evidenceRefs, appliedToSkill? }
```

Angle diversity is enforced at the schema level: the Strategist must produce pairwise-distinguishable `hookDirection`/`segment`/`pain` combinations — concepts, not cosmetic variants.

## 2. API routes (Next.js route handlers)

- `POST /api/onboard` `{ url, name?, product? }` → Scout run → Brand + Evidence (unified research doc)
- `POST /api/brands/:slug/angles/generate` → Strategist (n angles, default 5)
- `POST /api/angles/:id/approve | kill`
- `POST /api/angles/:id/assets/generate` `{ model? }` → Copywriter → Critic → Designer (asset pair); optional `model` selects a curated fal.ai model from `FAL_MODELS`
- `POST /api/assets/:id/approve | reject | regenerate`
- `POST /api/brands/:slug/publish` → Publisher: create missing campaign/ad set once (IDs stored on the brand), publish approved assets as ads. Idempotent: idempotency key per asset, `status: PAUSED` is enforced server-side on creation (request values are ignored), double-click/retry never creates duplicates. Activation is NEVER part of publish — it is a deliberate human click on the status route (or in Ads Manager)
- `POST /api/campaigns/:id/status` `{ status: 'ACTIVE'|'PAUSED' }` → human gate: delivery toggle for a campaign or ad, admin-guarded; accepts only IDs from its own store. Real Meta IDs go through the Graph API (`POST /{id}` with `status`); demo IDs (`demo-…`) only mutate the store
- `PATCH /api/brands/:slug` → brand editing, admin-guarded, zod-validated (`brandPatchSchema`): subset of name, url, whatsappUrl, product, targetCpa, guardrails, copyRules, cta, fallbackCopy, designTokens, meta.campaignTarget, meta.fixedDailyBudgetCents; unknown fields → 400. Writes the store and `brands/<slug>/brand.json`
- `POST /api/brands/:slug/optimize` → Analyst/mining (also the target of the n8n scheduler); measures against the resolved campaign target (`campaignTarget`, falling back to `targetCpa`)
- `GET  /api/brands/:slug/state` → everything the UI needs, including `economics.target` (polling)

Job pattern for long runs: `angles/generate`, `assets/generate`, `publish`, and `optimize` respond immediately with `202 { ok, runId }`; the work continues as a fire-and-forget promise in the Node process (persistent process, not serverless). Status (`running`/`finished`/`failed` incl. `error`) and, for the Analyst, the result (`run.result`) live on the Run and are visible via `GET /state` — the UI never waits on the HTTP response.

## 3. Pipeline stages: contracts

| # | Stage | Input → Output | Acceptance criterion |
|---|---|---|---|
| 1 | Scout | URL → research JSON (segments, awareness distribution, competitor big ideas, VoC language) + evidence rows | `POST /api/onboard` with an arbitrary URL yields a populated research doc in <90 s |
| 2 | Strategist | Brand + evidence → 5 angles (diverse, with rationale + expectedCpl) | angles appear on the board, approve works |
| 3 | Copywriter | Angle → outline → 2 copy variants (hook/primary/headline/CTA) | structured output validated (zod) |
| 4 | Critic | Copy → score (1–10) + rubric notes + rewrite if needed | score < 7 automatically triggers 1 rewrite cycle |
| 5 | Designer | Copy + brief + design tokens → 1 static (fal.ai, 4:5 only) | image URL visible in the Asset Studio |
| 6 | Publisher | Approved assets → Meta: 1 campaign (OUTCOME_LEADS, CBO, Advantage+ broad) + ad set + creatives + ads, **all PAUSED** | ads visible in the real Ads Manager |
| 7 | Analyst | Insights JSON → winners/losers + learnings + angle recommendation | TWO-PART (freshly paused ads produce no data — physics): (a) real insights read against the account as connectivity proof, (b) mining run on a clearly labeled, realistic insights fixture. Never presented as live optimization |

Guardrails/language rules from `brands/<slug>/guardrails.md` are given to BOTH the Critic and the Copywriter as context.

## 3b. Playbooks, naming & attribution

- **Playbook = configurable media-buying style.** Campaign structure is NOT fixed engine behavior but a swappable module under `engine/playbooks/`. Implemented today: `single-cbo-broad` (1 CBO campaign, 1 broad ad set, creatives stacked — fits small budgets and maximum signal consolidation). Planned additions: `abo-test-plus-cbo-scale` (testing ABO per angle, winners promoted by post ID into a scaling CBO from ~10 conversions), ASC, and others. A playbook defines: campaign roles (test/scale), budget level (CBO/ABO), bid strategy, ad-set logic, kill/winner rules, scaling step. A brand selects its playbook via config.
- **Naming convention** (utility with build + parse, underscore delimiter, no spaces): Campaign `{BRAND}_{ROLE}_{OBJECTIVE}_{BUDGETLEVEL}_{BIDSTRATEGY}_{YYYYMMDD}` · Ad set `{BRAND}_{AUDIENCE}_{GEO}_{ANGLEID}` · Ad `{BRAND}_{ANGLEID}_{ASSETID}_{FORMAT}_{VERSION}`. Angle/asset IDs in names are foreign keys into the store.
- **Attribution: IDs first, names as redundancy.** Create responses return campaign_id/adset_id/ad_id → persist immediately; insights mapping runs ONLY via ad_id → asset → angle (anyone can rename objects in Ads Manager, IDs never change). Additionally `url_tags` at the creative level with Meta macros (`utm_campaign={{campaign.id}}&utm_content={{ad.id}}`) for the landing-page/CRM loop. Planned: `adlabels` (`engine:v1`, `hyp:<id>`) as a rename-proof marker for engine-owned objects.

## 4. Skills (`engine/skills/*.md`)

- `research.md` — the classic direct-response research questions + awareness distribution + VoC extraction
- `angles.md` — angle schema, diversity requirement, evidence references, test hypothesis
- `copy.md` — outline-first, few-shot from the brand's winner library (blank slate: starts empty, grows through validated tests), output schema
- `critic.md` — rubric: scroll-stop hook, ad→LP congruence, awareness match, mechanism, pain dimensionalization, specificity + guardrails; score + prioritized fixes
- `creative-brief.md` — static brief for fal.ai (image idea, text-in-image max 8 words, brand tokens, format)
- `mining.md` — winner/loser classification ONLY via own campaign IDs/name prefix, with minimum thresholds (spend/impressions/leads) against small-sample noise; CPL over CTR; map `actions` lists explicitly to the brand's lead `action_type` (normalize strings → numbers, handle 0-spend/0-lead cases deterministically)

## 5. Connectors (first-party SDKs only)

- **Firecrawl:** npm `@mendable/firecrawl-js`, `FIRECRAWL_API_KEY`. `scrape(url, formats:[{type:'json', schema}])` + `search('<brand> reviews', {scrapeOptions})` for the outside view (review sites, third-party mentions). The Scout is a separate, non-blocking path — the rest of the pipeline never depends on it.
- **fal.ai:** `@fal-ai/client`, `FAL_KEY`. `fal.subscribe(...)` with **one thin adapter per model** (different models have different input contracts, e.g. `aspect_ratio` vs `image_size`) — switching models is an adapter selection, not just an env switch.
- **Meta:** the runtime publisher talks **directly to Graph API v25** (`connectors/meta.ts`, `META_ACCESS_TOKEN` system-user token + `META_AD_ACCOUNT_ID`). Publish order per asset: download the generated image → `POST /act_<id>/adimages` → `image_hash` into the creative (with `page_id`, link, CTA, message) → `POST /ads` (PAUSED). Campaign: `OUTCOME_LEADS` with `daily_budget` = `fixedDailyBudgetCents` (fixed by a human up front) and `bid_strategy=LOWEST_COST_WITHOUT_CAP` (required by v25 on CBO create), `special_ad_categories: []`; ad set with `geo_locations`, `optimization_goal`, `billing_event`, `promoted_object` (pixel + event). Insights: `GET /act_<id>/insights?level=ad` filtered to the engine's own campaign_id.
- **ElevenLabs (roadmap):** `@elevenlabs/elevenlabs-js`, `ELEVENLABS_API_KEY`, one call: briefing text → mp3. Connector scaffold exists; the audio briefing feature is planned.
- **n8n:** separate 3-node workflow (Schedule → HTTP POST `/api/brands/<slug>/optimize` → notification). Export JSON lives in the repo under `integrations/n8n/`.

Env vars: see `.env.example` — every key is documented inline with its source.

## 6. UI (Mission Control)

1. **Board** — angle kanban (5 columns by status); card: name, segment, hook direction, expectedCpl/measuredCpl, approve/kill buttons
2. **Studio** — asset-pair cards: static preview in a Meta-feed frame + copy + critic score; approve/reject/regenerate
3. **Ticker** — run-log stream (polling `/state`), "agent X is doing Y" lines
4. **Economics** — tiles: spend, leads, CPL (account history live from insights), target function (CPA cap from brand config), winner/loser list, learnings feed

Look: dark mission-control theme, few large numbers, mint accent.

## 7. Deploy

- **Persistent Node process** over serverless: no function timeouts, JSON state works in the process/disk context (ephemeral until redeploy — acceptable for a demo deployment). A `Dockerfile` and `render.yaml` are included; auto-deploy from the main branch.
- **Mutation guard is mandatory in public deployments:** publish/optimize/approve only with `x-admin-secret: $ADLOOP_ADMIN_SECRET` (otherwise the Meta token hangs off open routes on the public internet). Read routes (`/state`, UI) stay open.
- Development stays local (fastest loops); the deployment tracks the same main branch.
