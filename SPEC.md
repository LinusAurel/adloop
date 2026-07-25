# SPEC — Build-Anleitung für den Hackathon-Tag

> Zweck: Diese Spec ist das Briefing für die Coding-Agents. Sie beschreibt WAS gebaut wird und in welcher Reihenfolge. Kein vorgebauter Code — Regelkonformität: Konzept/Notizen erlaubt, projektspezifischer Code entsteht erst am Tag.

## 0. Stack & Repo-Layout

- **Next.js 15 (App Router, TS), Tailwind, shadcn/ui** — eine App für UI + API-Routen.
- Persistenz: **JSON-Files unter `data/`** (ENTSCHIEDEN — kein Drizzle/SQLite, kein Hosting-Zwang; die App läuft am Demo-Tag lokal, damit State und lange Requests nie an Serverless-Limits sterben).
- LLM: **Anthropic SDK**, Default überall **claude-sonnet-5** (schnell), **max. 1 Critic-Rewrite-Zyklus**. Model-Routing bleibt per Env konfigurierbar, aber teure Modelle sind für den Demo-Slice bewusst aus.
- Struktur:

```
engine/            # generisch, open source
  skills/          # *.md Prompt-Module (research, angles, copy, critic, creative-brief, mining)
  agents/          # TS-Orchestrierung je Pipeline-Stufe
  connectors/      # firecrawl.ts, fal.ts, meta.ts, elevenlabs.ts
brands/
  loyft/           # Daten-Layer (Seed liegt vor), weitere Brands via Onboarding
app/               # Next.js UI + API-Routen
data/              # SQLite / Run-Artefakte (gitignored)
```

## 1. Datenmodell (TS-Types / Drizzle-Tabellen)

```ts
Brand      { slug, name, url, product, conversionGoal: 'website_lead',   // heute fix: Website-Lead via Pixel; chat_start/purchase sind Post-Hackathon
             targetCpa, guardrails: string[], designTokens,
             meta: { adAccountId, pageId, pixelId, leadEventName,        // Pflicht-Assets für Publisher
                     geoCountries: ['DE'], optimizationGoal: 'OFFSITE_CONVERSIONS',
                     billingEvent: 'IMPRESSIONS', specialAdCategories: [],
                     fixedDailyBudgetCents,                              // von Linus VORAB gesetzt, Code behandelt ihn als unveränderlich (Hard Stop 4)
                     campaignId?, adsetId? } }                           // nach Erst-Anlage gespeichert -> idempotenter Publish
Evidence   { id, brandSlug, tag: 'real'|'external'|'hypothesis', source, text, createdBy }
Angle      { id, brandSlug, name, segment, pain, mechanism, hookDirection,
             status: 'draft'|'approved'|'testing'|'validated'|'killed',
             expectedCpl?, measuredCpl?, rationale }
Asset      { id, angleId, kind: 'ad_copy'|'static'|'lp', payload(json),
             criticScore?, criticNotes?, status: 'draft'|'approved'|'rejected'|'published',
             metaIds?: { creativeId?, adId? } }
Run        { id, brandSlug, stage, log(jsonl), startedAt, finishedAt }   // füttert Live-Ticker
Learning   { id, brandSlug, source: 'meta_insights'|'human_review',
             pattern, evidenceRefs, appliedToSkill? }
```

Angle-Diversität ist Schema-Pflicht: Der Strategist muss `hookDirection`/`segment`/`pain` paarweise unterscheidbar belegen (Andromeda: Konzepte, keine Varianten).

## 2. API-Routen (Next.js route handlers)

- `POST /api/onboard` `{ url, name?, product? }` → Scout-Run → Brand + Evidence (Unified Research Doc)
- `POST /api/brands/:slug/angles/generate` → Strategist (n Angles, default 5)
- `POST /api/angles/:id/approve | kill`
- `POST /api/angles/:id/assets/generate` → Copywriter→Critic→Designer (AssetPair)
- `POST /api/assets/:id/approve | reject | regenerate`
- `POST /api/brands/:slug/publish` → Publisher: fehlende Kampagne/AdSet anlegen (einmalig, IDs in Brand speichern), approved Assets als Ads PAUSED. Idempotent: Idempotency-Key pro Asset, `status: PAUSED` wird SERVERSEITIG erzwungen (Request-Werte werden ignoriert), Doppel-Klick/Retry erzeugt keine Duplikate
- `POST /api/brands/:slug/optimize` → Analyst/Mining (auch Ziel des n8n-Schedulers)
- `GET  /api/brands/:slug/state` → alles fürs UI (polling reicht; SSE nur wenn trivial)

