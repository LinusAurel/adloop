import { NextRequest, NextResponse } from "next/server";
import { uuidv7 } from "uuidv7";
import { enabledMethods } from "@/auth/methods";
import { domainAllowed, exchangeCode, failureCode } from "@/auth/oidc";
import { createSession, setSessionCookie } from "@/auth/session";
import { getPool } from "@/db/pool";
import {
  OIDC_NEXT_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_VERIFIER_COOKIE,
} from "../start/route";

/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";

/** Der einzige Mandant im Einzelbetrieb — dieselbe Kennung wie im Seed. */
const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

/** Fehler landen auf der Anmeldeseite, nicht in einer nackten JSON-Antwort. */
function backToLogin(request: NextRequest, code: string): NextResponse {
  const target = request.nextUrl.clone();
  target.pathname = "/login";
  target.search = `?error=${encodeURIComponent(code)}`;
  const response = NextResponse.redirect(target);
  for (const name of [OIDC_STATE_COOKIE, OIDC_VERIFIER_COOKIE, OIDC_NEXT_COOKIE]) {
    response.cookies.delete(name);
  }
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!enabledMethods().includes("oidc")) return backToLogin(request, "method_not_enabled");

  const params = request.nextUrl.searchParams;
  if (params.get("error")) return backToLogin(request, params.get("error")!);

  const code = params.get("code");
  const state = params.get("state");
  const expectedState = request.cookies.get(OIDC_STATE_COOKIE)?.value;
  const verifier = request.cookies.get(OIDC_VERIFIER_COOKIE)?.value;

  // State muss vorhanden sein *und* übereinstimmen. Ein fehlender erwarteter
  // State ist kein Freifahrtschein — genau so sähe ein untergeschobener
  // Anmeldeversuch aus.
  if (!code || !state || !expectedState || !verifier || state !== expectedState) {
    return backToLogin(request, "oidc_state_mismatch");
  }

  let claims;
  try {
    claims = await exchangeCode(code, verifier);
  } catch (error) {
    return backToLogin(request, failureCode(error));
  }

  const email = claims.email?.trim().toLowerCase();
  if (!email) return backToLogin(request, "oidc_no_email");
  if (!domainAllowed(email)) return backToLogin(request, "oidc_domain_not_allowed");

  const pool = getPool();

  // Die stabile Kennung des Anbieters entscheidet, nicht die Mailadresse:
  // Adressen ändern sich, `sub` nicht. Erst danach wird über die Adresse
  // zugeordnet, damit ein bestehendes lokales Konto nicht doppelt entsteht.
  const bySubject = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM app_user WHERE oidc_subject = $1`,
    [claims.sub],
  );

  let userId = bySubject.rows[0]?.id;
  let tenantId = bySubject.rows[0]?.tenant_id;

  if (!userId) {
    const byEmail = await pool.query<{ id: string; tenant_id: string }>(
      `UPDATE app_user
       SET oidc_subject = $1, auth_source = 'oidc'
       WHERE email = $2 AND oidc_subject IS NULL
       RETURNING id, tenant_id`,
      [claims.sub, email],
    );
    userId = byEmail.rows[0]?.id;
    tenantId = byEmail.rows[0]?.tenant_id;
  }

  if (!userId) {
    const id = uuidv7();
    const created = await pool.query<{ id: string; tenant_id: string }>(
      `INSERT INTO app_user (id, tenant_id, email, role, auth_source, oidc_subject)
       VALUES ($1, $2, $3, 'member', 'oidc', $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, tenant_id`,
      [id, DEFAULT_TENANT, email, claims.sub],
    );
    userId = created.rows[0]?.id;
    tenantId = created.rows[0]?.tenant_id;
  }

  if (!userId || !tenantId) return backToLogin(request, "oidc_account_conflict");

  const next = request.cookies.get(OIDC_NEXT_COOKIE)?.value;
  const target = request.nextUrl.clone();
  target.pathname = next && next.startsWith("/") && !next.startsWith("//") ? next : "/chat";
  target.search = "";

  const response = NextResponse.redirect(target);
  setSessionCookie(response, createSession(userId, tenantId));
  for (const name of [OIDC_STATE_COOKIE, OIDC_VERIFIER_COOKIE, OIDC_NEXT_COOKIE]) {
    response.cookies.delete(name);
  }
  return response;
}
