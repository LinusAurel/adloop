import { NextResponse } from "next/server";

// Mutation guard per SPEC.md §7b: in a public deployment, publish/optimize/
// approve etc. require the x-admin-secret header. In local dev the guard is
// open. Secret values are never logged.
export function requireAdmin(req: Request): NextResponse | null {
  if (process.env.NODE_ENV === "development") return null;
  const secret = process.env.ADLOOP_ADMIN_SECRET;
  const given = req.headers.get("x-admin-secret");
  if (!secret || given !== secret) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", hint: "x-admin-secret Header fehlt oder ist falsch" },
      { status: 401 },
    );
  }
  return null;
}

export function notImplemented(stage: string): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "not_implemented",
      stage,
      hint: "Stub — Pipeline-Stufe folgt (SPEC §3)",
    },
    { status: 501 },
  );
}
