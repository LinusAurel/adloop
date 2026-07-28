import { env } from "@/lib/env";
import type { ImageProvider } from "./provider";
import { ElevenLabsImageProvider } from "./providers/elevenlabs";
import { FalImageProvider } from "./providers/fal";
import { StubImageProvider } from "./providers/stub";

let override: ImageProvider | null = null;

export function setImageProviderForTests(provider: ImageProvider | null): void {
  override = provider;
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
    case "elevenlabs": {
      const key = env.ELEVENLABS_API_KEY;
      if (!key) {
        throw new Error("ELEVENLABS_API_KEY is required when IMAGE_PROVIDER=elevenlabs");
      }
      return new ElevenLabsImageProvider({
        apiKey: key,
        baseUrl: env.ELEVENLABS_BASE_URL,
      });
    }
    default:
      throw new Error(`unknown_image_provider:${id}`);
  }
}
