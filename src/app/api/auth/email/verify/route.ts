import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyLoginCode } from "@/auth/login-code";
import { createSession, setSessionCookie } from "@/auth/session";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
const BodySchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  code: z.string().regex(/^\d{6}$/),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const login = await verifyLoginCode(getPool(), parsed.data.email, parsed.data.code);
  if (!login) return errorResponse(401, "invalid_login_code");

  const response = NextResponse.json({ status: "authenticated" });
  setSessionCookie(response, createSession(login.userId, login.tenantId));
  return response;
}
