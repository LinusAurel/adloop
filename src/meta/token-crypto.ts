import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

function parseKey(encoded: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(encoded)
    ? Buffer.from(encoded, "hex")
    : Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must encode exactly 32 bytes");
  }
  return key;
}

export function encryptToken(token: string, encodedKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", parseKey(encodedKey), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptToken(value: string, encodedKey: string): string {
  const [version, ivPart, tagPart, encryptedPart, extra] = value.split(".");
  if (version !== "v1" || !ivPart || !tagPart || !encryptedPart || extra) {
    throw new Error("unsupported encrypted token format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    parseKey(encodedKey),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