## 3. Pipeline-Stufen: Verträge & Abnahme

| # | Stufe | Input → Output | Abnahme-Kriterium |
|---|---|---|---|
| 1 | Scout | URL → Research-JSON (Segmente, Awareness-%-Verteilung, Competitor-Big-Ideas, VoC-Sprache) + Evidence-Rows | `POST /api/onboard` mit fremder URL liefert in <90 s ein befülltes Research-Doc |
| 2 | Strategist | Brand+Evidence → 5 Angles (divers, mit rationale + expectedCpl) | Angles erscheinen im Board, Approve funktioniert |
| 3 | Copywriter | Angle → Outline → 2 Copy-Varianten (Hook/Primary/Headline/CTA) | strukturierter Output validiert (zod) |
| 4 | Critic | Copy → Score (1–10) + Rubrik-Notes + ggf. Rewrite | Score < 7 triggert automatisch 1 Rewrite-Zyklus |
| 5 | Designer | Copy+Brief+Design-Tokens → 1 Static (Fal, NUR 4:5) | Bild-URL im Asset-Studio sichtbar |
| 6 | Publisher | approved Assets → Meta: 1 Kampagne (OUTCOME_LEADS, CBO, Advantage+ broad) + AdSet + Creatives + Ads, **alle PAUSED** | Ads im echten Ads Manager sichtbar (Screenshot für Video) |
| 7 | Analyst | Insights-JSON → Winner/Loser + Learnings + Angle-Empfehlung | ZWEITEILIG (pausierte frische Ads liefern keine Daten — physikalisch): (a) echter Insights-Read gegen das Konto als Konnektivitätsbeweis, (b) Mining-Demo auf einer klar als solche gelabelten, realistischen Insights-Fixture. Nie als Live-Optimierung verkaufen |

Guardrails/Sprachregeln aus `brands/<slug>/guardrails.md` werden Critic UND Copywriter in den Kontext gegeben (doppelt hält besser).

## 4. Skills (engine/skills/*.md — am Tag schreiben, Quellen liegen bereit)

- `research.md` — die 7 klassischen Direct-Response-Research-Fragen + Awareness-Verteilung + VoC-Extraktion
- `angles.md` — Angle-Schema, Diversitäts-Pflicht, Evidence-Verweise, Test-Hypothese
- `copy.md` — Outline-first, Few-Shot aus der Winner-Bibliothek der Brand (Blank Slate: startet leer, wächst durch validierte Tests), Output-Schema
- `critic.md` — Rubrik: Scroll-Stop-Hook, Ad→LP-Kongruenz, Awareness-Match, Mechanism, Pain-Dimensionalisierung, Spezifität + Guardrails; Score + priorisierte Fixes
- `creative-brief.md` — Static-Brief für Fal (Bildidee, Text-im-Bild max. 8 Wörter, Brand-Tokens, Format)
- `mining.md` — Winner/Loser-Klassifikation NUR über eigene Kampagnen-IDs/Namens-Prefix, mit Mindest-Schwellen (Spend/Impressions/Leads) gegen Kleinstmengen-Zufall; CPL statt CTR; `actions`-Listen explizit auf den Lead-`action_type` der Brand mappen (Strings → Zahlen normalisieren, 0-Spend/0-Lead-Fälle definiert behandeln)

## 5. Connectoren (First-Party only)

