# adloop — Konzept v2 (Stand Sa 25.07.)

> Finaler Name: **adloop** (mit Lenn entschieden).

## 1. Die Idee in einem Satz

Eine agentische Paid-Ads-Engine, an die sich **jedes Unternehmen per Plug-and-play anschließen** lässt (URL + Produktbeschreibung + Meta-Konto): Sie recherchiert, formuliert testbare Angle-Hypothesen, generiert konzeptdiverses Creative-Material am Fließband, published es als echte Meta-Ads (paused) und **lernt aus den Performance-Daten des gesamten Ad-Kontos** — mit dem Ziel kontinuierlich sinkender CAC.

**Pitch-Kern:** Selbst die führenden kommerziellen Agentic-Marketing-Plattformen (bis 5.000 $/Monat) haben den voll geschlossenen Daten-Loop Stand Juli 2026 nicht im Produkt — Branchenschätzung: 6–12 Monate entfernt. Wir zeigen heute einen funktionierenden Pattern-Mining-Loop mit Human-Gate. loyft ist der echte Erstnutzer und startet bewusst **blank slate**: kein Alt-Kampagnen-Import, keine historischen Zahlen im Pitch — die Engine baut die Akquise von Grund auf neu, live, mit echtem Konto.

## 2. Strategischer Rahmen (Entscheidungen Linus/Lenn)

- **Play to Win:** Top 8 + Preis. Sponsor-Tools substanziell und ehrlich einbinden.
- **Plug-and-play + komplett Open Source:** Alles Firmen-Spezifische ist Daten (`brands/<slug>/`), nie Code. Onboarding minimal: URL + Produkteintrag, den Rest recherchiert die Engine agentisch selbst.
- **Meta-Strategie = Default der Engine (von Linus, durch Andromeda-Research extern bestätigt):** EINE Leads-Kampagne, Advantage+/Broad, kein manuelles Targeting, kein Retargeting. Der Meta-Algorithmus baut die Journey; **unsere einzige Aufgabe ist konzeptdiverses Arbeitsmaterial** (echte Hook/Angle/Format-Unterschiede — Meta kollabiert kosmetische Varianten) plus regelmäßiger Fatigue-Refresh (50/30/20-Kadenz).
- **Kein PostHog, keine Firmen-Interna im Loop:** Meta Insights API ist die einzige Feedback-Quelle — universell für jeden mit Ad-Konto.
- **Kein autonomes Budget-Management:** Hat selbst das Original nicht. Human-Gate für Approves und Aktivierung; Publish immer PAUSED.
- **Geschäftsmodell-Generalisierung:** Unterschied D2C vs. loyft-artig steckt in genau zwei Config-Feldern: Conversion-Ziel (Purchase/Lead/Chat-Start) und Creative-Inszenierung (Produkt-Shot vs. Chat-Demo). B2B klammern wir bewusst aus (macht das Original auch).

## 3. Architektur: Skills + Memory + Mining

Kein Fine-Tuning, kein Wrapper. Drei Schichten:

1. **Brand-Kontext** (`brands/<slug>/`): Unified Research Document + Zielfunktion + Guardrails + Winner-Bibliothek (wächst erst durch eigene Tests) + Design-Tokens. Beim Onboarding aus URL/Reviews agentisch erzeugt (Firecrawl) — auch für loyft: Blank Slate, der Scout recherchiert live; das Seed-Paket liefert nur Produkt-Fakten, Ziele und Regeln.
2. **Skills** (wenige, dichte Prompt-Module — Prinzip: wenige kondensierte schlagen viele granulare): Research-Skill, Angle-Skill, Copy-Skill, Critic-Rubrik, Creative-Brief-Skill. Liegen als Markdown im Repo → maschinell aktualisierbar.
3. **Mining-Loop:** Ad-Level-Insights des **gesamten Kontos** ziehen → Winner/Loser klassifizieren → Muster extrahieren → als Learnings ins Brand-Evidence + Skill-Updates schreiben → nächster Batch generiert „more like the winners“. Approvals/Rejects des Menschen werden als Signal mitgeloggt.

## 4. Pipeline (7 Stufen, je Agent)

