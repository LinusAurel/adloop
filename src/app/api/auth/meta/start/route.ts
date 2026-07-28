import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { createOAuthUrl, metaConfiguration } from "@/meta/oauth";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const configuration = metaConfiguration();
  if (!configuration) return errorResponse(503, "meta_not_configured");

  const url = await createOAuthUrl(getPool(), auth.session, configuration);
  return NextResponse.redirect(url);
}
