# TOOLING — Setup-Status (Stand: 25.07.2026, aktualisiert mittags)

## Status-Tabelle

| Tool | Installiert | Version | Was fehlt noch / wer muss ran |
|---|---|---|---|
| node | ja | v26.5.0 (Homebrew) | nichts |
| npm | ja | 11.17.0 | nichts |
| pnpm | ja | 10.28.2 | nichts |
| bun | ja | 1.3.11 | nichts |
| gh | ja | 2.86.0 | Auth-Check lief in Keyring-Timeout (nicht-interaktive Session). Account `LinusAurel` ist konfiguriert — **Linus: einmal `gh auth status` im Terminal bestätigen** |
| cursor-agent (Cursor CLI) | ja, **verifiziert** | 2026.07.23-e383d2b (Homebrew-Cask `cursor-cli`, Binary von downloads.cursor.com) | **Linus: `cursor-agent login`** (interaktiv). `cursor-agent --version` läuft sauber durch (s. Vorfälle Nr. 1 zum Gatekeeper-Fix) |
| n8n | ja (Cloud-Instanz) | — | Läuft auf n8n Cloud statt lokal (lokaler Install gescheitert, s. Vorfälle). Workflow-Export liegt unter `integrations/n8n/`, API-Key via `N8N_API_KEY` in `.env` |
| yt-dlp | **nein** | — | Bei Bedarf: `brew install yt-dlp` (war nicht Teil des Setup-Auftrags) |
| ffmpeg | ja | 8.1.2 | nichts |

## Vorfälle beim Setup

1. **Cursor CLI:** cursor.com war nicht erreichbar (SSL-Timeout, auch über externen Proxy — Ausfall auf Cursor-/Vercel-Seite), der offizielle Installer `curl https://cursor.com/install | bash` schlug deshalb fehl. Ausweich: Homebrew-Cask `cursor-cli` (offizielles Binary vom CDN `downloads.cursor.com`, SHA256-verifiziert durch Homebrew). Danach blockierte macOS-Gatekeeper das native Modul `merkle-tree-napi.darwin-arm64.node` (Quarantäne, „Apple could not verify…“) und verschob es beim Dialog in den Papierkorb. **Fix, der funktioniert hat:** `brew reinstall --cask cursor-cli` und direkt danach — vor dem ersten Start — `xattr -dr com.apple.quarantine /opt/homebrew/Caskroom/cursor-cli/`. Danach läuft `cursor-agent --version` sauber durch. Falls das CLI je neu installiert wird, solange cursor.com down ist: denselben xattr-Schritt wiederholen. Sobald cursor.com wieder erreichbar ist, ist der offizielle Installer der sauberere Weg (notarisiert, kein xattr nötig).
2. **n8n-Global-Install scheiterte** am nativen Build von `isolated-vm` (node-gyp) unter Node v26. **Gelöst:** Statt lokalem Install läuft n8n auf einer Cloud-Instanz; der Optimize-Workflow (Schedule → HTTP POST `/api/brands/loyft/optimize`) ist dort eingerichtet, Export liegt unter `integrations/n8n/`.

## MCP / Konnektoren

- **Meta Ads MCP** (`mcp.facebook.com/ads`) — **bereits verbunden & autorisiert** (OAuth erledigt).
- **Meta Developer Tools MCP** — **bereits verbunden & autorisiert**.
- **Firecrawl MCP** (gehosteter offizieller Server, keyless Tier: `https://mcp.firecrawl.dev/v2/mcp`) — dreifach eingetragen:
  - `.cursor/mcp.json` (Cursor)
  - `.mcp.json` im Repo-Root (Standard-Projektformat für weitere Coding-Agents)
  - global in Linus' lokaler Tool-Config außerhalb des Repos (Backup der Datei liegt daneben)
  - Für höhere Limits API-Key aus dem Firecrawl-Dashboard in `.env` (`FIRECRAWL_API_KEY`) hinterlegen.

## Was Linus noch tun muss (Logins/Keys — nichts davon automatisierbar)

1. `cursor-agent login` (interaktiv; erst sinnvoll, wenn cursor.com wieder erreichbar ist).
2. `gh auth status` einmal interaktiv bestätigen (Keyring entsperren).
3. `.env` aus `.env.example` anlegen und Keys eintragen: Anthropic, Firecrawl, Fal, ElevenLabs, Meta-Token + Ad-Account-ID (Quellen stehen als Kommentar in `.env.example`).

## Repo-Dateien aus diesem Setup

- `.env.example` — alle Env-Vars aus SPEC.md §5 mit Herkunfts-Kommentaren.
- `.cursor/mcp.json` — Firecrawl-MCP (Remote, Cursor).
- `.mcp.json` — Firecrawl-MCP (Remote, Standard-Projektformat für weitere Coding-Agents).
- `.gitignore` — um `!.env.example` ergänzt (sonst hätte `.env.*` das Example mitignoriert).
- Nichts committed.
npx impeccable install  # nach dem Clonen einmal ausführen (Design-Skill, lokal)