1. **Scout:** Firecrawl (`/v2/scrape` mit JSON-Schema + `/v2/search` für Reviews) → Unified Research Document: Zielgruppen-Psychographie, Competitor-Big-Ideas, **prozentuale Awareness-Verteilung**, VoC-Sprache.
2. **Strategist:** Angles als First-Class-Objekte (Segment × Schmerz × Mechanism × Hook-Richtung), Status `draft → approved → testing → validated/killed`, erzwungene Konzept-Diversität. → **Gate: Mensch approved.**
3. **Copywriter:** Outline → Copy (nie direkt Copy — bewährte Direct-Response-Praxis), Few-Shot aus Winner-Bibliothek, strukturierter Output (Hook/Primary/Headline/CTA).
4. **Critic („Copy Chief“):** separater Agent, Score + Kritik vor Rewrite. Rubrik: Scroll-Stop-Hook (2–3 Sek.), Ad→LP-Kongruenz, Awareness-Level-Match, Mechanism, Pain-Dimensionalisierung, Spezifität + Brand-Guardrails (UWG, Sprachregeln).
5. **Designer:** Statics via Fal (`fal.subscribe()`, Modell: Nano Banana Pro oder GPT Image 2 für Text-Rendering; Wechsel = Einzeiler). Variationsmodi wie das Original: *new visuals/same message*, *same look/fresh copy*, *full refresh*.
6. **Publisher:** Offizieller **Meta Ads MCP** (`mcp.facebook.com/ads`, OAuth) — Campaign (einmalig, OUTCOME_LEADS, CBO, broad) + Creatives + Ads, alles PAUSED. Backup: direkte Graph-v25-Calls mit System-User-Token. → **Gate: Aktivierung nur durch Mensch.**
7. **Analyst (Mining):** Insights je Ad (laufende eigene Tests) → Winner/Loser → Muster → Evidence-Update + nächste Angle-Empfehlungen. **Optimiert auf CPL/CPA, nie CTR** (Klicks ≠ Kunden — Branchen-Grundregel im Mining-Skill). Vertontes 30-Sek-Briefing via ElevenLabs.

Orchestrierung/Scheduler: **n8n** (Schedule → HTTP auf `/optimize`; Bonus: MCP-Server-Trigger exponiert `run_pipeline(url)` als MCP-Tool). Landingpages (Message-Match: Ad-Headline == LP-Headline) als statische Routen der eigenen App — Should-Scope.

## 5. Mission Control (UI)

Vier Ansichten: **Hypothesen-Board** (Angle-Kanban mit erwartetem vs. gemessenem CPL) · **Asset-Studio** (Ad-Preview + LP-Preview als Paar, Approve/Reject/Regenerate) · **Live-Ticker** (Agenten-Streaming) · **Economics** (CPL × L2C → CPA gegen Zielfunktion — Carlos' Sprache: Deckungsbeitrag, nicht ROAS-Vanity). Dunkles Mission-Control-Theme, wenige große Zahlen; Design-Führung Lenn.

## 6. Sponsor-Mapping (alle fünf + Meta, nur First-Party-Wege)

| Stufe | Tool | Weg |
|---|---|---|
| Research | **Firecrawl** | Node-SDK v2 (scrape+JSON-Schema, search); MCP zusätzlich in Cursor |
| Creatives | **Fal** | `@fal-ai/client`, Nano Banana Pro / GPT Image 2 |
| Publish + Insights | Meta | offizieller Ads MCP (OAuth); Backup Graph v25 + System-User-Token |
| Scheduler/MCP-Trigger | **n8n** | Schedule→HTTP-Loop (3 Nodes); MCP Server Trigger |
| Audio-Briefing + Video-VO | **ElevenLabs** | offizieller MCP / JS-SDK |
| Agentische Entwicklung | **Cursor** | CLI headless (`agent -p`), `.cursor/rules` + MCP-Config im Repo als Beleg |

## 7. Scope (4–5 h effektiv — Play to Win heißt: fertig werden)

- **Must (bis 13:00):** Onboarding (loyft-Seed + beliebige URL) → Angles → Copy+Critic → 1 Static/Angle → Publish PAUSED ins echte Konto → Mission Control (Board, Ticker, Asset-Ansicht).
- **Should (bis 15:00):** Analyst mit echtem Insights-Read (Demo mit frisch angelegten Test-Ads), Economics-Screen, n8n-Loop, ElevenLabs-Briefing, LP-Routen.
- **Could:** Live-Onboarding einer fremden Brand im Pitch, Cursor-CLI-Live-Beleg, **Voice-Mode** („Talk to your media buyer“: ElevenLabs-Agent als Sprach-Interface — briefen, Angles anstoßen, Briefing anhören; Demo-Stunt mit Skript-Fallback, erst NACH stabilem Must-Slice).
- **Won't:** Video-Ads, Budget-Automation, Multi-Channel, B2B, CRO-Modul, eigene Developer-API.

## 8. Bewertungs-Fit

Real Problem Solving 30 %: jeder, der von Ads lebt, hat steigende CAC + manuelles Testing; wir sind selbst zahlender Nutzer. · Tech & AI 30 %: geschlossener Mining-Loop + 5 Sponsor-Tools substanziell + echter Meta-Write. · Execution 25 %: ein Slice, end-to-end, zweimal durchgetestet. · Presentation 15 %: Live-Onboarding-Stunt + echte Zahlen. Kernbotschaft: „Die Maschine testet, der Mensch entscheidet — und sie wird jede Woche billiger.“ Kein „KI ersetzt Kreative“-Framing: die Engine skaliert menschliche Winner, sie ersetzt sie nicht.
