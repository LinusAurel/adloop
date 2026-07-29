# adloop

Ein Werkzeug, das aus Anzeigendaten Handlungen macht: Es beobachtet, was auf Meta läuft,
erkennt, wann Creatives sich abnutzen, erzeugt Nachschub und veröffentlicht ihn — jeder
teure Schritt mit einem Menschen davor.

**Konversionsziel-unabhängig.** Purchase, Lead, Traffic, Engagement — die Leitmetrik ist
ein Zähler/Nenner-Vertrag, kein fest verdrahtetes Ziel.

## Was drin ist

| | |
|---|---|
| **Chat** | Agent mit Werkzeugen, Freigaben und Playbooks |
| **Creative Strategist** | Pulse-Indizes, Funnel-Position, Creative Strain, Aktionen |
| **Bild-Werkstatt** | Generierung über austauschbare Anbieter, mit Idempotenz |
| **Launch** | Meta-Publishing als Schritt-Kette — immer `PAUSED` |

## Betreiben

```bash
cp .env.example .env     # ausfüllen
docker compose up
pnpm migrate
```

Vier Container: `web`, `worker`, `db`, `storage` (MinIO). Kein verwalteter Anbieter im
Kern — wer adloop selbst betreiben will, braucht `docker compose up` und eine `.env`.

## Zwei harte Regeln

**Es wird immer `PAUSED` veröffentlicht.** Aktivierung ist eine menschliche Entscheidung im
Ads Manager. Es gibt keinen Schalter, keine Option und kein Werkzeug dafür.

**Budgets setzt ausschließlich ein Mensch.** Der Agent darf sie weder vorschlagen noch
ergänzen noch ändern. Fehlt ein Budget, bricht der Publish ab, statt einen Standardwert zu
setzen.

## Eigenes Aussehen

Farben, Schriften und Radien kommen aus `theme/default.css`. Ein Fork ersetzt diese Datei
und hat sein eigenes Erscheinungsbild — kein Bauteil kennt einen Farbwert. Zustandsrollen
(`--good`, `--warn`, `--crit`, `--none`) tragen Bedeutung, nicht Farbe.

## Zweisprachig

Deutsch und Englisch, auf drei getrennten Achsen: Oberfläche, Agentenantworten und die
Sprache der **erzeugten Anzeigentexte**. Ein deutscher Nutzer, der englische Anzeigen
schaltet, ist der Normalfall.

## Entwickeln

```bash
pnpm test                  # 199 Tests, sequenziell (Testcontainers)
pnpm test:meta-contract    # Feldvertrag gegen die echte Meta-API
pnpm test:meta-publish     # Publish gegen ein Sandbox-Werbekonto
```

Entscheidungen und ihre Begründungen: [`DECISIONS.md`](DECISIONS.md).
