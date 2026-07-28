/** Bounded image download shared by Fal webhook + polling paths. */

export const DOWNLOAD_MAX_BYTES = 15 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 30_000;

export type ImageDownloadHttp = {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

export async function downloadImageBytes(
  url: string,
  http: ImageDownloadHttp,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await http.fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`download_http_${response.status}`);
    }
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader && Number(lengthHeader) > DOWNLOAD_MAX_BYTES) {
      // Do not open a reader — declared size already exceeds the cap.
      throw new Error("download_too_large");
    }
    const headerType = response.headers.get("content-type");
    const contentType = headerType ? headerType.split(";")[0]!.trim() || null : null;

    if (!response.body) {
      throw new Error("download_empty_body");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      // Check BEFORE retaining the chunk — peak must not exceed the limit.
      if (total + value.byteLength > DOWNLOAD_MAX_BYTES) {
        await reader.cancel();
        throw new Error("download_too_large");
      }
      total += value.byteLength;
      chunks.push(value);
    }
    return { bytes: Buffer.concat(chunks.map((c) => Buffer.from(c))), contentType };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
