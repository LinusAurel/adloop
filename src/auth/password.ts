import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Eigene Hülle statt promisify: promisify löst die Überladung mit Optionen
// nicht auf, und ohne Optionen liefe scrypt mit seinen schwachen Vorgaben.
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * scrypt aus node:crypto statt argon2 aus npm.
 *
 * argon2id wäre die stärkere Wahl, kostet aber eine native Abhängigkeit, die
 * bei jedem Docker-Build kompiliert werden muss. scrypt ist im Standard
 * enthalten, in derselben Klasse speicherhart und für ein Werkzeug mit einer
 * Handvoll Konten ausreichend. Der Kostenfaktor steht hier und im Hash, damit
 * er später steigen kann, ohne alte Hashes ungültig zu machen.
 */
const N = 1 << 15; // 32768 — rund 100 ms auf gängiger Hardware
const r = 8;
const p = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * scrypt bricht ab, wenn 128 · N · r über maxmem liegt — mit den Werten oben
 * sind das 33,5 MB gegen eine Vorgabe von 32 MB, also knapp darüber. Ohne
 * diese Zeile scheitert jeder Aufruf mit "memory limit exceeded", und zwar
 * erst zur Laufzeit. Der Wert lässt Luft für ein späteres höheres N.
 */
const MAX_MEM = 128 * 1024 * 1024;

/** Format: `scrypt$N$r$p$<salt base64url>$<hash base64url>` */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error("password_too_short");
  }
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEM });
  return [
    "scrypt",
    N,
    r,
    p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * Prüft ein Passwort gegen einen gespeicherten Hash. Gibt bei jedem Fehler
 * `false` zurück statt zu werfen — ein Aufrufer, der zwischen "falsches
 * Passwort" und "kaputter Hash" unterscheiden kann, verrät das nach außen.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const params = {
    N: Number(nRaw),
    r: Number(rRaw),
    p: Number(pRaw),
    maxmem: MAX_MEM,
  };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return false;
  }

  try {
    const salt = Buffer.from(saltRaw!, "base64url");
    const expected = Buffer.from(hashRaw!, "base64url");

    // Ohne diese Prüfung wäre `scrypt$N$r$p$<salt>$` ein Generalschlüssel:
    // die erwartete Länge wäre 0, scrypt lieferte einen leeren Puffer, und
    // timingSafeEqual hält zwei leere Puffer für gleich. Jedes Passwort
    // passte. Ein zu kurzes Salz schwächt das Verfahren ebenso.
    if (expected.length !== KEY_LENGTH || salt.length < SALT_LENGTH) return false;
    const actual = await scryptAsync(password, salt, expected.length, params);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
