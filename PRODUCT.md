# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primär: die Hackathon-Jury.** Sie sieht Mission Control fünf Minuten lang auf
einem Beamer aus einigen Metern Entfernung und muss in dieser Zeit begreifen,
was der Agenten-Schwarm tut, wo der Mensch entscheidet und dass echte Ads im
echten Meta-Konto landen. Zusätzlich bewertet sie eine öffentliche Demo-URL
online, ohne Erklärung daneben. Verständlichkeit ohne Vorwissen ist deshalb die
härteste Anforderung, nicht Informationsdichte.

**Sekundär: Linus als Operator.** Er fährt die Pipeline während der Demo und
entscheidet an den Human-Gates: Angle freigeben oder verwerfen, Asset freigeben
oder ablehnen, Ad im Ads Manager aktivieren. Er kennt jede Zahl im System.

**Perspektivisch: jedes Unternehmen mit Meta-Ad-Konto.** adloop ist als
Plug-and-play-Engine angelegt (URL plus Produktbeschreibung plus Meta-Konto),
loyft ist der erste echte Nutzer, nicht der einzige gedachte.

## Product Purpose

adloop ist eine agentische Paid-Ads-Engine. Sie recherchiert eine Marke,
formuliert testbare Angle-Hypothesen, produziert konzeptdiverses
Creative-Material, published es als echte Meta-Ads im Status PAUSED und lernt
aus den Performance-Daten des gesamten Ad-Kontos, um die Kundenakquisitions-
kosten kontinuierlich zu senken.

Mission Control ist die Kanzel darüber: die eine Oberfläche, in der ein Mensch
sieht, was die Agenten gerade tun, und an drei Stellen entscheidet. Erfolg
heißt: ein Betrachter versteht den geschlossenen Kreis aus Hypothese, Test,
Messung und nächster Hypothese, ohne dass ihn jemand danebenstehend erklärt.

## Positioning

Der vollständig geschlossene Daten-Loop. Führende kommerzielle
Agentic-Marketing-Plattformen haben Stand Juli 2026 kein Pattern-Mining aus
den eigenen Ausgabendaten zurück in die nächste Creative-Generation im Produkt.
adloop zeigt genau diesen Rückkanal, mit einem Menschen als Torwächter statt
als Zuschauer.

Zweiter, technisch tragender Unterschied: Alles Firmen-Spezifische ist Daten
unter `brands/<slug>/`, niemals Code. Eine neue Marke anzuschließen ist ein
Datensatz, kein Fork. Das Projekt ist vollständig Open Source.

## Operating Context

Sieben Pipeline-Stufen, jede ein Agent: Scout (Recherche), Strategist
(Angle-Hypothesen), Copywriter, Critic (Score plus Kritik vor Rewrite),
Designer (Statics), Publisher (Meta, immer PAUSED), Analyst (Insights zu
Mustern).

Mission Control zeigt davon vier Ansichten als Tabs:

- **Board** — Angle-Hypothesen als Kanban über fünf Status (Entwurf,
  Freigegeben, Im Test, Validiert, Verworfen), mit erwartetem gegen gemessenen
  CPL und den Aktionen Freigeben und Verwerfen. Das ist der Demo-Einstieg.
- **Studio** — Ad-Creative und Copy als Paar, im Meta-Feed-Rahmen, mit
  Critic-Score und den Aktionen Freigeben, Ablehnen, Neu erzeugen.
- **Ticker** — Live-Log der Agenten, was welcher Agent gerade tut.
- **Economics** — Spend, Leads, CPL gegen die Zielfunktion der Marke, plus
  Winner-Loser-Liste und Learnings.

Drei Human-Gates sind fachlich verbindlich und dürfen nie automatisiert
werden: Angle-Freigabe, Asset-Freigabe, Ad-Aktivierung.

Betriebsrealität am Demo-Tag: Die App läuft lokal für die echten Läufe und als
Render-Web-Service unter einer öffentlichen Demo-URL für die Bewertung. Der
Zustand liegt in JSON-Dateien und ist auf Render nicht dauerhaft.

## Capabilities and Constraints

Datenmodell (steht, in `engine/types.ts`): Brand, Evidence (getaggt als real,
extern oder Hypothese), Angle (Status draft, approved, testing, validated,
killed), Asset (ad_copy, static oder lp, mit criticScore und Status draft,
approved, rejected, published), Run (Log-Zeilen für den Ticker), Learning.

Technische Randbedingungen:

- Next.js 15 mit App Router, TypeScript, Tailwind, shadcn/ui.
- Zustand als JSON-Dateien unter `data/`, ein einziger schreibender Prozess.
- Statics ausschließlich im Format 4:5.
- UI-Texte auf Deutsch, echte Umlaute, `Du` und seine Formen großgeschrieben.

Fachliche Grenzen, die kein Design aufweichen darf:

