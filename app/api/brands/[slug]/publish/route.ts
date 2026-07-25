import { notImplemented, requireAdmin } from "@/lib/guard";

// POST /api/brands/:slug/publish -> Publisher (SPEC §2). Stub.
// Hard rule: any Meta publish is forced to status PAUSED server-side.
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return notImplemented("publisher");
}
