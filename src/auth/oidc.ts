import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";

/**
 * OpenID Connect, Authorization Code Flow mit PKCE — von Hand statt mit einer
 * Bibliothek.
 *
 * Zur Signaturprüfung: Das ID-Token wird hier nicht gegen den JWKS geprüft.
 * Das ist zulässig, weil es über den Backchannel direkt vom Token-Endpunkt
 * kommt, über TLS, authentifiziert mit dem Client-Geheimnis (OIDC Core 3.1.3.7
 * lässt die Prüfung in genau diesem Fall entfallen). Wer das Token dort
 * fälschen kann, hat bereits TLS gebrochen — dann hilft auch die Signatur
 * nicht. Ein Implicit Flow, bei dem das Token über den Browser käme, wäre eine
 * andere Lage; den gibt es hier nicht.
 */

const DiscoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
});

export type Discovery = z.infer<typeof DiscoverySchema>;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  token_type: z.string(),
});

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
});

export type Claims = z.infer<typeof ClaimsSchema>;

let cached: { at: number; value: Discovery } | null = null;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/**
 * Die Fehler, die dieses Modul selbst wirft. Alles andere — ein abgebrochener
 * fetch, ein DNS-Fehler — trägt englische Prosa aus der Laufzeit und darf
 * nicht nach außen: der Client bekommt Codes, nie Text (SPEC §8.2).
 */
const KNOWN_FAILURES = new Set([
  "oidc_discovery_failed",
  "oidc_discovery_invalid",
  "oidc_issuer_mismatch",
  "oidc_redirect_uri_unknown",
  "oidc_token_exchange_failed",
  "oidc_token_response_invalid",
  "oidc_userinfo_failed",
  "oidc_no_email",
]);

export function failureCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  return KNOWN_FAILURES.has(raw) ? raw : "oidc_failed";
}

export function oidcConfigured(): boolean {
  return Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET);
}

export function redirectUri(): string {
  if (env.OIDC_REDIRECT_URI) return env.OIDC_REDIRECT_URI;
  if (!env.PUBLIC_BASE_URL) throw new Error("oidc_redirect_uri_unknown");
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/auth/oidc/callback`;
}

/** Das Discovery-Dokument, eine Stunde zwischengespeichert. */
export async function discover(): Promise<Discovery> {
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.value;

  const base = env.OIDC_ISSUER!.replace(/\/$/, "");
  const response = await fetch(`${base}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("oidc_discovery_failed");

  const parsed = DiscoverySchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("oidc_discovery_invalid");

  // Der Aussteller im Dokument muss zu dem passen, den wir gefragt haben —
  // sonst hat uns eine Umleitung woanders hingeführt.
  if (parsed.data.issuer.replace(/\/$/, "") !== base) {
    throw new Error("oidc_issuer_mismatch");
  }

  cached = { at: Date.now(), value: parsed.data };
  return parsed.data;
}

export interface AuthorizationStart {
  url: string;
  state: string;
  codeVerifier: string;
}

export async function startAuthorization(): Promise<AuthorizationStart> {
  const discovery = await discover();
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url");

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.OIDC_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return { url: url.toString(), state, codeVerifier };
}

/** Tauscht den Code gegen Tokens und liest die Angaben zur Person. */
export async function exchangeCode(code: string, codeVerifier: string): Promise<Claims> {
  const discovery = await discover();

  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: env.OIDC_CLIENT_ID!,
      client_secret: env.OIDC_CLIENT_SECRET!,
      code_verifier: codeVerifier,
    }),
  });
  if (!response.ok) throw new Error("oidc_token_exchange_failed");

  const tokens = TokenResponseSchema.safeParse(await response.json());
  if (!tokens.success) throw new Error("oidc_token_response_invalid");

  // Die Angaben aus dem ID-Token; wo es keines gibt, vom UserInfo-Endpunkt.
  const fromIdToken = tokens.data.id_token ? decodeClaims(tokens.data.id_token) : null;
  if (fromIdToken?.email) return fromIdToken;

  if (!discovery.userinfo_endpoint) throw new Error("oidc_no_email");
  const userinfo = await fetch(discovery.userinfo_endpoint, {
    headers: { authorization: `Bearer ${tokens.data.access_token}` },
  });
  if (!userinfo.ok) throw new Error("oidc_userinfo_failed");

  const claims = ClaimsSchema.safeParse(await userinfo.json());
  if (!claims.success || !claims.data.email) throw new Error("oidc_no_email");
  return claims.data;
}

function decodeClaims(idToken: string): Claims | null {
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = ClaimsSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Darf sich diese Adresse anmelden? Ohne gesetzte Liste jeder, den der Anbieter
 * durchlässt — die Auswahl trifft dann dort statt hier.
 */
export function domainAllowed(email: string): boolean {
  const allowed = env.OIDC_ALLOWED_DOMAINS?.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed || allowed.length === 0) return true;

  const domain = email.split("@")[1]?.toLowerCase();
  return Boolean(domain && allowed.includes(domain));
}
