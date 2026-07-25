// Anthropic connector: one wrapper for all LLM stages, model routing via env
// (MODEL_STRATEGIST, MODEL_COPY — SPEC §5). Without ANTHROPIC_API_KEY the
// wrapper runs in a deterministic MOCK mode with plausible example outputs so
// the pipeline stays demoable end to end. Mock usage is clearly logged.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export type LlmRole = "scout" | "strategist" | "copy" | "critic" | "analyst";

const DEFAULT_MODEL = "claude-sonnet-5"; // SPEC §0 default

function modelFor(role: LlmRole): string {
  switch (role) {
    case "scout":
    case "strategist":
    case "critic":
      return process.env.MODEL_STRATEGIST || DEFAULT_MODEL;
    case "copy":
    case "analyst":
      return process.env.MODEL_COPY || DEFAULT_MODEL;
  }
}

export function isMockMode(): boolean {
  return !process.env.ANTHROPIC_API_KEY;
}

// One log line per process is not enough context when a dev server runs from
// a worktree without .env — the cwd pinpoints which checkout misses the key.
export function mockModeHint(): string {
  return (
    "Mock mode active: ANTHROPIC_API_KEY missing in the server process " +
    `(cwd: ${process.cwd()}) — outputs are sample data, not real results`
  );
}

// Deterministic example outputs per role — clearly labelled as mock data.
const MOCK_OUTPUTS: Record<LlmRole, string> = {
  scout: JSON.stringify(
    {
      mock: true,
      productSummary: "MOCK: D2C-Produkt, aus der Website extrahiert",
      valueProposition: "MOCK: zentrales Nutzenversprechen der Marke",
      pricingModel: "MOCK: Einmalkauf, mittleres Preissegment",
      tonality: "MOCK: nahbar, direkt, leicht premium",
      segments: [
        {
          name: "MOCK-Segment Selbstoptimierer",
          psychographics:
            "MOCK: will Kontrolle über den Alltag, misstraut leeren Marketing-Versprechen",
          pains: ["MOCK: hat schon Alternativen probiert und wurde enttäuscht"],
        },
      ],
      awarenessDistribution: {
        unaware: 40,
        problemAware: 30,
        solutionAware: 15,
        productAware: 10,
        mostAware: 5,
      },
      awarenessRationale: "MOCK: Hypothese ohne Datenbasis, am Tag 1 zu validieren",
      competitorNotes: ["MOCK: Wettbewerber werben primär über Rabatt-Claims"],
      vocPhrases: ["MOCK: „endlich etwas, das wirklich hält, was es verspricht“"],
      objections: ["MOCK: „zu schön, um wahr zu sein“-Skepsis"],
      // Außensicht-Sektionen aus der Web-Recherche (#19), im Schema optional:
      competitorProfiles: [
        {
          name: "MOCK-Wettbewerber A",
          positioning: "MOCK: positioniert sich über Preis und Rabatt-Aktionen",
        },
      ],
      externalObjections: ["MOCK: Reviews bemängeln langsamen Support"],
      marketContext: "MOCK: Kategorie mit hoher Ad-Blindheit, Claims weitgehend totgespielt",
    },
    null,
    2,
  ),
  // Brand-neutral on purpose: mock angles must never look like real data of a
  // specific brand (see #12 — loyft-flavoured mocks landed under another slug).
  strategist: JSON.stringify(
    {
      mock: true,
      angles: [
        {
          name: "MOCK-Angle Preis-Frust",
          segment: "MOCK: preissensible Bestandskunden der Kategorie",
          pain: "MOCK: zahlt spürbar mehr als nötig und merkt es erst spät",
          mechanism: "MOCK: konkreter Vorher-nachher-Vergleich macht das Delta sichtbar",
          hookDirection: "MOCK: Zahlen-Kontrast mit sofortiger Auflösung",
          expectedCpl: 14,
          rationale: "MOCK: Beispiel-Angle ohne Brand-Bezug — nur für Demos ohne API-Key",
        },
        {
          name: "MOCK-Angle Bequemlichkeit",
          segment: "MOCK: bequeme Wiederkäufer ohne Wechselmotivation",
          pain: "MOCK: will sich um das Thema nie wieder selbst kümmern müssen",
          mechanism: "MOCK: Service übernimmt die wiederkehrende Arbeit dauerhaft",
          hookDirection: "MOCK: Entlastungs-Versprechen statt Spar-Claim",
          expectedCpl: 16,
          rationale: "MOCK: Beispiel-Angle ohne Brand-Bezug — nur für Demos ohne API-Key",
        },
      ],
    },
    null,
    2,
  ),
  copy: JSON.stringify(
    {
      mock: true,
      variants: [
        {
          hook: "Deine Stromrechnung weiß mehr als Du.",
          primary:
            "Schick uns ein Foto Deiner Abrechnung. Wir rechnen ehrlich nach, ob Du zu viel zahlst. Kostet nichts, wenn Du nicht sparst.",
          headline: "Sparpotenzial in 2 Minuten prüfen",
          cta: "Rechnung schicken",
        },
      ],
    },
    null,
    2,
  ),
  critic: JSON.stringify(
    { mock: true, score: 8, notes: ["MOCK: Hook stoppt Scroll", "MOCK: reason-why vorhanden"] },
    null,
    2,
  ),
  analyst: JSON.stringify(
    { mock: true, winners: [], losers: [], learnings: ["MOCK: noch keine Insights-Daten"] },
    null,
    2,
  ),
};

export interface CompleteArgs {
  role: LlmRole;
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export async function complete(args: CompleteArgs): Promise<string> {
  if (isMockMode()) {
    console.log(`[MOCK] anthropic (Rolle "${args.role}"): ${mockModeHint()}`);
    return MOCK_OUTPUTS[args.role];
  }

  const client = new Anthropic();
  const response = await client.messages.create({
    model: modelFor(args.role),
    max_tokens: args.maxTokens ?? 4096,
    system: args.system,
    messages: [{ role: "user", content: args.prompt }],
  });

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export interface StructuredArgs<T> extends CompleteArgs {
  schema: z.ZodType<T>;
  schemaName: string;
}

// Structured output via output_config.format (zod-validated by the SDK's
// parse helper). In mock mode the deterministic example output is returned
// without schema validation — mocks are approximations, not contract tests.
export async function completeStructured<T>(args: StructuredArgs<T>): Promise<T> {
  if (isMockMode()) {
    console.log(`[MOCK] anthropic (Rolle "${args.role}", unvalidiert): ${mockModeHint()}`);
    return JSON.parse(MOCK_OUTPUTS[args.role]) as T;
  }

  const client = new Anthropic();
  const response = await client.messages.parse({
    model: modelFor(args.role),
    max_tokens: args.maxTokens ?? 8192,
    system: args.system,
    messages: [{ role: "user", content: args.prompt }],
    output_config: { format: zodOutputFormat(args.schema) },
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`LLM-Refusal für Rolle "${args.role}" — Prompt prüfen`);
  }
  if (response.parsed_output == null) {
    throw new Error(
      `Strukturierter Output für "${args.schemaName}" konnte nicht geparst werden (stop_reason: ${response.stop_reason})`,
    );
  }
  return response.parsed_output;
}
