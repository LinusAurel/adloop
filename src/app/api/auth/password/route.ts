import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateWithPassword, enabledMethods } from "@/auth/methods";
import { createSession, encodeSession, setSessionCookie } from "@/auth/session";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";

/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

/**
 * Anmeldung mit Passwort — deckt sowohl das Umgebungskonto als auch Konten aus
 * der Datenbank ab, weil beide dieselbe Eingabe verlangen und der Mensch davor
 * den Unterschied nicht kennen muss.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const methods = enabledMethods();
  if (!methods.includes("env") && !methods.includes("password")) {
    return errorResponse(400, "method_not_enabled");
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const identity = await authenticateWithPassword(
    getPool(),
    parsed.data.email,
    parsed.data.password,
  );

  // Ein einziger Fehlercode für "gibt es nicht" und "Passwort falsch" — alles
  // andere erlaubt es, gültige Konten zu erraten.
  if (!identity) return errorResponse(401, "invalid_credentials");

  const session = createSession(identity.userId, identity.tenantId);
  const response = NextResponse.json({ status: "signed_in" });
  setSessionCookie(response, session);
  return response;
}

/** Welche Wege der Anmeldebildschirm anbieten soll. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ methods: enabledMethods() });
}
