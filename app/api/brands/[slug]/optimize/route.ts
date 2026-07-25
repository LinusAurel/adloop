import { notImplemented, requireAdmin } from "@/lib/guard";

// POST /api/brands/:slug/optimize -> Analyst/Mining (SPEC §2). Stub.
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return notImplemented("analyst");
}
