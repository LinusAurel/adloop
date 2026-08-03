import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { collectSetupFacts } from "@/setup/facts";
import { completedCount, deriveSetupSteps } from "@/setup/steps";

/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";

/**
 * The state of the first-time setup: which prerequisites hold, which do not,
 * and what stands in the way. Codes only (SPEC §8.2) — the reasons are stable
 * identifiers and the interface writes the sentences.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const facts = await collectSetupFacts(getPool(), auth.session.tenantId);
  const steps = deriveSetupSteps(facts);

  return NextResponse.json({
    steps,
    completed: completedCount(steps),
    total: steps.length,
    // Enough of the underlying facts to explain a verdict without a second call.
    metaConfigured: facts.metaConfigured,
    selectedAccounts: facts.selectedAccounts.length,
    imageProviders: facts.imageProviders,
  });
}
