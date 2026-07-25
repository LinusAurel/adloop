// Chat agent (#16): the user steers the whole engine in dialogue. One
// tool-use loop over the existing engine functions — no duplicated logic.
// Long operations follow the async job pattern (#7): the tool starts the run
// and reports the runId; progress arrives in the UI via /state polling.
// Guardrail: every tool operates strictly on the brand of the given slug.

import Anthropic from "@anthropic-ai/sdk";
import { analyzeBrand } from "./agents/analyst.ts";
import { generateAssetPair } from "./agents/pipeline.ts";
import { publishBrand } from "./agents/publisher.ts";
import { runStrategist } from "./agents/strategist.ts";
import { isMockMode, mockModeHint } from "./connectors/anthropic.ts";
import {
  createRun,
  finishRun,
  getBrandState,
  readCollection,
  upsert,
  writeCollection,
} from "./store.ts";
import type { Angle, Asset, Brand, BrandState, Run } from "./types.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatAction {
  type: string;
  label: string;
}

export interface ChatResult {
  reply: string;
  actions: ChatAction[];
  stateChanged: boolean;
}

// Same default as the rest of the engine (SPEC §0); own env override first.
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOOL_ITERATIONS = 8;

function chatModel(): string {
  return process.env.MODEL_CHAT || process.env.MODEL_STRATEGIST || DEFAULT_MODEL;
}

// Badge labels for executed tool actions (UI shows them under the reply).
const ACTION_LABELS: Record<string, string> = {
  get_brand_state: "Status gelesen",
  generate_angles: "Strategist gestartet",
  approve_angle: "Hypothese freigegeben",
  reject_angle: "Hypothese verworfen",
  generate_assets: "Asset-Pipeline gestartet",
  approve_asset: "Asset freigegeben",
  reject_asset: "Asset abgelehnt",
  publish_campaign: "Publisher gestartet (PAUSED)",
  mine_insights: "Analyst gestartet",
  update_brand_data: "Brand-Daten aktualisiert",
};

/* ------------------------------------------------------------- summary -- */

function euro(value: number | null | undefined): string {
  if (value === undefined || value === null) return "—";
  return `${value.toFixed(2).replace(".", ",")} €`;
}

// Compact German state summary for the system prompt and the mock reply.
export function buildStateSummary(state: BrandState): string {
  const { brand, angles, assets, runs, learnings } = state;
  const lines: string[] = [];

  lines.push(`Brand: ${brand.name} (${brand.url}) — Produkt: ${brand.product}`);
  lines.push(
    `Ziel-CPA: ${brand.targetCpa != null ? euro(brand.targetCpa) : "noch nicht gesetzt"} (Conversion-Goal: ${brand.conversionGoal})`,
  );

  if (angles.length === 0) {
    lines.push("Angles: noch keine — der Strategist kann Hypothesen anmelden.");
  } else {
    lines.push(`Angles (${angles.length}):`);
    for (const a of angles.slice(0, 20)) {
      const measured = a.measuredCpl !== undefined ? `, gemessen ${euro(a.measuredCpl)}` : "";
      lines.push(
        `- [${a.status}] ${a.name} (${a.id}) — ${a.segment}; erwartet ${euro(a.expectedCpl)}${measured}`,
      );
    }
  }

  if (assets.length === 0) {
    lines.push("Assets: noch keine.");
  } else {
    lines.push(`Assets (${assets.length}):`);
    for (const asset of assets.slice(0, 30)) {
      const angle = angles.find((a) => a.id === asset.angleId);
      const score = asset.criticScore !== undefined ? `, Critic ${asset.criticScore}/10` : "";
      const published = asset.metaIds?.adId ? ", bei Meta angelegt" : "";
      lines.push(
        `- [${asset.status}] ${asset.kind} (${asset.id}) für „${angle?.name ?? asset.angleId}“${score}${published}`,
      );
    }
  }

  if (brand.meta.campaignId) {
    lines.push(
      `Kampagne: angelegt (campaignId ${brand.meta.campaignId}${brand.meta.adsetId ? `, adsetId ${brand.meta.adsetId}` : ""}) — Ads starten IMMER pausiert.`,
    );
  } else {
    lines.push("Kampagne: noch nicht veröffentlicht.");
  }
  lines.push(
    `Budget: ${brand.meta.fixedDailyBudgetCents != null ? euro(brand.meta.fixedDailyBudgetCents / 100) + " pro Tag, von einem Menschen fixiert" : "nicht konfiguriert"}`,
  );

  const active = runs.filter((r) => !r.finishedAt);
  if (active.length > 0) {
    lines.push(`Laufende Jobs: ${active.map((r) => r.stage).join(", ")}`);
  }
  if (learnings.length > 0) {
    lines.push(`Learnings (${learnings.length}), zuletzt: ${learnings.at(-1)?.pattern ?? "—"}`);
  }

  return lines.join("\n");
}

