import { env } from "@/lib/env";
import type { ImageProvider } from "./provider";
import { FalImageProvider } from "./providers/fal";
import { OpenAiImagesProvider } from "./providers/openai-images";
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
