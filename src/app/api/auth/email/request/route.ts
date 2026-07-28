import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requestLoginCode } from "@/auth/login-code";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";

const BodySchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const outcome = await requestLoginCode(getPool(), parsed.data.email);
  if (outcome === "rate_limited") {
    return errorResponse(429, "login_rate_limited", { retryAfterSeconds: 900 });
  }

  return NextResponse.json({ status: "code_requested" }, { status: 202 });
}