/* ---------------------------------------------------------------- tools -- */

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_brand_state",
    description:
      "Liest den aktuellen Zustand der Brand (Angles, Assets, Kampagne, Läufe, Learnings) frisch aus dem Store. Nutze das, wenn Du Details brauchst, die über die Zusammenfassung im Systemprompt hinausgehen, oder nach eigenen Mutationen.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "generate_angles",
    description:
      "Startet den Strategist als Hintergrund-Job: er meldet neue testbare Angle-Hypothesen mit erwartetem CPL an. Antwortet sofort mit einer Run-ID; das Ergebnis erscheint im Board.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "approve_angle",
    description:
      "Gibt einen Angle frei (Status approved). Menschliches Gate: nur ausführen, wenn der Nutzer die Freigabe ausdrücklich verlangt hat.",
    input_schema: {
      type: "object",
      properties: {
        angleId: { type: "string", description: "ID des Angles, z. B. ang_…" },
      },
      required: ["angleId"],
    },
  },
  {
    name: "reject_angle",
    description:
      "Verwirft einen Angle (Status killed). Menschliches Gate: nur ausführen, wenn der Nutzer das ausdrücklich verlangt hat.",
    input_schema: {
      type: "object",
      properties: {
        angleId: { type: "string", description: "ID des Angles, z. B. ang_…" },
      },
      required: ["angleId"],
    },
  },
  {
    name: "generate_assets",
    description:
      "Startet die Asset-Pipeline (Copywriter → Critic → Designer) für einen freigegebenen Angle als Hintergrund-Job. Ergebnis (Copy + Motiv) erscheint im Studio.",
    input_schema: {
      type: "object",
      properties: {
        angleId: { type: "string", description: "ID des Angles, z. B. ang_…" },
      },
      required: ["angleId"],
    },
  },
  {
    name: "approve_asset",
    description:
      "Gibt ein Asset frei (Status approved). Menschliches Gate: nur ausführen, wenn der Nutzer die Freigabe ausdrücklich verlangt hat.",
    input_schema: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "ID des Assets, z. B. ast_…" },
      },
      required: ["assetId"],
    },
  },
  {
    name: "reject_asset",
    description:
      "Lehnt ein Asset ab (Status rejected). Menschliches Gate: nur ausführen, wenn der Nutzer das ausdrücklich verlangt hat.",
    input_schema: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "ID des Assets, z. B. ast_…" },
      },
      required: ["assetId"],
    },
  },
  {
    name: "publish_campaign",
    description:
      "Startet den Publisher als Hintergrund-Job: freigegebene Assets werden als Ads bei Meta angelegt — IMMER mit Status PAUSED, aktiviert wird nur von einem Menschen im Ads Manager.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "mine_insights",
    description:
      "Startet den Analyst als Hintergrund-Job: liest Meta-Insights, klassifiziert Winner/Loser und zieht Learnings. Ergebnis erscheint unter Economics.",
    input_schema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["auto", "live", "fixture"],
          description:
            "auto (Default): erst echte Insights, bei leerem Konto Demo-Fixture; live: nur echte Daten; fixture: nur Demo-Daten.",
        },
      },
    },
  },
  {
    name: "update_brand_data",
    description:
      "Ändert Stammdaten der Brand im Store. Erlaubt: name, product, url, whatsappUrl, targetCpa (Euro, null zum Löschen), guardrails (vollständige Liste). Budget- und Meta-Konfiguration sind tabu — die setzt ein Mensch.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        product: { type: "string" },
        url: { type: "string" },
        whatsappUrl: { type: "string" },
        targetCpa: { type: ["number", "null"], description: "Ziel-CPA in Euro oder null" },
        guardrails: { type: "array", items: { type: "string" } },
      },
    },
  },
];

interface ToolOutcome {
  result: string;
  isError?: boolean;
  mutated?: boolean;
}

// Brand isolation: an angle only resolves when it belongs to the route slug.
function findBrandAngle(slug: string, angleId: string): Angle | undefined {
  return readCollection("angles").find((a) => a.id === angleId && a.brandSlug === slug);
}

// Assets carry no brandSlug — resolve via their angle and check that.
function findBrandAsset(slug: string, assetId: string): Asset | undefined {
  const asset = readCollection("assets").find((a) => a.id === assetId);
  if (!asset) return undefined;
  const angle = readCollection("angles").find((a) => a.id === asset.angleId);
  return angle?.brandSlug === slug ? asset : undefined;
}

