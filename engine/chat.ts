// Chat agent (#16): the user steers the whole engine in dialogue. One
// tool-use loop over the existing engine functions — no duplicated logic.
// Long operations follow the async job pattern (#7): the tool starts the run
// and reports the runId; progress arrives in the UI via /state polling.
// Guardrail: every tool operates strictly on the brand of the given slug.
// Product UI language is English; the assistant mirrors the user's language
// while generated marketing content stays in the brand's market language.

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
  get_brand_state: "State read",
  generate_angles: "Strategist started",
  approve_angle: "Angle approved",
  reject_angle: "Angle rejected",
  generate_assets: "Asset pipeline started",
  approve_asset: "Asset approved",
  reject_asset: "Asset rejected",
  publish_campaign: "Publisher started (PAUSED)",
  mine_insights: "Analyst started",
  update_brand_data: "Brand data updated",
};

/* ------------------------------------------------------------- summary -- */

function euro(value: number | null | undefined): string {
  if (value === undefined || value === null) return "—";
  return `€${value.toFixed(2)}`;
}

// Compact state summary for the system prompt and the mock reply.
export function buildStateSummary(state: BrandState): string {
  const { brand, angles, assets, runs, learnings } = state;
  const lines: string[] = [];

  lines.push(`Brand: ${brand.name} (${brand.url}) — product: ${brand.product}`);
  lines.push(
    `Target CPA: ${brand.targetCpa != null ? euro(brand.targetCpa) : "not set yet"} (conversion goal: ${brand.conversionGoal})`,
  );

  if (angles.length === 0) {
    lines.push("Angles: none yet — the Strategist can register hypotheses.");
  } else {
    lines.push(`Angles (${angles.length}):`);
    for (const a of angles.slice(0, 20)) {
      const measured = a.measuredCpl !== undefined ? `, measured ${euro(a.measuredCpl)}` : "";
      lines.push(
        `- [${a.status}] ${a.name} (${a.id}) — ${a.segment}; expected ${euro(a.expectedCpl)}${measured}`,
      );
    }
  }

  if (assets.length === 0) {
    lines.push("Assets: none yet.");
  } else {
    lines.push(`Assets (${assets.length}):`);
    for (const asset of assets.slice(0, 30)) {
      const angle = angles.find((a) => a.id === asset.angleId);
      const score = asset.criticScore !== undefined ? `, critic ${asset.criticScore}/10` : "";
      const published = asset.metaIds?.adId ? ", created at Meta" : "";
      lines.push(
        `- [${asset.status}] ${asset.kind} (${asset.id}) for "${angle?.name ?? asset.angleId}"${score}${published}`,
      );
    }
  }

  if (brand.meta.campaignId) {
    lines.push(
      `Campaign: created (campaignId ${brand.meta.campaignId}${brand.meta.adsetId ? `, adsetId ${brand.meta.adsetId}` : ""}) — ads ALWAYS launch paused.`,
    );
  } else {
    lines.push("Campaign: not published yet.");
  }
  lines.push(
    `Budget: ${brand.meta.fixedDailyBudgetCents != null ? euro(brand.meta.fixedDailyBudgetCents / 100) + " per day, fixed by a human" : "not configured"}`,
  );

  const active = runs.filter((r) => !r.finishedAt);
  if (active.length > 0) {
    lines.push(`Active jobs: ${active.map((r) => r.stage).join(", ")}`);
  }
  if (learnings.length > 0) {
    lines.push(`Learnings (${learnings.length}), latest: ${learnings.at(-1)?.pattern ?? "—"}`);
  }

  return lines.join("\n");
}

