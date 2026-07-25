import { notImplemented, requireAdmin } from "@/lib/guard";

// POST /api/assets/:id/regenerate (SPEC §2). Stub.
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return notImplemented("asset_regenerate");
}
