import { randomBytes, scrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/auth/password";

describe("password hashing", () => {
  it("accepts the right password and rejects everything else", async () => {
    const hash = await hashPassword("korrekt-pferd-batterie");

    expect(await verifyPassword("korrekt-pferd-batterie", hash)).toBe(true);
    expect(await verifyPassword("korrekt-pferd-batterio", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
    // Ein Präfix darf nicht durchgehen — sonst wäre jedes längere Passwort
    // durch seinen eigenen Anfang ersetzbar.
    expect(await verifyPassword("korrekt-pferd", hash)).toBe(false);
  });

  it("produces a different hash for the same password every time", async () => {
    const a = await hashPassword("dasselbe-passwort-hier");
    const b = await hashPassword("dasselbe-passwort-hier");

    // Gleiche Hashes hießen: kein Salz. Zwei Konten mit demselben Passwort
    // wären dann aneinander erkennbar.
    expect(a).not.toBe(b);
    expect(await verifyPassword("dasselbe-passwort-hier", a)).toBe(true);
    expect(await verifyPassword("dasselbe-passwort-hier", b)).toBe(true);
  });

  it("refuses short passwords rather than storing them", async () => {
    await expect(hashPassword("kurz")).rejects.toThrow("password_too_short");
  });

  it("returns false for anything that is not a hash of ours", async () => {
    for (const broken of [
      "",
      "plaintext",
      "argon2$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA",
      "scrypt$notanumber$8$1$c2FsdA$aGFzaA",
      // Richtiges Format, aber ein Feld fehlt.
      "scrypt$32768$8$1$c2FsdA",
    ]) {
      expect(await verifyPassword("irgendwas", broken)).toBe(false);
    }
  });

  it("keeps the cost parameters in the hash so they can be raised later", async () => {
    const hash = await hashPassword("parameter-im-hash-test");
    const [scheme, N, r, p] = hash.split("$");

    expect(scheme).toBe("scrypt");
    expect(Number(N)).toBeGreaterThanOrEqual(1 << 14);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);

    // Ein leerer Hash-Teil darf nicht als "stimmt überein" durchgehen —
    // sonst wäre er ein Generalschlüssel für jedes Passwort.
    const emptyDigest = ["scrypt", N, r, p, hash.split("$")[4], ""].join("$");
    expect(await verifyPassword("parameter-im-hash-test", emptyDigest)).toBe(false);
    expect(await verifyPassword("völlig anderes", emptyDigest)).toBe(false);

    // Ein Hash mit *anderen* Kostenparametern muss weiterhin prüfbar sein,
    // sonst sperrt eine spätere Erhöhung von N alle bestehenden Konten aus.
    // Dafür wird hier bewusst einer mit dem halben N erzeugt — nicht derselbe
    // Hash noch einmal.
    const legacyN = Number(N) / 2;
    const salt = randomBytes(16);
    const key = await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        "parameter-im-hash-test",
        salt,
        32,
        { N: legacyN, r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 },
        (error, derived) => (error ? reject(error) : resolve(derived)),
      ),
    );
    const legacy = [
      "scrypt",
      legacyN,
      r,
      p,
      salt.toString("base64url"),
      key.toString("base64url"),
    ].join("$");

    expect(legacy).not.toBe(hash);
    expect(await verifyPassword("parameter-im-hash-test", legacy)).toBe(true);
    expect(await verifyPassword("etwas anderes", legacy)).toBe(false);
  });
});