/* ---------------------------------------------------------------- tools -- */

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_brand_state",
    description:
      "Reads the brand's current state (angles, assets, campaign, runs, learnings) fresh from the store. Use it when you need details beyond the summary in the system prompt, or after your own mutations.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "generate_angles",
    description:
      "Starts the Strategist as a background job: it registers new testable angle hypotheses with an expected CPL. Returns a run ID immediately; the result appears on the board.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "approve_angle",
    description:
      "Approves an angle (status approved). Human gate: only execute when the user explicitly asked for the approval.",
    input_schema: {
      type: "object",
      properties: {
        angleId: { type: "string", description: "ID of the angle, e.g. ang_…" },
      },
      required: ["angleId"],
    },
  },
  {
    name: "reject_angle",
    description:
      "Rejects an angle (status killed). Human gate: only execute when the user explicitly asked for it.",
    input_schema: {
      type: "object",
      properties: {
        angleId: { type: "string", description: "ID of the angle, e.g. ang_…" },
      },
      required: ["angleId"],
    },
  },
  {
    name: "generate_assets",
    description:
      "Starts the asset pipeline (Copywriter → Critic → Designer) for an approved angle as a background job. The result (copy + creative) appears in the studio.",
    input_schema: {
      type: "object",
      properties: {
        angleId: { type: "string", description: "ID of the angle, e.g. ang_…" },
      },
      required: ["angleId"],
    },
  },
  {
    name: "approve_asset",
    description:
      "Approves an asset (status approved). Human gate: only execute when the user explicitly asked for the approval.",
    input_schema: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "ID of the asset, e.g. ast_…" },
      },
      required: ["assetId"],
    },
  },
  {
    name: "reject_asset",
    description:
      "Rejects an asset (status rejected). Human gate: only execute when the user explicitly asked for it.",
    input_schema: {
      type: "object",
      properties: {
        assetId: { type: "string", description: "ID of the asset, e.g. ast_…" },
      },
      required: ["assetId"],
    },
  },
  {
    name: "publish_campaign",
    description:
      "Starts the Publisher as a background job: approved assets are created as ads at Meta — ALWAYS with status PAUSED; only a human activates them in Ads Manager.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "mine_insights",
    description:
      "Starts the Analyst as a background job: reads Meta insights, classifies winners/losers and extracts learnings. The result appears under economics.",
    input_schema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["auto", "live", "fixture"],
          description:
            "auto (default): real insights first, demo fixture when the account is empty; live: real data only; fixture: demo data only.",
        },
      },
    },
  },
  {
    name: "update_brand_data",
    description:
      "Updates the brand's master data in the store. Allowed: name, product, url, whatsappUrl, targetCpa (euro, null to clear), guardrails (full list). Budget and Meta configuration are off limits — a human sets those.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        product: { type: "string" },
        url: { type: "string" },
        whatsappUrl: { type: "string" },
        targetCpa: { type: ["number", "null"], description: "Target CPA in euro, or null" },
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
    return { result: `Angle ${angleId} does not belong to this brand or does not exist.`, isError: true };
  }
  angle.status = status;
  writeCollection("angles", angles);
  return {
    result: `Angle "${angle.name}" is now ${status === "approved" ? "approved" : "rejected"}.`,
    mutated: true,
  };
}

