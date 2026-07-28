/**
 * Shared image MIME resolution for every Fal ingest path (webhook + polling).
 * Rank: provider content_type → HTTP Content-Type → magic bytes. No guessing.
 */

export function mimeFromMagicBytes(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6 && bytes.toString("ascii", 0, 6) === "GIF87a") {
    return "image/gif";
  }
  if (bytes.length >= 6 && bytes.toString("ascii", 0, 6) === "GIF89a") {
    return "image/gif";
  }
  return null;
}

function normalizeMime(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.split(";")[0]!.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Fal `content_type` → HTTP `Content-Type` → magic bytes.
 * Returns null when nothing can be established (caller must not invent a type).
 */
export function resolveImageMime(
  falType: string | null | undefined,
  httpType: string | null | undefined,
  bytes: Buffer,
): string | null {
  return (
    normalizeMime(falType) ?? normalizeMime(httpType) ?? mimeFromMagicBytes(bytes)
  );
}
