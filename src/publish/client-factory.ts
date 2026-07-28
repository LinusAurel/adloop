import type { MetaWriteClient } from "@/meta/write-client";
import type { WriteClient } from "./chain";

let override: WriteClient | null = null;

export function setWriteClientForTests(client: WriteClient | null): void {
  override = client;
}

export function getWriteClientOrThrow(
  live: MetaWriteClient | null,
): WriteClient {
  if (override) return override;
  if (!live) throw new Error("meta_write_client_unavailable");
  return live;
}
