import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "adloop_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const SessionSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});

export type Session = z.infer<typeof SessionSchema>;

function signature(payload: string): Buffer {
  return createHmac("sha256", env.SESSION_SECRET).update(payload).digest();
}

export function createSession(userId: string, tenantId: string, now = Date.now()): Session {
  const issuedAt = Math.floor(now / 1000);
  return {
    userId,
    tenantId,
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_SECONDS,
  };
}

export function encodeSession(session: Session): string {
  const parsed = SessionSchema.parse(session);
  const payload = Buffer.from(JSON.stringify(parsed)).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function decodeSession(value: string, now = Date.now()): Session | null {
  const [payload, suppliedSignature, extra] = value.split(".");
  if (!payload || !suppliedSignature || extra) return null;

  const expected = signature(payload);
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  try {
    const parsed = SessionSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.expiresAt <= Math.floor(now / 1000)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function getSession(request: NextRequest): Session | null {
  const value = request.cookies.get(SESSION_COOKIE)?.value;
  return value ? decodeSession(value) : null;
}

export function setSessionCookie(response: NextResponse, session: Session): void {
  response.cookies.set(SESSION_COOKIE, encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
