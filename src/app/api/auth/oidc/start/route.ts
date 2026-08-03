import { NextRequest, NextResponse } from "next/server";
import { enabledMethods } from "@/auth/methods";
import { failureCode, startAuthorization } from "@/auth/oidc";
import { errorResponse } from "@/lib/api-error";

/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";

export const OIDC_STATE_COOKIE = "adloop_oidc_state";
export const OIDC_VERIFIER_COOKIE = "adloop_oidc_verifier";
export const OIDC_NEXT_COOKIE = "adloop_oidc_next";

/** Schickt zum Identitätsanbieter und merkt sich, was für die Rückkehr nötig ist. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!enabledMethods().includes("oidc")) return errorResponse(400, "method_not_enabled");

  let start;
  try {
    start = await startAuthorization();
  } catch (error) {
    return errorResponse(502, failureCode(error));
  }

  const response = NextResponse.redirect(start.url);
  // Kurzlebig und httpOnly: State und Verifier sind Einmalgeheimnisse für
  // genau diesen Anmeldeversuch, kein Client-Code darf sie lesen.
  const options = {
    path: "/",
    maxAge: 10 * 60,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: request.nextUrl.protocol === "https:",
  };
  response.cookies.set(OIDC_STATE_COOKIE, start.state, options);
  response.cookies.set(OIDC_VERIFIER_COOKIE, start.codeVerifier, options);

  const next = request.nextUrl.searchParams.get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    response.cookies.set(OIDC_NEXT_COOKIE, next, options);
  }
  return response;
}