function setAngleStatus(slug: string, angleId: string, status: Angle["status"]): ToolOutcome {
  const angles = readCollection("angles");
  const angle = angles.find((a) => a.id === angleId && a.brandSlug === slug);
  if (!angle) {
    return { result: `Angle ${angleId} gehört nicht zu dieser Brand oder existiert nicht.`, isError: true };
  }
  angle.status = status;
  writeCollection("angles", angles);
  return {
    result: `Angle „${angle.name}“ ist jetzt ${status === "approved" ? "freigegeben" : "verworfen"}.`,
    mutated: true,
  };
}

function setAssetStatus(slug: string, assetId: string, status: Asset["status"]): ToolOutcome {
  if (!findBrandAsset(slug, assetId)) {
    return { result: `Asset ${assetId} gehört nicht zu dieser Brand oder existiert nicht.`, isError: true };
  }
  const assets = readCollection("assets");
  const asset = assets.find((a) => a.id === assetId);
  if (!asset) {
    return { result: `Asset ${assetId} existiert nicht.`, isError: true };
  }
  asset.status = status;
  writeCollection("assets", assets);
  return {
    result: `Asset ${assetId} (${asset.kind}) ist jetzt ${status === "approved" ? "freigegeben" : "abgelehnt"}.`,
    mutated: true,
  };
}

const BRAND_UPDATE_KEYS = ["name", "product", "url", "whatsappUrl", "targetCpa", "guardrails"] as const;

function updateBrandData(brand: Brand, input: Record<string, unknown>): ToolOutcome {
  const changed: string[] = [];
  for (const key of BRAND_UPDATE_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (key === "targetCpa") {
      if (value !== null && typeof value !== "number") {
        return { result: "targetCpa muss eine Zahl (Euro) oder null sein.", isError: true };
      }
      brand.targetCpa = value;
    } else if (key === "guardrails") {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        return { result: "guardrails muss eine Liste von Strings sein.", isError: true };
      }
      brand.guardrails = value as string[];
    } else {
      if (typeof value !== "string") {
        return { result: `${key} muss ein String sein.`, isError: true };
      }
      brand[key] = value;
    }
    changed.push(key);
  }
  if (changed.length === 0) {
    return { result: "Keine erlaubten Felder übergeben (name, product, url, whatsappUrl, targetCpa, guardrails).", isError: true };
  }
  upsert("brands", brand);
  return { result: `Aktualisiert: ${changed.join(", ")}.`, mutated: true };
}

// Async job pattern identical to the mutation routes (#7): create the run,
// fire the agent as a fire-and-forget promise, report the runId immediately.
function startJob(
  slug: string,
  stage: string,
  work: (run: Run) => Promise<unknown>,
  doneWhere: string,
  angleId?: string,
): ToolOutcome {
  const run = createRun(slug, stage, angleId);
  void work(run).catch((err) => {
    finishRun(run.id, err instanceof Error ? err.message : String(err));
  });
  return {
    result: `Job gestartet (runId ${run.id}). Läuft im Hintergrund — das Ergebnis erscheint ${doneWhere}.`,
    mutated: true,
  };
}

// Exported for tests: executes one chat tool strictly scoped to the slug.
export async function executeChatTool(
  slug: string,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const state = getBrandState(slug);
  if (!state) return { result: "brand_not_found", isError: true };
  const brand = state.brand;

  switch (name) {
    case "get_brand_state":
      return { result: buildStateSummary(state) };

    case "generate_angles":
      return startJob(slug, "strategist", (run) => runStrategist(slug, { run }), "im Board");

    case "approve_angle":
      return setAngleStatus(slug, String(input.angleId ?? ""), "approved");

    case "reject_angle":
      return setAngleStatus(slug, String(input.angleId ?? ""), "killed");

    case "generate_assets": {
      const angleId = String(input.angleId ?? "");
      const angle = findBrandAngle(slug, angleId);
      if (!angle) {
        return { result: `Angle ${angleId} gehört nicht zu dieser Brand oder existiert nicht.`, isError: true };
      }
      return startJob(
        slug,
        "assets",
        (run) => generateAssetPair(angle.id, { run }),
        "im Studio",
        angle.id,
      );
    }

    case "approve_asset":
      return setAssetStatus(slug, String(input.assetId ?? ""), "approved");

    case "reject_asset":
      return setAssetStatus(slug, String(input.assetId ?? ""), "rejected");

    case "publish_campaign": {
      // Same precondition as the publish route: Meta config is human-owned.
      if (!brand.meta.adAccountId || !brand.meta.pageId || !brand.meta.fixedDailyBudgetCents) {
        return {
          result:
            "Publish nicht konfiguriert: adAccountId, pageId oder fixedDailyBudgetCents fehlen — die setzt ein Mensch in brand.json, kein Agent.",
          isError: true,
        };
      }
      return startJob(
        slug,
        "publish",
        (run) => publishBrand(slug, { run }),
        "im Ticker (alle Ads starten PAUSED)",
      );
    }

    case "mine_insights": {
      const mode =
        input.mode === "live" || input.mode === "fixture" || input.mode === "auto"
          ? input.mode
          : "auto";
      return startJob(
        slug,
        "optimize",
        (run) => analyzeBrand(slug, { mode, run }),
        "unter Economics",
      );
    }

    case "update_brand_data":
      return updateBrandData(brand, input);

    default:
      return { result: `Unbekanntes Tool: ${name}`, isError: true };
  }
}

