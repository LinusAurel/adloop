import { notImplemented, requireAdmin } from "@/lib/guard";

// POST /api/angles/:id/kill (SPEC §2). Stub — kill is a human gate.
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return notImplemented("angle_kill");
}
