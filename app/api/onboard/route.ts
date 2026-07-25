import { notImplemented, requireAdmin } from "@/lib/guard";

// POST /api/onboard { url, name?, product? } -> Scout run (SPEC §2). Stub.
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return notImplemented("scout");
}
