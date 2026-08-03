import type { Queryable } from "@/db/queryable";
import { env } from "@/lib/env";
import { verifyPassword } from "./password";

export const ALL_METHODS = ["env", "password", "oidc", "code"] as const;
export type AuthMethod = (typeof ALL_METHODS)[number];

/**
 * Welche Wege in dieser Installation wirklich benutzbar sind.
 *
 * Ein Weg zählt nur, wenn er in AUTH_METHODS steht *und* seine Voraussetzungen
 * erfüllt sind. Ein Anmeldebildschirm, der einen Weg anbietet, der beim Klick
 * an einer fehlenden Variablen scheitert, ist schlimmer als einer, der ihn gar
 * nicht zeigt.
 */
export function enabledMethods(): AuthMethod[] {
  const requested = env.AUTH_METHODS.split(",")
    .map((value) => value.trim())
    .filter((value): value is AuthMethod => (ALL_METHODS as readonly string[]).includes(value));

  return requested.filter((method) => {
    switch (method) {
      case "env":
        return Boolean(env.ADLOOP_ADMIN_EMAIL && env.ADLOOP_ADMIN_PASSWORD_HASH);
      case "oidc":
        return Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET);
      case "code":
        // Ohne Zustelladapter kommt der Code nirgends an.
        return env.AUTH_CODE_DELIVERY !== "disabled";
      case "password":
        return true;
    }
  });
}

/** Die feste Identität des Umgebungskontos — es steht in keiner Tabelle. */
export const ENV_ACCOUNT = {
  userId: "00000000-0000-0000-0000-0000000000e0",
  tenantId: "00000000-0000-0000-0000-000000000001",
} as const;

export interface AuthenticatedIdentity {
  userId: string;
  tenantId: string;
  method: AuthMethod;
}

/**
 * Prüft E-Mail und Passwort gegen die aktiven Wege — erst das Umgebungskonto,
 * dann die Datenbank.
 *
 * Gibt bei jedem Misserfolg dasselbe `null` zurück. Wer zwischen "Konto gibt es
 * nicht" und "Passwort falsch" unterscheiden kann, kann Konten aufzählen.
 */
export async function authenticateWithPassword(
  db: Queryable,
  email: string,
  password: string,
): Promise<AuthenticatedIdentity | null> {
  const methods = enabledMethods();
  const normalized = email.trim().toLowerCase();

  if (
    methods.includes("env") &&
    env.ADLOOP_ADMIN_EMAIL &&
    env.ADLOOP_ADMIN_PASSWORD_HASH &&
    normalized === env.ADLOOP_ADMIN_EMAIL.toLowerCase() &&
    (await verifyPassword(password, env.ADLOOP_ADMIN_PASSWORD_HASH))
  ) {
    return { ...ENV_ACCOUNT, method: "env" };
  }

  if (methods.includes("password")) {
    const result = await db.query<{ id: string; tenant_id: string; password_hash: string | null }>(
      `SELECT id, tenant_id, password_hash FROM app_user WHERE email = $1`,
      [normalized],
    );
    const row = result.rows[0];
    if (row?.password_hash && (await verifyPassword(password, row.password_hash))) {
      return { userId: row.id, tenantId: row.tenant_id, method: "password" };
    }
  }

  return null;
}
