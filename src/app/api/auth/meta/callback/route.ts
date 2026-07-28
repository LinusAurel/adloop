import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { completeMetaOAuth, metaConfiguration } from "@/meta/oauth";

function connectorsRedirect(request: NextRequest, key: string, value: string): NextResponse {
  const url = new URL("/connectors", request.url);
  url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const configuration = metaConfiguration();
  if (!configuration) return errorResponse(503, "meta_not_configured");

  const providerError = request.nextUrl.searchParams.get("error");
  if (providerError) return connectorsRedirect(request, "error", "meta_oauth_denied");

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) return errorResponse(400, "invalid_oauth_callback");

  try {
    await completeMetaOAuth({
      pool: getPool(),
      session: auth.session,
      code,
      state,
      configuration,
    });
    return connectorsRedirect(request, "meta", "connected");
  } catch (error) {
    const code =
      error instanceof Error &&
      ["invalid_oauth_state", "missing_meta_scopes"].includes(error.message)
        ? error.message
        : "meta_oauth_failed";
    return connectorsRedirect(request, "error", code);
  }
}
