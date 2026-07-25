import { notImplemented, requireAdmin } from "@/lib/guard";

// POST /api/angles/:id/approve (SPEC §2). Stub — approve is a human gate.
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return notImplemented("angle_approve");
}
