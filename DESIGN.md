# Design

Verbindliches Designsystem für adloop Mission Control. Produktwahrheit steht in
`PRODUCT.md`. Diese Datei hält die dauerhaften visuellen Regeln.

## Die Welt: der leise Leitstand

Mission Control ist ein ruhiger Arbeitsraum, kein Cockpit und kein Dashboard.
Die Haltung kommt aus dem von Lenn gesetzten Vorbild: eine sehr leise
Seitenleiste links, ein zentrierter Inhaltsbereich mit viel leerem Raum, weiche
stark gerundete Flächen, fast keine sichtbaren Rahmen, wenig Text und dieser
groß gesetzt. Pro Ansicht gibt es genau ein starkes Element, alles andere ist
zurückgenommen.

Das Vorbild ist hell. Übernommen wird nicht seine Helligkeit, sondern seine
Ruhe, übersetzt in unsere dunkle Palette.

**Was diese Welt ausdrücklich ablehnt:** das Kachel-Dashboard mit gleichgroßen
Karten, Karten in Karten, Haarlinien-Register mit gedrängten Spalten, Stempel in
Versalien, viele kleine Beschriftungen, Sparklines und Fortschrittsringe als
Inhaltsersatz. Wenn eine Ansicht dicht wirkt, ist zu viel drin, nicht zu wenig
Platz.

## Grund und Licht

Dunkel, weil die Oberfläche im abgedunkelten Pitch-Raum auf einen Beamer
projiziert und daneben live bedient wird. Der Grund ist kein Schwarz und kein
Neutralgrau, sondern ein sehr tiefes, kühles Tintenblau-Grün. Diese Werte sind
gesetzt und ändern sich nicht.

```
--ink-900  #070B0D   Seitenleiste, tiefster Grund
--ink-850  #0A1013   Hauptbereich
--ink-800  #0D1418   Eintragsfläche, ruhende Karte
--ink-750  #111A1E   Eingaben, leise Knöpfe
--rule     #1B272C   Trennlinie, nur im Ausnahmefall
--rule-2   #29383E   betonte Linie
--text     #E9EFF1   Haupttext
--text-soft #9AAAB0  Fortsetzung im Satz, Sekundärtext
--text-faint #82949B Zeitangaben, Gruppenüberschriften
```

Die drei Grundtöne bilden die Tiefe: Seitenleiste dunkler als der
Hauptbereich, Einträge heller als der Hauptbereich. Struktur entsteht durch
diesen Flächenwechsel und durch Abstand, nicht durch Rahmen und nicht durch
Schatten.

## Farbstrategie: zurückhaltend

Neutrale Tinte plus **ein** Signal. Mint ist Handlung und Bestätigung, nie
Dekoration.

```
--mint   #00FF7F   Hauptaktion, validiert, Messwert schlägt Erwartung
--red    #FF5C4D   abgebrochen, fehlgeschlagen, Limit überschritten
--amber  #E8A93B   im Test, offene Auflage, Demo-Daten
```

Regeln, die nicht verhandelbar sind:

- Mint erscheint pro Ansicht an höchstens drei Stellen. Ist Mint überall, ist es
  nirgends. Freigegeben trägt deshalb kein Mint, validiert schon.
- Mint nie als Fläche hinter Fließtext, nie als Verlauf, nie als Textfarbe für
  ganze Überschriften.
- Rot ausschließlich negativ. PAUSED ist kein Fehler, sondern der korrekte
  Ruhezustand, und bleibt neutral.
- Keine Farbverläufe, kein Glas, keine Schatten als Tiefenersatz.

## Typografie

**Geist** für alles, **Geist Mono** ausschließlich für Zeitstempel im Ticker,
wo die Spalte nicht springen darf. Geist ist eine ruhige Produkt-Grotesk mit
echten Tabellenziffern: sie tritt bei kleinen Graden zurück und trägt bei
großen.

- Alle Zahlen laufen mit `font-variant-numeric: tabular-nums` (`.tnum`).
- Ansichtstitel: 1,75 rem, Gewicht 600, Letterspacing −0,025 em.
- Die eine große Zahl einer Ansicht: bis 3,5 rem, Gewicht 600,
  Letterspacing −0,04 em.
- Listenzeile: 0,9375 rem mit entspannter Zeilenhöhe.
- Führungstext unter dem Titel: 0,9375 rem, `--text-soft`, maximal 52 Zeichen
  pro Zeile.
- Zeitangaben und Gruppenüberschriften: 0,6875 bis 0,8125 rem.

Versalien gibt es an genau einer Stelle: der Gruppenüberschrift (`.group-heading`),
die Abschnitte in Seitenleiste und Liste voneinander trennt. Sonst nirgends.

## Form und Rhythmus

- **Flächen statt Linien.** Einträge sind weiche, stark gerundete Flächen mit
  Abstand dazwischen. Trennlinien sind die Ausnahme, nicht die Regel.
- Radius ist großzügig und gestuft: 12 px für Knöpfe und Eingaben, 16 px für
  Einträge, 22 px für die eine große Fläche einer Ansicht.
- Die Inhaltsspalte ist auf 840 px begrenzt und zentriert. Der leere Raum
  rechts und links ist Absicht und wird nicht gefüllt.
- Die Seitenleiste ist 240 px breit, trägt Suche oben, Navigation als Icon plus
  Label in normaler Textgröße und die Marke unten. Sie ist leise: kein Rahmen,
  keine Versalien in der Navigation.
- Eine Listenzeile liest sich als ein Satz: fetter Anfang, graue Fortsetzung in
  derselben Zeile, Zahlen und Statuspunkt rechts.
- Der Statuspunkt ist 7 px groß und rund. Er ersetzt den Stempel vollständig.

## Ehrlichkeit als Designregel

Es wird nichts gezeigt, was keine Route dahinter hat. Keine Platzhalter-Funktion,
kein Knopf ohne Wirkung, kein erfundener Startbildschirm. Die Ablauf-Ansicht wird
ausschließlich aus echten Läufen gebaut; eine Stufe ohne Lauf sagt „nie
gelaufen“, statt einen Zustand zu erfinden.

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
