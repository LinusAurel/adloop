# Design

Verbindliches Designsystem für die adloop-Oberfläche. Produktwahrheit steht in
`PRODUCT.md`. Diese Datei hält die dauerhaften visuellen Regeln.

## Die Welt: die ruhige Plattform

adloop ist eine ruhige, agentische Marketing-Plattform, kein Cockpit und kein
Dashboard: Chat als Start, wenige klare Bereiche, die Brand als Kontext. Eine
leise Seitenleiste links, ein zentrierter Inhaltsbereich mit viel leerem Raum,
weiche stark gerundete Flächen, wenig Text und dieser groß gesetzt. Pro
Ansicht gibt es genau ein starkes Element, alles andere ist zurückgenommen.

**Was diese Welt ausdrücklich ablehnt:** das Kachel-Dashboard mit gleichgroßen
Karten, Karten in Karten, Haarlinien-Register mit gedrängten Spalten, Stempel in
Versalien, viele kleine Beschriftungen, Fortschrittsringe als Inhaltsersatz.
Wenn eine Ansicht dicht wirkt, ist zu viel drin, nicht zu wenig Platz.

## Grund und Licht

Hell und warm: ein Off-White-Papier als Grund, Tinte-Schwarz als Text, weiße
Karten mit sehr weicher Rundung und haarfeiner Kante als Fläche. Struktur
entsteht durch Flächenwechsel und Abstand, nicht durch harte Rahmen und nicht
durch Schatten.

```
--paper    #F4F2EC   Grund, Seitenleiste und Hauptbereich
--card     #FDFCF9   ruhende Karte, Popover, Dialog
--sink     #ECE9E0   Eingaben, leise Knöpfe, aktive Navigation
--sink-2   #E4E1D5   gedrückter Zustand, kbd
--rule     #E3E0D4   haarfeine Kante, nur wo nötig
--ink      #1C1B17   Haupttext, der schwarze Pill-Button
--ink-soft #6D6A5E   Fortsetzung im Satz, Sekundärtext
--ink-faint #999687  Zeitangaben, Gruppenüberschriften
```

## Farbstrategie: zurückhaltend

Tinte auf Papier plus Farbe nur als Bedeutung. Die Hauptaktion ist ein
schwarzer Pill-Button; Entscheidungen sind farbig; die Brand färbt einen
dezenten Akzent.

```
--green        #1E7A49   Freigeben (gefüllt), Gewinner, unter Ziel
--red          #C2402E   Verwerfen/Ablehnen (Outline), Verlierer, Fehler
--amber        #A3791F   im Test, Demo-Daten, über Ziel
--accent-brand pro Brand Kontextfarbe: Avatar, Wortmarke, aktive Navigation
```

Regeln, die nicht verhandelbar sind:

- Der schwarze Pill ist die eine starke Aktion pro Ansicht — nie zwei.
- Grün gefüllt heißt Freigeben, Rot als Outline heißt Verwerfen/Ablehnen.
  Farbe erscheint nur an Entscheidungen und Bewertungen, nie als Dekoration.
- Der Brand-Akzent kommt aus den Brand-Daten (Fallback-Palette pro Slug) und
  bleibt klein: Avatar, Wortmarke, aktives Icon, Punkte. Nie als Fläche hinter
  Fließtext, nie als Verlauf.
- Rot ausschließlich negativ. PAUSED ist kein Fehler, sondern der korrekte
  Ruhezustand, und bleibt neutral.
- Keine Farbverläufe, kein Glas, keine schweren Schatten.

## Typografie

**Geist** für alles, **Geist Mono** ausschließlich für Zeitstempel im Ticker,
wo die Spalte nicht springen darf. Geist ist eine ruhige Produkt-Grotesk mit
echten Tabellenziffern: sie tritt bei kleinen Graden zurück und trägt bei
großen.

- Alle Zahlen laufen mit `font-variant-numeric: tabular-nums` (`.tnum`).
- Ansichtstitel: 1,875 rem, Gewicht 600, Letterspacing −0,025 em.
- Die eine große Zahl einer Ansicht: bis 3,25 rem, Gewicht 600,
  Letterspacing −0,04 em.
- Listenzeile: 0,9375 rem mit entspannter Zeilenhöhe.
- Führungstext unter dem Titel: 0,9375 rem, `--ink-soft`, maximal 56 Zeichen
  pro Zeile.
- Zeitangaben und Gruppenüberschriften: 0,6875 bis 0,8125 rem.

Versalien gibt es an genau einer Stelle: der Gruppenüberschrift (`.group-heading`),
die Abschnitte in Seitenleiste, Listen und Board-Spalten voneinander trennt.
Sonst nirgends.

## Form und Rhythmus

- **Flächen statt Linien.** Einträge sind weiche, stark gerundete Karten
  (`.surface`) mit Abstand dazwischen. Trennlinien sind die Ausnahme.
- Radius ist großzügig und gestuft: Pill (voll rund) für Knöpfe, 16–20 px für
  Karten, 24 px für die eine große Fläche einer Ansicht.
- Die Inhaltsspalte ist auf 860 px begrenzt und zentriert; nur das Board darf
  auf 1280 px wachsen, weil ein Kanban Spalten braucht. Der leere Raum ist
  Absicht und wird nicht gefüllt.
- Die Seitenleiste ist 248 px breit (einklappbar auf 64 px), trägt oben
  „+ Neu“ und Suche (⌘K), dann die Bereiche, unten die Brand als Wortmarke mit
  Akzent-Avatar. Sie ist leise: haarfeine Kante, keine Versalien in der
  Navigation.
- Eine Listenzeile liest sich als ein Satz: fetter Anfang, graue Fortsetzung in
  derselben Zeile, Zahlen und Statuspunkt rechts.
- Der Statuspunkt ist 7 px groß und rund. Er ersetzt den Stempel vollständig.
- Verbindungsstatus erscheint ausschließlich im Bereich „Verbindungen“ —
  nirgendwo sonst eine „Verbunden“-Pille.

## Ehrlichkeit als Designregel

Es wird nichts gezeigt, was keine Route dahinter hat. Keine Platzhalter-Funktion,
kein Knopf ohne Wirkung, kein erfundener Startbildschirm. Noch nicht gelandete
Routen werden defensiv angebunden: antwortet die Route 404/405/501, verschwindet
das Bedienelement oder wird als schreibgeschützt benannt.

Zahlen aus einer Fixture tragen an ihrer eigenen Stelle die Kennzeichnung
„Demo-Daten“. Das ist eine Produktregel aus `PRODUCT.md`, keine optionale
Verfeinerung.

## Zustände

Leere Ansichten sind der Normalfall vor dem ersten Lauf und müssen stark
aussehen. Sie folgen dem Vorbild: zentriert, ein Titel, ein Satz, ein Knopf.
Der Satz sagt, was hier erscheinen wird und wer es auslöst. Keine grauen
Platzhalterblöcke.

Freigeben und Verwerfen sind Entscheidungen, keine Formularklicks. Ein Klick
zeigt sofort eine sichtbare Änderung; stumme Klicks sind ein Fehler. Schlägt
eine Aktion serverseitig fehl, benennt der Eintrag das Problem an Ort und
Stelle, statt in den alten Zustand zurückzufallen.

## Bewegung

Ein einziger gestalteter Moment: der Statuswechsel eines Eintrags. Er läuft als
kurze Setzbewegung mit exponentiellem Ausgang aus einem bereits sichtbaren
Zustand. Kein Einblenden ganzer Abschnitte beim Scrollen, keine verstreuten
Hover-Effekte, `prefers-reduced-motion` wird respektiert.