/* ----------------------------------------------------------------- chat -- */

function buildSystem(brand: Brand, summary: string): string {
  return [
    `Du bist der Kampagnen-Stratege der Brand „${brand.name}“ in adloop, einer agentischen Paid-Ads-Engine (Scout → Strategist → Copywriter → Critic → Designer → Publisher → Analyst).`,
    "",
    "Aktueller Stand der Brand:",
    summary,
    "",
    "Regeln:",
    "- Antworte knapp, konkret und handlungsorientiert. Immer auf Deutsch mit korrekten Umlauten (ä, ö, ü, ß) und deutschen Anführungszeichen („…“).",
    "- Schlichter Fließtext, kein Markdown: keine **Sternchen**, keine #-Überschriften, keine Tabellen. Kurze Absätze und einfache Spiegelstriche (-) sind in Ordnung.",
    "- Führe Aktionen ausschließlich über Tools aus — behaupte nie eine Aktion, die Du nicht per Tool ausgeführt hast.",
    "- Freigeben und Verwerfen (Angles, Assets) sind Entscheidungen des Nutzers: nur ausführen, wenn er sie ausdrücklich verlangt; sonst eine Empfehlung geben und fragen.",
    "- Lange Operationen (Angles, Assets, Publish, Insights) laufen als Hintergrund-Jobs: Job starten, melden, dass das Ergebnis im Board, Studio oder Ticker erscheint. Nicht warten, nicht blockieren.",
    "- Der Publisher legt Kampagnen und Ads IMMER pausiert (PAUSED) an; aktiviert wird nur von einem Menschen im Ads Manager. Budget oder Spend verwaltest Du nie.",
    "- Du arbeitest ausschließlich mit dieser einen Brand — keine Daten anderer Brands lesen oder ändern.",
    "- Wenn der Nutzer den Stand wissen will, reicht meist die Zusammenfassung oben; hole frische Details nur bei Bedarf per get_brand_state.",
  ].join("\n");
}

function buildMockReply(summary: string): string {
  return [
    mockModeHint(),
    "",
    "Aktueller Stand der Brand:",
    summary,
    "",
    "Sobald ein ANTHROPIC_API_KEY gesetzt ist, steuere ich die Engine hier im Dialog: Hypothesen anmelden, freigeben oder verwerfen, Material erzeugen, die Kampagne veröffentlichen (immer PAUSED) und Insights auswerten.",
  ].join("\n");
}

// Runs one chat turn: tool-use loop over the engine, strictly brand-scoped.
export async function runChat(slug: string, messages: ChatMessage[]): Promise<ChatResult> {
  const state = getBrandState(slug);
  if (!state) throw new Error("brand_not_found");
  const summary = buildStateSummary(state);

  if (isMockMode()) {
    console.log(`[MOCK] chat: ${mockModeHint()}`);
    return {
      reply: buildMockReply(summary),
      actions: [{ type: "get_brand_state", label: ACTION_LABELS.get_brand_state }],
      stateChanged: false,
    };
  }

  const client = new Anthropic();
  const system = buildSystem(state.brand, summary);
  const apiMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const actions: ChatAction[] = [];
  let stateChanged = false;
  let reply = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model: chatModel(),
      max_tokens: 4096,
      system,
      messages: apiMessages,
      tools: TOOLS,
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) reply = text;

    if (response.stop_reason === "refusal") {
      reply = reply || "Diese Anfrage kann ich nicht bearbeiten — bitte anders formulieren.";
      break;
    }
    if (response.stop_reason !== "tool_use") break;

    // Echo the assistant content back unchanged (incl. thinking blocks).
    apiMessages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const outcome = await executeChatTool(
        slug,
        block.name,
        (block.input ?? {}) as Record<string, unknown>,
      );
      if (!outcome.isError) {
        actions.push({ type: block.name, label: ACTION_LABELS[block.name] ?? block.name });
        if (outcome.mutated) stateChanged = true;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: outcome.result,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    apiMessages.push({ role: "user", content: toolResults });
  }

  if (!reply) {
    reply = "Erledigt — Details stehen im Board bzw. Ticker.";
  }
  return { reply, actions, stateChanged };
}
