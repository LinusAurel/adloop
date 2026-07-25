import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

// Connections (#16) — status + key storage for the external services.
//
// GET  → per-service status derived from env vars (primary source) and
//        data/settings.json (keys stored via the Configure dialog).
//        Key VALUES never leave this route — only a boolean-ish status.
// POST → stores a key in data/settings.json (gitignored: data/* is ignored,
//        only data/fixtures/ is versioned). Env stays the primary source for
//        the engine connectors; reading settings.json as a connector fallback
//        is a follow-up step.

interface Service {
  id: string;
  name: string;
  envVar: string;
}

const SERVICES: Service[] = [
  { id: "meta", name: "Meta", envVar: "META_ACCESS_TOKEN" },
  { id: "fal", name: "Fal", envVar: "FAL_KEY" },
  { id: "firecrawl", name: "Firecrawl", envVar: "FIRECRAWL_API_KEY" },
  { id: "elevenlabs", name: "ElevenLabs", envVar: "ELEVENLABS_API_KEY" },
  { id: "anthropic", name: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
];

type ConnectionStatus = "connected" | "connected (stored locally)" | "not configured";

function settingsFile(): string {
  const dataDir = process.env.ADLOOP_DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dataDir, "settings.json");
}

function readStoredKeys(): Record<string, string> {
  try {
    const raw = fs.readFileSync(settingsFile(), "utf8");
    const parsed = JSON.parse(raw) as { keys?: Record<string, string> };
    return parsed.keys ?? {};
  } catch {
    return {};
  }
}

function statusFor(service: Service, stored: Record<string, string>): ConnectionStatus {
  if ((process.env[service.envVar] ?? "").trim() !== "") return "connected";
  if ((stored[service.id] ?? "").trim() !== "") return "connected (stored locally)";
  return "not configured";
}

export async function GET() {
  const stored = readStoredKeys();
  return NextResponse.json({
    ok: true,
    connections: SERVICES.map((s) => ({
      id: s.id,
      name: s.name,
      status: statusFor(s, stored),
    })),
  });
}

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as {
    id?: unknown;
    key?: unknown;
  } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  const service = SERVICES.find((s) => s.id === id);
  if (!service || key === "" || key.length > 500) {
    return NextResponse.json(
      { ok: false, error: "invalid_body", hint: "expected { id, key }" },
      { status: 400 },
    );
  }

  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stored = readStoredKeys();
  stored[service.id] = key;
  const tmp = `${file}.tmp`;
  // Never log or echo the key value anywhere.
  fs.writeFileSync(tmp, JSON.stringify({ keys: stored }, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmp, file);

  return NextResponse.json({
    ok: true,
    id: service.id,
    status: "connected (stored locally)" satisfies ConnectionStatus,
  });
}
