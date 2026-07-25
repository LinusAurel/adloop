import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/guard";
import { seedDemoBrand } from "@/engine/demo-seed";

// Seeds the creators-demo fixture state into the store on deployments
// without shell access. Same logic also runs at boot via instrumentation
// when ADLOOP_DEMO_AUTOSEED=1 — this route forces a fresh reset on demand.
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const result = seedDemoBrand();
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ...result, brand: "creators-demo" });
}