- **Firecrawl:** npm `@mendable/firecrawl-js` (Paketname prüfen — NICHT `firecrawl` annehmen), `FIRECRAWL_API_KEY`. `scrape(url, formats:[{type:'json', schema}])` + `search('<brand> bewertungen trustpilot', {scrapeOptions})`. Scout ist ein separater, NICHT-blockierender Pfad — der loyft-Demo-Slice hängt nie an Firecrawl.
- **Fal:** `@fal-ai/client`, `FAL_KEY`. `fal.subscribe(...)` mit **einem dünnen Adapter pro Modell** (Nano Banana Pro: `aspect_ratio`; GPT Image 2: `image_size` + anderer Input-Vertrag) — Modellwechsel ist Adapter-Auswahl, kein reiner Env-Switch.
- **Meta:** Runtime-Publisher ist AUSSCHLIESSLICH **Graph API v25 direkt** (`connectors/meta.ts`, `META_ACCESS_TOKEN` System-User + `META_AD_ACCOUNT_ID`). Der Meta Ads MCP ist ein Client-Werkzeug (autorisiert den MCP-Client, nicht unsere App) — er dient nur als separater Sponsor-/Analyse-Beleg, nie als App-Connector. Reihenfolge pro Publish: Fal-Bild herunterladen → `POST /act_<id>/adimages` → `image_hash` ins Creative (mit `page_id`, Link, CTA, Message) → `POST /ads` (PAUSED). Kampagne: `OUTCOME_LEADS` mit `daily_budget` = `fixedDailyBudgetCents` (vorab menschlich fixiert), `special_ad_categories: []`; AdSet mit `geo_locations`, `optimization_goal`, `billing_event`, `promoted_object` (Pixel + Event). Insights: `GET /act_<id>/insights?level=ad` gefiltert auf die EIGENE campaign_id.
- **ElevenLabs:** `@elevenlabs/elevenlabs-js`, `ELEVENLABS_API_KEY`, ein Call: Briefing-Text → mp3. Could-Ausbau **Voice-Mode**: ElevenLabs-Agents-Widget (WebRTC, STT+TTS out of the box) im Mission Control einbetten; Agent-Tools per Webhook auf unsere API-Routen (`angles/generate`, `state`) — Zwei-Wege-Dialog ohne eigene Audio-Pipeline. Nur bauen, wenn Must+Should stehen; Live-Demo mit Mikro ist WLAN-Risiko → Video-Fallback.
- **n8n:** separater 3-Node-Workflow (Schedule → HTTP POST `/api/brands/loyft/optimize` → Notification). Export-JSON ins Repo unter `integrations/n8n/`.

Env-Vars gesamt: `ANTHROPIC_API_KEY, FIRECRAWL_API_KEY, FAL_KEY, ELEVENLABS_API_KEY, META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, MODEL_STRATEGIST, MODEL_COPY, FAL_MODEL_ID`.

## 6. UI (Mission Control, 4 Views, eine Page mit Tabs reicht)

1. **Board** — Angle-Kanban (5 Spalten nach Status), Karte: Name, Segment, Hook-Richtung, expectedCpl/measuredCpl, Approve/Kill-Buttons
2. **Studio** — AssetPair-Karten: Static-Preview im Meta-Feed-Rahmen + Copy + Critic-Score; Approve/Reject/Regenerate
3. **Ticker** — Run-Log-Stream (polling auf `/state`), „Agent X macht Y“-Zeilen
4. **Economics** — Kacheln: Spend, Leads, CPL (Konto-Historie live aus Insights), Zielfunktion (CPA-Grenze aus Brand-Config), Winner/Loser-Liste, Learnings-Feed; Audio-Briefing-Play-Button

Look: dunkel, wenige große Zahlen, Mint-Akzent (#00FF7F) — Lenn entscheidet final.

## 7. Build-Reihenfolge am Tag (parallele Agent-Streams)

- **Stream A (Backbone):** Schema + `/state` + Board-UI-Gerüst → dann Stufe 2 (Strategist mit loyft-Seed, ohne Scout) → Stufe 3+4 → Stufe 5
- **Stream B (Meta):** `connectors/meta.ts` + Publish-PAUSED mit Dummy-Creative testen (⚠️ Meilenstein 12:30) → Insights-Read
- **Stream C (Scout):** Firecrawl-Onboarding (kann als letztes Must landen — loyft läuft aus dem Seed)
- **Stream D (Lenn):** UI-Polish, Deck, Video-Regie
- Reihenfolge-Prinzip: **Der Demo-Pfad wird von hinten nach vorne abgesichert** — Publish zuerst beweisen, dann verschönern.

## 8. Fallbacks (vorab entschieden, keine Tages-Diskussion)

| Risiko | Fallback |
|---|---|
| **Pre-Flight 09:00 (PFLICHT, vor jeder Code-Zeile):** minimaler echter PAUSED-Campaign-Create per curl gegen das Konto (Token, App-Zugang, Zahlungsmethode, Assets). Scheitert er → sofort Fallback-Leiter, nicht erst 12:30 | — |
| Meta-Write klemmt trotz Pre-Flight | Sandbox-Ad-Account; letzter Ausweg: `generatepreviews` + Payload sichtbar im UI — im Pitch EXPLIZIT als degraded demo benennen |
| Auch Token-Weg klemmt | Sandbox-Ad-Account; letzter Ausweg: `generatepreviews` + vorbereiteter Payload sichtbar im UI |
| Fal-Modell schwächelt bei Text im Bild | Modell-Switch per Env; notfalls Bild ohne Text + CSS-Overlay im Preview |
| Firecrawl-Limit/Ausfall | loyft-Seed trägt die Demo; Fremd-URL-Stunt streichen |
| Zeit läuft weg | Scope-Leiter rückwärts: LP-Routen → n8n → ElevenLabs → Scout streichen; der Loop (2→6→7) bleibt unantastbar |
```
