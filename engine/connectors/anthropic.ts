// Anthropic connector: one wrapper for all LLM stages, model routing via env
// (MODEL_STRATEGIST, MODEL_COPY — SPEC §5). Without ANTHROPIC_API_KEY the
// wrapper runs in a deterministic MOCK mode with plausible example outputs so
// the pipeline stays demoable end to end. Mock usage is clearly logged.

import Anthropic from "@anthropic-ai/sdk";

export type LlmRole = "strategist" | "copy" | "critic" | "analyst";

const DEFAULT_MODEL = "claude-sonnet-5"; // SPEC §0 default

function modelFor(role: LlmRole): string {
  switch (role) {
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

// Deterministic example outputs per role — clearly labelled as mock data.
const MOCK_OUTPUTS: Record<LlmRole, string> = {
  strategist: JSON.stringify(
    {
      mock: true,
      angles: [
        {
          name: "Grundversorgungs-Falle",
          segment: "Nicht-Wechsler in der Grundversorgung",
          pain: "Zahlt seit Jahren still zu viel, ohne es zu merken",
          mechanism: "Erst-Check per Rechnung deckt das Delta konkret auf",
          hookDirection: "Zahlen-Schock mit sofortiger Auflösung",
          expectedCpl: 14,
          rationale: "MOCK: ~23 % der Haushalte stecken in der Grundversorgung",
        },
        {
          name: "Nie-wieder-kümmern",
          segment: "Bequeme Ex-Wechsler",
          pain: "Hat einmal gewechselt und will das nie wieder selbst machen",
          mechanism: "Laufendes Vertragsmanagement übernimmt Folgewechsel",
          hookDirection: "Entlastungs-Versprechen statt Spar-Claim",
          expectedCpl: 16,
          rationale: "MOCK: Trägheit als Retention-Moat, Positionierung Premium-Entlastung",
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
    console.log(
      `[MOCK] anthropic: kein ANTHROPIC_API_KEY gesetzt — deterministischer Beispiel-Output für Rolle "${args.role}"`,
    );
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
