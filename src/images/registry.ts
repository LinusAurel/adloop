import { env } from "@/lib/env";
import type { ImageProvider } from "./provider";
import { FalImageProvider } from "./providers/fal";
import { OpenAiImagesProvider } from "./providers/openai-images";
import { StubImageProvider } from "./providers/stub";

let override: ImageProvider | null = null;

export function setImageProviderForTests(provider: ImageProvider | null): void {
  override = provider;
}

/** Every provider this build knows about. */
const PROVIDER_IDS = ["fal", "openai-images", "stub"] as const;

/**
 * The providers this installation can actually construct — one whose API key is
 * absent throws and is left out. Kept here rather than in a route so that the
 * picker and the setup check cannot disagree about who is available.
 */
export function availableImageProviders(): ImageProvider[] {
  const byId = new Map<string, ImageProvider>();
  for (const id of PROVIDER_IDS) {
    try {
      const provider = getImageProvider(id);
      // Keyed by the provider's own id, not by the candidate: a test override
      // answers to every id and would otherwise appear three times.
      if (!byId.has(provider.id)) byId.set(provider.id, provider);
    } catch {
      // A provider without its key cannot be called, so it is not on offer.
    }
  }
  return [...byId.values()];
}

export function getImageProvider(providerId?: string): ImageProvider {
  if (override) return override;
  const id = providerId ?? env.IMAGE_PROVIDER;
  switch (id) {
    case "stub":
      return new StubImageProvider();
    case "fal": {
      const key = env.FAL_KEY;
      if (!key) {
        throw new Error("FAL_KEY is required when IMAGE_PROVIDER=fal");
      }
      return new FalImageProvider({ apiKey: key, baseUrl: env.FAL_BASE_URL });
    }
    case "openai-images": {
      const key = env.OPENAI_API_KEY;
      if (!key) {
        throw new Error("OPENAI_API_KEY is required when IMAGE_PROVIDER=openai-images");
      }
      return new OpenAiImagesProvider({
        apiKey: key,
        baseUrl: env.OPENAI_IMAGES_BASE_URL,
      });
    }
    default:
      throw new Error(`unknown_image_provider:${id}`);
  }
}
