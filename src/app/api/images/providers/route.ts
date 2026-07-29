import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/auth/guard";
import { getImageProvider } from "@/images/registry";

/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";

const CANDIDATES = ["fal", "openai-images", "stub"] as const;

/**
 * Which image providers this installation can actually use, and what each one
 * offers. The list is built by asking the registry to construct each provider:
 * one without its API key throws, and a provider nobody can call has no place
 * in a picker.
 *
 * The models come from the provider itself rather than from a table here, so
 * adding a model is a change in one file instead of two that can drift apart.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const providers = CANDIDATES.flatMap((id) => {
    try {
      const provider = getImageProvider(id);
      return [
        {
          id: provider.id,
          models: [...provider.models],
          // Sichtbar, weil es die Zusage betrifft: Ein Anbieter ohne Schutz
          // kann nach einem Absturz ein zweites Mal abrechnen.
          recovery: provider.recovery,
        },
      ];
    } catch {
      return [];
    }
  });

  return NextResponse.json({ providers });
}
