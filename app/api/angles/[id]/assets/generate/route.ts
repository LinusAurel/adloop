import { notImplemented, requireAdmin } from "@/lib/guard";

// POST /api/angles/:id/assets/generate -> Copywriter->Critic->Designer. Stub.
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return notImplemented("copywriter_critic_designer");
}
