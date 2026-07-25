# AGENTS.md — Prozess-Vertrag (Hackathon-Edition)

Verbindlicher Root-Vertrag für alle Coding-Agents in diesem Repo. Kompakt,
weil Hackathon: Der Prozess soll Fehler verhindern, nicht Tempo kosten.
Was hier nicht steht, ist bewusst weggelassen.

## Wahrheitsquellen

- `KONZEPT.md` — WAS gebaut wird und WARUM (fachliche Wahrheit).
- `SPEC.md` — Bauplan: Stack, Datenmodell, Pipeline-Verträge, Reihenfolge.
- `brands/<slug>/` — Brand-Daten. Firmen-Spezifisches ist immer Daten,
  nie Code in `engine/` oder `app/`.
- Bei Widerspruch zwischen Dokumenten oder zwischen Dokument und Auftrag:
  stoppen, Widerspruch benennen, Linus fragen. Nicht still eine Variante wählen.

## Workflow: Issue → Worktree → Branch → Merge

1. **Issue-first.** Jedes nennenswerte Arbeitspaket beginnt mit einem
   GitHub-Issue: `gh issue create --title "Kurzer deutscher Titel" --body "…"`.
   Mini-Fixes (offensichtlich, wenige Minuten) dürfen ohne Issue laufen.
2. **Worktree-Pflicht.** Branch-Arbeit passiert IMMER in einem Worktree,
   nie im Haupt-Checkout — der bleibt dauerhaft auf `main`. Anlegen mit
   `scripts/worktree.sh new <type> <short-desc> [issue-nr]`; das Skript
   erstellt Branch + Worktree unter `.worktrees/`, installiert Dependencies
   und aktiviert die Hooks. So kollidieren parallele Agent-Streams
   (SPEC §7) nie miteinander oder mit dem Haupt-Checkout.
3. **Branch-Konvention.** `<type>/<issue-nr>-<short-desc>`, lowercase, ASCII,
   kebab-case; Typen: `feat fix chore docs refactor test spike`.
   Beispiel: `feat/12-board-ui`.
4. **Kleine Commits mit Issue-Referenz.** Eine logische Einheit pro Commit;
   bei Issue-Bezug endet das Subject mit `(#N)`, der abschließende Commit
   oder PR enthält `Closes #N`.
5. **Rebase statt Merge-Sammeln.** Vor dem Einbringen den Branch auf den
   aktuellen `main` rebasen, dann fast-forward mergen oder pushen —
   keine Merge-Commits aus Worktrees heraus.
6. **Aufräumen.** Nach dem Merge `scripts/worktree.sh done <branch>`:
   Worktree weg, Branch weg. Überblick: `scripts/worktree.sh list`.

## Sprache und Konventionen

- Fachliche Prosa, Docs, Issues und UI-Texte: Deutsch mit korrekten Umlauten,
  `ß` und deutschen Anführungszeichen („…“); ein pre-commit-Hook korrigiert
  falsche Closer automatisch (`node scripts/check-quotes.mjs --fix`).
- Commit-Subjects: Englisch im Conventional-Commit-Stil
  `<type>(<scope>): <summary>`; Commit-Body darf Deutsch sein.
- Erlaubte Commit-Typen: `feat fix docs refactor test chore ci build perf revert`.
- Identifier, Dateinamen, Branches, Env-Vars: Englisch, ASCII-only.
- Code-Kommentare: Englisch, sparsam, nur für nicht offensichtliche Logik.

## Arbeitsdisziplin

- Nur den vereinbarten Scope ändern. Keine Nebenbei-Aufräumarbeiten, keine
  Stil-Änderungen in fachfremden Dateien.
- „Funktioniert“ wird nur behauptet, wenn es in derselben Session belegt wurde
  (Route aufgerufen, Response gelesen, UI gesehen). Ungeprüftes als ungeprüft
  markieren.
- Vor Abschluss eines Arbeitspakets: alles committen und `verify` grün —
  der geprüfte Stand muss dem gepushten Stand entsprechen.

## Verify vor Commit und Push (Pflicht)

- Ein einziges Gate: `bash scripts/verify.sh` — lefthook führt es automatisch
  aus (pre-commit: Secrets-Scan + Quote-Autofix + `quick`, pre-push: `full`),
  CI ruft dasselbe Skript. Neue Checks kommen NUR in `scripts/verify.sh` dazu.
- Sobald `package.json` existiert: `lefthook` als devDependency plus
  `"prepare": "lefthook install"` eintragen, damit die Hooks greifen.
- Rot heißt fixen, nicht umgehen: keine Assertions abschwächen, keine Tests
  skippen, kein flächiges `eslint-disable`, kein `--no-verify`. Einzige
  Ausnahme: belegter False-Positive des Secrets-Scans — dann im selben Zug
  das Muster in `scripts/verify.sh` korrigieren.

## Harte Regeln (Hard Stops)

1. **Nie Secrets committen**: keine `.env`-Dateien, API-Keys oder Tokens in
   Code, Fixtures, Logs oder Docs. `.env.example` bleibt wertlos (leere Werte).
2. **Meta-Publishes immer `status: PAUSED`** — Kampagnen, AdSets, Ads.
   Aktivierung macht ausschließlich ein Mensch: per bewusstem Klick über die
   Status-Route/UI oder direkt im Ads Manager. Kein Agent aktiviert selbst.
3. **Human-Gates nie automatisieren oder überspringen**: Angle-Approve,
   Asset-Approve und Ad-Aktivierung sind Menschen-Entscheidungen.
4. **Kein Budget-/Spend-Management durch Agenten** — auch nicht „nur testweise“.
5. **Wächter-Selbstschutz**: `AGENTS.md`, `scripts/`, `lefthook.yml` und
   `.github/workflows/ci.yml` werden nur mit ausdrücklicher Freigabe von
   Linus geändert — ein Agent schaltet seine eigenen Gates nicht ab.
