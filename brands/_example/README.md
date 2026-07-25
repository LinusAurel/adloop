# brands/_example — structural template

Fictional example brand ("Northwind Coffee", an invented coffee subscription).
It documents the structure of the brand data layer and is the only brand that
lives in the public repo — real brand data under `brands/<slug>/` stays local
and is never committed (see `.gitignore`).

## Files

| File | Purpose |
|---|---|
| `brand.json` | Machine-readable brand config: name, URL, product, target (targetCpa as default, `meta.campaignTarget` per campaign), guardrails, `copyRules` (deterministic forbidden patterns), `cta` (landing page CTA), `fallbackCopy`, design tokens, Meta publisher fields |
| `brand.md` | Brand context in prose for the Strategist (positioning, audience, value proposition, tonality) |
| `guardrails.md` | Language and claim rules in prose for Copywriter and Critic |
| `design-tokens.md` | Visual direction for the Designer (imagery, colors, typography) |
| `zielfunktion.md` | Economic target function (what a lead may cost and why) |

## Creating a new brand

1. Create the folder `brands/<slug>/` (it stays untracked automatically).
2. Copy the files from this folder and fill them with real data.
3. `meta.*` (ad account, page, pixel, budget) is set by a human — never by an agent.

Note: the file names (`zielfunktion.md` etc.) are part of the engine contract
(`loadBrandDoc`) — keep them as they are. The content language should match
the brand's market (the demo fixtures, for example, are German).
