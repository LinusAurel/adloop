import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "@/meta/token-crypto";

describe("Meta token encryption", () => {
  it("stores an authenticated ciphertext rather than plaintext", () => {
    const key = randomBytes(32).toString("base64");
    const token = "synthetic-token-value";
    const encrypted = encryptToken(token, key);

    expect(encrypted).not.toContain(token);
    expect(decryptToken(encrypted, key)).toBe(token);
  });

  it("rejects a modified ciphertext", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptToken("synthetic-token-value", key);
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;

    expect(() => decryptToken(tampered, key)).toThrow();
  });
});
