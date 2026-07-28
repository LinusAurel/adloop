import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { clearSessionCookie } from "@/auth/session";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const response = NextResponse.json({ status: "logged_out" });
  clearSessionCookie(response);
  return response;
}
