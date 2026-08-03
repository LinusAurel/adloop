import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { availableImageProviders } from "@/images/registry";

/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";

/**
 * Which image providers this installation can actually use, and what each one
 * offers. Availability comes from the registry so that this picker and the
 * setup check answer the same question the same way.
 *
 * The models come from the provider itself rather than from a table here, so
 * adding a model is a change in one file instead of two that can drift apart.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const providers = availableImageProviders().map((provider) => ({
    id: provider.id,
    models: [...provider.models],
    // Sichtbar, weil es die Zusage betrifft: Ein Anbieter ohne Schutz
    // kann nach einem Absturz ein zweites Mal abrechnen.
    recovery: provider.recovery,
  }));

  return NextResponse.json({ providers });
}
