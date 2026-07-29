import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { LOCALE_COOKIE, isLocale, locales } from "@/i18n/config";

/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";

const BodySchema = z.object({ locale: z.enum(locales) });

/**
 * Sets ui_locale. The cookie is what the next render reads; the column is what
 * survives a new browser. Both are written, and the cookie is set even when
 * nobody is signed in — the login screen has a language too.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "validation_error");
  }
  const { locale } = parsed.data;

  const response = NextResponse.json({ locale });
  response.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    // Readable by the client on purpose: the switcher shows the current choice
    // without a round trip. It carries no secret.
    httpOnly: false,
  });

  const auth = authenticate(request);
  if (auth.ok) {
    await getPool().query(`UPDATE app_user SET ui_locale = $1 WHERE id = $2`, [
      locale,
      auth.session.userId,
    ]);
  }
  return response;
}

/** Current choice, for a client that wants to render the switcher itself. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cookie = request.cookies.get(LOCALE_COOKIE)?.value;
  return NextResponse.json({ locale: isLocale(cookie) ? cookie : null });
}
