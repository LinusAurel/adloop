import { describe, expect, it } from "vitest";
import {
  createSession,
  decodeSession,
  encodeSession,
} from "@/auth/session";

describe("signed session cookie", () => {
  it("survives process-independent verification and rejects tampering", () => {
    const now = Date.UTC(2026, 6, 28);
    const session = createSession(
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000001",
      now,
    );
    const encoded = encodeSession(session);

    expect(decodeSession(encoded, now + 1_000)).toEqual(session);
    expect(decodeSession(`${encoded.slice(0, -1)}x`, now + 1_000)).toBeNull();
  });

  it("rejects expired sessions", () => {
    const now = Date.UTC(2026, 6, 28);
    const session = createSession(
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000001",
      now,
    );

    expect(decodeSession(encodeSession(session), (session.expiresAt + 1) * 1_000)).toBeNull();
  });
});
