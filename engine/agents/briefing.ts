// Audio briefing (SPEC §5 ElevenLabs, Should scope): refreshes the analyst
// result, lets the LLM write a ~30 second German stand-up script (media buyer
// tone), then ElevenLabs TTS -> mp3 under data/briefings/. Fixture-based
// results are explicitly called out as demo data in the spoken text.

import fs from "node:fs";
import path from "node:path";
import { complete, isMockMode } from "../connectors/anthropic.ts";
import { textToSpeech } from "../connectors/elevenlabs.ts";
import { dataDir, readCollection } from "../store.ts";
import type { Learning } from "../types.ts";
import { analyzeBrand, type AnalysisResult } from "./analyst.ts";
import { endRun, logLine, startRun } from "./run.ts";

const AGENT = "Briefing";

// ~30 seconds of spoken German is roughly 80-100 words; hard cap protects
// the TTS bill if the LLM rambles anyway.
const MAX_SCRIPT_CHARS = 1200;

export interface BriefingResult {
  runId: string;
  source: "live" | "fixture";
  script: string;
  fileName: string;
  url: string;
}

function euro(value: number | null): string {
  return value === null ? "unbekannt" : `${value.toFixed(2).replace(".", ",")} €`;
}

// Pure summary of the analyst result — feeds both the LLM prompt and the
// deterministic fallback script (mock mode without ANTHROPIC_API_KEY).
export function summarizeAnalysis(analysis: AnalysisResult, learnings: Learning[]): string {
  const winners = analysis.rows.filter((r) => r.classification === "winner");
  const losers = analysis.rows.filter((r) => r.classification === "loser");
  const rest = analysis.rows.length - winners.length - losers.length;
  const lines: string[] = [
    analysis.source === "fixture"
      ? "Datenbasis: Demo-Fixture (klar gelabelt, kein Live-Ergebnis)."
      : "Datenbasis: echte Meta-Insights.",
    `Gesamt: Spend ${euro(analysis.totals.spend)}, ${analysis.totals.leads} Leads, CPL ${euro(analysis.totals.cpl)} bei Ziel-${analysis.target?.metric ?? "CPA"} ≤ ${analysis.targetCpa} €.`,
    `Klassifikation: ${winners.length} Winner, ${losers.length} Loser, ${rest}× zu wenig Daten.`,
  ];
  for (const w of winners) {
    lines.push(`Winner: ${w.adName} — ${w.reason}`);
  }
  for (const l of losers) {
    lines.push(`Loser: ${l.adName} — ${l.reason}`);
  }
  for (const l of learnings.slice(-3)) {
    lines.push(`Learning: ${l.pattern}`);
  }
  lines.push(`Empfehlung: ${analysis.recommendation}`);
  return lines.join("\n");
}

export function buildBriefingPrompt(
  brandName: string,
  summary: string,
): string {
  return [
    `Du bist Performance-Media-Buyer im Daily-Standup für die Brand „${brandName}“.`,
    "Schreibe ein Audio-Briefing von etwa 30 Sekunden Sprechzeit (80 bis 100 Wörter), auf Deutsch.",
    "Ton: locker, präzise, wie ein Media-Buyer, der dem Team den Stand durchgibt. Keine Floskeln, keine Begrüßungsromane.",
    "Pflicht-Inhalte: Winner und Loser beim Namen nennen, CPL gegen das Ziel einordnen, das wichtigste Learning, ein klarer nächster Schritt.",
    "Wenn die Datenbasis eine Demo-Fixture ist, sag das ehrlich in einem Halbsatz.",
    "Gib NUR den Sprechtext aus: keine Überschrift, kein Markdown, keine Emojis, keine Regieanweisungen.",
    "",
    "Aktueller Stand:",
    summary,
  ].join("\n");
}

// Deterministic fallback so the feature stays demoable without LLM key.
export function buildFallbackScript(brandName: string, summary: string): string {
  return `Kurz-Briefing für ${brandName}. ${summary.replace(/\n/g, " ")}`.slice(
    0,
    MAX_SCRIPT_CHARS,
  );
}

function briefingsDir(): string {
  return path.join(dataDir(), "briefings");
}

export function latestBriefingFile(slug: string): string | undefined {
  const dir = briefingsDir();
  if (!fs.existsSync(dir)) return undefined;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${slug}-`) && f.endsWith(".mp3"))
    .sort();
  return files.at(-1);
}

export function briefingFilePath(fileName: string): string {
  return path.join(briefingsDir(), fileName);
}

// Guards the GET route against path traversal: only plain <slug>-<stamp>.mp3
// basenames that exist under data/briefings/ are served.
export function isSafeBriefingFileName(slug: string, fileName: string): boolean {
  return (
    path.basename(fileName) === fileName &&
    /^[a-z0-9-]+\.mp3$/.test(fileName) &&
    fileName.startsWith(`${slug}-`)
  );
}

export async function generateBriefing(slug: string): Promise<BriefingResult> {
  const run = startRun(slug, "briefing");
  try {
    logLine(run.id, AGENT, "aktualisiert Analyst-Ergebnis für das Audio-Briefing …");
    const analysis = await analyzeBrand(slug, { mode: "auto" });
    const learnings = readCollection("learnings").filter((l) => l.brandSlug === slug);
    const brand = readCollection("brands").find((b) => b.slug === slug);
    const brandName = brand?.name ?? slug;
    const summary = summarizeAnalysis(analysis, learnings);

    let script: string;
    if (isMockMode()) {
      logLine(run.id, AGENT, "kein ANTHROPIC_API_KEY — deterministisches Fallback-Skript", "warn");
      script = buildFallbackScript(brandName, summary);
    } else {
      logLine(run.id, AGENT, "textet 30-Sekunden-Briefing (LLM) …");
      script = (
        await complete({
          role: "analyst",
          prompt: buildBriefingPrompt(brandName, summary),
          maxTokens: 1000,
        })
      ).trim();
      if (script.length > MAX_SCRIPT_CHARS) script = script.slice(0, MAX_SCRIPT_CHARS);
    }

    logLine(run.id, AGENT, "spricht Briefing ein (ElevenLabs TTS) …");
    const mp3 = await textToSpeech(script);
    const dir = briefingsDir();
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${slug}-${Date.now()}.mp3`;
    fs.writeFileSync(briefingFilePath(fileName), mp3);
    logLine(
      run.id,
      AGENT,
      `Briefing fertig: ${fileName} (${(mp3.length / 1024).toFixed(0)} KB, ${script.split(/\s+/).length} Wörter)`,
    );
    endRun(run.id);
    return {
      runId: run.id,
      source: analysis.source,
      script,
      fileName,
      url: `/api/brands/${slug}/briefing?file=${fileName}`,
    };
  } catch (err) {
    logLine(run.id, AGENT, `Fehler: ${err instanceof Error ? err.message : String(err)}`, "error");
    endRun(run.id);
    throw err;
  }
}
