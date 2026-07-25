# Skill: Mining (Analyst, Stufe 7)

Winner/Loser-Klassifikation aus Meta-Insights. Deterministisch implementiert
in `engine/agents/analyst.ts` — dieses Dokument ist die fachliche Wahrheit,
der Code setzt sie 1:1 um.

## Datenbezug

- NUR eigene Kampagnen: Insights werden mit `level=ad` gelesen und hart auf
  die persistierte `campaign_id` der Brand gefiltert. Fremde Kampagnen im
  Konto sind unsichtbar.
- Attribution läuft ausschließlich über `ad_id` → Asset → Angle (persistierte
  IDs aus dem Publish). Ad-Namen (`ADLOOP-…`-Konvention, `engine/naming.ts`)
  sind nur Human-Fallback und Parse-Hilfe für Fixtures.

## Normalisierung

- Graph liefert Zahlen als Strings (`"spend": "96.20"`) → immer in Zahlen
  wandeln; nicht parsebare Werte zählen als 0.
- Leads stecken in der `actions`-Liste. Relevante `action_type`-Werte für
  `conversionGoal: website_lead`:
  1. `lead` (Aggregat)
  2. `offsite_conversion.fb_pixel_lead` (Pixel-Teilmenge)
  Es gilt der ERSTE Treffer in dieser Prioritätsreihenfolge — niemals beide
  summieren, das würde dieselbe Conversion doppelt zählen.
- 0 Spend oder 0 Leads sind definierte Fälle, keine Fehler: CPL ist dann
  `null`, nicht `Infinity` oder `NaN`.

## Schwellen gegen Kleinstmengen-Zufall

Ein einzelner billiger Lead bei 6 € Spend ist Rauschen, kein Winner.

| Konstante | Wert | Bedeutung |
|---|---|---|
| `MIN_SPEND_EUR` | 20 | unter 20 € Spend keine Aussage |
| `MIN_LEADS` | 3 | Winner braucht mindestens 3 Leads |

## Klassifikation (CPL statt CTR, Reihenfolge ist Vertrag)

1. `spend < 20 €` → **insufficient_data** (Kleinstmengen-Schutz)
2. `leads ≥ 3` UND `cpl ≤ targetCpa` → **winner**
3. `leads = 0` (bei ≥ 20 € Spend) → **loser**
4. `cpl > targetCpa` → **loser**
5. sonst (CPL im Rahmen, aber < 3 Leads) → **insufficient_data**

`targetCpa` kommt aus `brands/<slug>/brand.json` (Beispiel: 100 €).

## Output

- Pro Winner/Loser eine Learning-Row (`source: meta_insights`, `evidenceRefs`
  = `ad_id`), dedupliziert über den Pattern-Text. Fixture-Learnings tragen
  den Präfix „[Demo-Daten]“.
- Eine Angle-Empfehlung: besten Winner ausbauen (neue Hook-Varianten),
  Loser dem Menschen zur Kill-Entscheidung vorlegen. Der Analyst entscheidet
  nie selbst über Budget oder Aktivierung (Hard Stops 3+4).

## Zweiteilung Live vs. Demo

Frisch publishte, pausierte Ads liefern physikalisch keine Insights. Darum:
(a) echter Read als Konnektivitätsbeweis („Konnektivität OK, noch keine
Daten“), (b) Mining-Demo auf `data/fixtures/insights-demo.json` — im UI immer
als „Demo-Daten“ gelabelt, nie als Live-Optimierung verkauft.

**Sprache: Alle Ausgaben auf Deutsch mit echten deutschen Umlauten (ä, ö, ü, Ä, Ö, Ü, ß) — NIEMALS ae/oe/ue-Ersatzschreibungen.**
