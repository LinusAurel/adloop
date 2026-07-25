# brands/_example — Struktur-Vorlage

Fiktive Beispiel-Brand („Nordwind Kaffee“, ein erfundenes Kaffee-Abo). Sie
zeigt die Struktur des Brand-Daten-Layers und ist die einzige Brand, die im
öffentlichen Repo liegt — echte Brand-Daten unter `brands/<slug>/` bleiben
lokal und werden nie committed (siehe `.gitignore`).

## Dateien

| Datei | Zweck |
|---|---|
| `brand.json` | Maschinenlesbare Brand-Config: Name, URL, Produkt, Ziel (targetCpa als Default, `meta.campaignTarget` pro Kampagne), Guardrails, `copyRules` (deterministische Verbots-Muster), `cta` (Landingpage-CTA), `fallbackCopy`, Design-Tokens, Meta-Publisher-Felder |
| `brand.md` | Brand-Kontext in Prosa für den Strategist (Positionierung, Zielgruppe, Nutzenversprechen, Tonalität) |
| `guardrails.md` | Sprach- und Claim-Regeln in Prosa für Copywriter und Critic |
| `design-tokens.md` | Gestaltungs-Richtung für den Designer (Bildwelt, Farben, Typo) |
| `zielfunktion.md` | Wirtschaftliche Zielfunktion (was darf ein Lead kosten und warum) |

## Neue Brand anlegen

1. Ordner `brands/<slug>/` anlegen (bleibt automatisch untracked).
2. Dateien aus diesem Ordner kopieren und mit echten Daten füllen.
3. `meta.*` (Ad-Account, Page, Pixel, Budget) setzt ein Mensch — nie ein Agent.
