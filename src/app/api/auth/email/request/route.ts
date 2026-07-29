import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requestLoginCode } from "@/auth/login-code";
import { getPool } from "@/db/pool";
import { env } from "@/lib/env";
import { errorResponse } from "@/lib/api-error";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
const BodySchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  await requestLoginCode(getPool(), parsed.data.email);

  // Wie zugestellt wurde, weiß nur der Server. Der Client soll den Hinweis
  // "der Code steht im Log" nicht raten oder fest verdrahtet zeigen — sonst
  // steht er auch dort, wo es kein Log gibt, in das jemand sehen könnte.
  return NextResponse.json(
    { status: "code_requested", delivery: env.AUTH_CODE_DELIVERY },
    { status: 202 },
  );
}
