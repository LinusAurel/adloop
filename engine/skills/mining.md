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

## Entscheidungsregeln (Interpretation der Klassifikation)

- **Keine Signifikanz unter den Schwellen:** unter 20 € Spend oder unter 3
  Leads gibt es keine Aussage — auch keine „Tendenz“. `insufficient_data`
  heißt: weiterlaufen lassen und Daten sammeln, nicht anfassen, nicht
  interpretieren.
- **CPL gegen das Kampagnen-Ziel, nicht gegen Gefühl:** bewertet wird
  ausschließlich CPL vs. `targetCpa` der Brand. Ein hoher CTR oder billige
  Klicks retten keinen Loser — Klicks sind kein Ziel, Leads sind es.
- **Winner skalieren = neue Varianten desselben Angles:** die Empfehlung ist
  immer, 2 neue Hook-/Copy-Varianten des Winner-Angles zu testen — der Angle
  ist validiert, variiert wird die Ausführung. Nie Budget-Empfehlungen
  aussprechen oder umsetzen (Hard Stop 4).
- **Loser killen = Learning mit Ursachen-Hypothese:** jeder Loser wird als
  Learning festgehalten (Klassifikationsgrund in der Row); die
  Ursachen-Hypothese benennt, WAS vermutlich versagt hat: Hook stoppt nicht
  (viel Spend, wenig Klicks), Angle trifft kein reales Bedürfnis (Klicks ohne
  Leads → auch LP prüfen) oder CPL strukturell über Ziel. „Hat nicht
  funktioniert“ ohne Ursache ist kein Learning.
- **Kill und Aktivierung entscheidet der Mensch:** der Analyst legt Empfehlung
  und Learning vor, die Entscheidung fällt im Board (Hard Stop 3).

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