function setAssetStatus(slug: string, assetId: string, status: Asset["status"]): ToolOutcome {
  if (!findBrandAsset(slug, assetId)) {
    return { result: `Asset ${assetId} does not belong to this brand or does not exist.`, isError: true };
  }
  const assets = readCollection("assets");
  const asset = assets.find((a) => a.id === assetId);
  if (!asset) {
    return { result: `Asset ${assetId} does not exist.`, isError: true };
  }
  asset.status = status;
  writeCollection("assets", assets);
  return {
    result: `Asset ${assetId} (${asset.kind}) is now ${status === "approved" ? "approved" : "rejected"}.`,
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
        return { result: "targetCpa must be a number (euro) or null.", isError: true };
      }
      brand.targetCpa = value;
    } else if (key === "guardrails") {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        return { result: "guardrails must be a list of strings.", isError: true };
      }
      brand.guardrails = value as string[];
    } else {
      if (typeof value !== "string") {
        return { result: `${key} must be a string.`, isError: true };
      }
      brand[key] = value;
    }
    changed.push(key);
  }
  if (changed.length === 0) {
    return { result: "No allowed fields provided (name, product, url, whatsappUrl, targetCpa, guardrails).", isError: true };
  }
  upsert("brands", brand);
  return { result: `Updated: ${changed.join(", ")}.`, mutated: true };
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
    result: `Job started (runId ${run.id}). Running in the background — the result will appear ${doneWhere}.`,
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
      return startJob(slug, "strategist", (run) => runStrategist(slug, { run }), "on the board");

    case "approve_angle":
      return setAngleStatus(slug, String(input.angleId ?? ""), "approved");

    case "reject_angle":
      return setAngleStatus(slug, String(input.angleId ?? ""), "killed");

    case "generate_assets": {
      const angleId = String(input.angleId ?? "");
      const angle = findBrandAngle(slug, angleId);
      if (!angle) {
        return { result: `Angle ${angleId} does not belong to this brand or does not exist.`, isError: true };
      }
      return startJob(
        slug,
        "assets",
        (run) => generateAssetPair(angle.id, { run }),
        "in the studio",
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
            "Publish is not configured: adAccountId, pageId or fixedDailyBudgetCents are missing — a human sets those in brand.json, never an agent.",
          isError: true,
        };
      }
      return startJob(
        slug,
        "publish",
        (run) => publishBrand(slug, { run }),
        "in the ticker (all ads launch PAUSED)",
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
        "under economics",
      );
    }

    case "update_brand_data":
      return updateBrandData(brand, input);

    default:
      return { result: `Unknown tool: ${name}`, isError: true };
  }
}

/* ----------------------------------------------------------------- chat -- */

function buildSystem(brand: Brand, summary: string): string {
  return [
    `You are the campaign strategist for the brand "${brand.name}" in adloop, an agentic paid-ads engine (Scout → Strategist → Copywriter → Critic → Designer → Publisher → Analyst).`,
    "",
    "Current state of the brand:",
    summary,
    "",
    "Rules:",
    "- Reply briefly, concretely and action-oriented. Reply in the language the user writes in; default to English.",
    "- Generated marketing content (ad copy, angles, hooks) stays in the brand's market language — for German brands that means German with correct umlauts (ä, ö, ü, ß), never ae/oe/ue.",
    "- Plain prose, no Markdown: no **asterisks**, no # headings, no tables. Short paragraphs and simple dashes (-) are fine.",
    "- Execute actions exclusively through tools — never claim an action you did not perform via a tool.",
    "- Approving and rejecting (angles, assets) are the user's decisions: only execute them when explicitly requested; otherwise give a recommendation and ask.",
    "- Long operations (angles, assets, publish, insights) run as background jobs: start the job, report that the result will appear on the board, in the studio or in the ticker. Do not wait, do not block.",
    "- The Publisher ALWAYS creates campaigns and ads paused (PAUSED); only a human activates them in Ads Manager. You never manage budget or spend.",
    "- You work exclusively with this one brand — never read or modify data of other brands.",
    "- When the user asks for the current state, the summary above is usually enough; fetch fresh details via get_brand_state only when needed.",
  ].join("\n");
}

function buildMockReply(summary: string): string {
  return [
    "MOCK mode active: ANTHROPIC_API_KEY is not set — this is a deterministic sample reply, not a real model response.",
    "",
    "Current state of the brand:",
    summary,
    "",
    "Once an ANTHROPIC_API_KEY is set, I steer the engine right here in the chat: register hypotheses, approve or reject them, generate assets, publish the campaign (always PAUSED) and mine insights.",
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
      reply = reply || "I cannot handle this request — please rephrase it.";
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
    reply = "Done — details are on the board and in the ticker.";
  }
  return { reply, actions, stateChanged };
}
