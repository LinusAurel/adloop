import { NextResponse } from "next/server";

import { getPool } from "@/db/pool";

export const dynamic = "force-dynamic";

/**
 * Liveness + readiness for the platform's health check.
 *
 * A web process that answers 200 while the database is unreachable would keep a
 * broken deploy in rotation, so this touches Postgres. Codes only — no prose
 * from the backend (SPEC §8.2).
 */
export async function GET() {
  try {
    await getPool().query("SELECT 1");
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "degraded", code: "db_unreachable" }, { status: 503 });
  }
}
