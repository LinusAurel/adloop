import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { clearSessionCookie } from "@/auth/session";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const response = NextResponse.json({ status: "logged_out" });
  clearSessionCookie(response);
  return response;
}
