import fs from "node:fs";
import path from "node:path";

// /pitch serves the standalone deck (pitch/index.html) directly — one source
// of truth instead of a React duplicate. Screenshot paths are rewritten to
// the public/ copies so the images resolve on the deployment.
export async function GET() {
  const file = path.join(process.cwd(), "pitch", "index.html");
  if (!fs.existsSync(file)) {
    return new Response("Deck not found", { status: 404 });
  }
  const html = fs
    .readFileSync(file, "utf8")
    .replaceAll("screenshots/", "/pitch-screenshots/");
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
