import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "@/lib/env";
import {
  OPENAI_IMAGES_TOKEN_ESTIMATE,
  OPENAI_IMAGES_USD_PER_TOKEN,
} from "./providers/openai-images";

export const AdCopySchema = z.object({
  primary_text: z.string().min(1),
  headline: z.string().min(1),
  description: z.string(),
  call_to_action: z.string().min(1),
});
export type AdCopy = z.infer<typeof AdCopySchema>;

export interface CopyGenerator {
  generate(params: {
    contentLocale: string;
    productContext: string;
    prompt: string;
    aspectRatio: string;
    signal: AbortSignal;
  }): Promise<AdCopy>;
}

let override: CopyGenerator | null = null;

export function setCopyGeneratorForTests(generator: CopyGenerator | null): void {
  override = generator;
}

export function getCopyGenerator(): CopyGenerator {
  if (override) return override;
  return new AnthropicCopyGenerator();
}

/** Deterministic copy for tests / stub path without Anthropic key. */
export class StubCopyGenerator implements CopyGenerator {
  async generate(params: {
    contentLocale: string;
    productContext: string;
    prompt: string;
    aspectRatio: string;
  }): Promise<AdCopy> {
    const lang = params.contentLocale.toLowerCase().startsWith("en") ? "en" : "de";
    if (lang === "en") {
      return {
        primary_text: `Discover ${params.productContext}. ${params.prompt}`.slice(0, 220),
        headline: params.prompt.slice(0, 40) || "New creative",
        description: `Format ${params.aspectRatio}`,
        call_to_action: "LEARN_MORE",
      };
    }
    return {
      primary_text: `Entdecke ${params.productContext}. ${params.prompt}`.slice(0, 220),
      headline: params.prompt.slice(0, 40) || "Neues Creative",
      description: `Format ${params.aspectRatio}`,
      call_to_action: "LEARN_MORE",
    };
  }
}

class AnthropicCopyGenerator implements CopyGenerator {
  async generate(params: {
    contentLocale: string;
    productContext: string;
    prompt: string;
    aspectRatio: string;
    signal: AbortSignal;
  }): Promise<AdCopy> {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new StubCopyGenerator().generate(params);
    }
    const client = new Anthropic({ apiKey });
    const model = env.COPY_MODEL;
    const response = await client.messages.create(
      {
        model,
        max_tokens: 512,
        system: [
          "You write Meta ad copy.",
          `Write exclusively in locale ${params.contentLocale}.`,
          "Return ONLY a JSON object with keys primary_text, headline, description, call_to_action.",
          "call_to_action must be a Meta CTA enum like LEARN_MORE, SHOP_NOW, SIGN_UP.",
        ].join(" "),
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              productContext: params.productContext,
              imagePrompt: params.prompt,
              aspectRatio: params.aspectRatio,
            }),
          },
        ],
      },
      { signal: params.signal },
    );
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("copy_generation_unparseable");
    }
    const parsed = AdCopySchema.safeParse(JSON.parse(jsonMatch[0]));
    if (!parsed.success) {
      throw new Error(`copy_generation_invalid:${parsed.error.message}`);
    }
    return parsed.data;
  }
}

/** Rough copy cost estimate in USD cents (display currency separate). */
export function estimateCopyCostUsd(count: number): number {
  // ~$0.01 per creative copy at sonnet-class rates — documented estimate, not billing.
  return Math.round(count * 0.01 * 100) / 100;
}

export function estimateImageCostUsd(count: number, provider: string): number {
  if (provider === "fal") {
    return Math.round(count * 0.003 * 1000) / 1000;
  }
  if (provider === "openai-images") {
    // Based on live usage.total_tokens for gpt-image-1 medium 1024 (CAPTURE.json).
    const unit = OPENAI_IMAGES_TOKEN_ESTIMATE * OPENAI_IMAGES_USD_PER_TOKEN;
    return Math.round(count * unit * 1000) / 1000;
  }
  return 0;
}