- Jeder Meta-Publish erfolgt im Status PAUSED. Aktivierung macht ausschließlich
  ein Mensch im Ads Manager.
- Kein Budget- oder Spend-Management durch Agenten.
- Optimiert wird auf CPL und letztlich CPA, nie auf CTR. Hohe Klickraten ohne
  Leads sind ein Warnzeichen, kein Erfolg.

Stand heute noch offen: Die Pipeline-Agenten und die Skills existieren noch
nicht, alle verändernden API-Routen antworten mit 501, nur das Auslesen des
Zustands funktioniert. Die Meta-Konto-IDs in `brands/loyft/brand.json` sind
leer. Mission Control muss also vollständig leere Zustände tragen können.

## Brand Commitments

Der Produktname ist **adloop**, die Oberfläche heißt **Mission Control**.
Mission Control trägt adloops eigene Identität; loyft ist der Inhalt darin,
nicht der Absender (vom Nutzer bestätigt).

Vom Nutzer als bindend gesetzte visuelle Vorgabe, hier nur protokolliert:
Mint `#00FF7F` ausschließlich als Signal-Akzent für Status und Aktionen.
Ausgeschlossen sind generische KI-Ästhetik, Inter als Standardschrift,
violette Farbverläufe und Karten in Karten.

Für alles, was die Engine **für loyft erzeugt** (Ad-Copy, Landingpages), gelten
loyfts eigene Sprachregeln aus `brands/loyft/guardrails.md`: loyft immer klein,
`Du` groß, keine Gedankenstriche in kundengerichteter Copy, kein Erwähnen von
KI, Begriff „Sparservice“, deutsches Zahlenformat. Diese Regeln binden den
Inhalt, nicht die Oberfläche.

## Evidence on Hand

Vorhanden im Repo: `KONZEPT.md` (fachliche Wahrheit), `SPEC.md` (Bauplan),
`brands/loyft/` mit README, `brand.md`, `zielfunktion.md`, `guardrails.md`,
`design-tokens.md` und `brand.json`.

Echte, belegte Zahlen, die in der Demo verwendet werden dürfen: loyft erlöst
rund <zielwert> € netto pro Wechsel, daraus folgt die harte CPA-Grenze von <zielwert> € und
der Zielkorridor <zielkorridor> €; der geplante CPL-Pfad ist <cpl-pfad>.
Marktdaten: 41,2 Mio. Haushalte in Deutschland, 86 % der Stromkunden wechseln
nicht, rund 23 % stecken in der Grundversorgung (BNetzA-Monitoringbericht 2025).

**Absichtliche Lücken, die niemand erfinden darf.** loyft startet bewusst als
Blank Slate: Es gibt keine historischen Kampagnen-Ergebnisse, keine
Winner-Ads, keine Personas, keine CPL-Baselines und keinen belegbaren
Kunden-Social-Proof in nennenswerter Menge. Frisch angelegte pausierte Ads
liefern physikalisch keine Insights, deshalb muss jede Mining-Demo auf einer
klar als solche gekennzeichneten Fixture laufen und darf nie als
Live-Optimierung dargestellt werden.

Creative-Asset laut loyfts Creative-Gesetz ist ein echtes Gründer-Gesicht
(Mitgründer) statt eines Logos; Marken-Assets sind in
`design-tokens.md` unter `public/brand/` referenziert.

## Product Principles

1. **Die Maschine testet, der Mensch entscheidet.** Die drei Human-Gates sind
   das Produktversprechen, nicht ein Bremsklotz. Sie müssen als Entscheidung
   erlebbar sein, nicht als Formularschritt.
2. **Der Loop ist das Produkt.** Wert entsteht dort, wo Ausgabendaten in die
   nächste Hypothese zurücklaufen. Was den Kreis sichtbar macht, hat Vorrang
   vor allem, was nur Daten zeigt.
3. **Firmen-Spezifisches ist Daten, nie Code.** Nichts in der Oberfläche darf
   loyft fest verdrahten; jede Marke muss durch dieselbe Engine passen.
4. **Ehrlichkeit schlägt Vollständigkeit.** Fixtures, Hypothesen und
   ungeprüfte Zahlen werden als solche gekennzeichnet. Nichts wird als
   gemessenes Ergebnis dargestellt, was keines ist.
5. **Begreifbar in fünf Minuten aus fünf Metern.** Verständlichkeit auf
   Beamer-Distanz ohne Erklärung daneben ist eine Produktanforderung.

## Accessibility & Inclusion

Die Beamer-Situation macht Kontrast und Textgröße zu funktionalen
Anforderungen, nicht zu Geschmacksfragen: alles, was die Jury lesen muss, muss
aus einigen Metern lesbar sein. Bewegung bleibt zurückhaltend und respektiert
`prefers-reduced-motion`. Bedienung und Beschriftung sind durchgängig deutsch.
