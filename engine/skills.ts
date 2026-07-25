// Loads prompt modules (engine/skills/*.md) and brand data documents
// (brands/<slug>/*.md). Brand specifics stay data, never code (AGENTS.md).

import fs from "node:fs";
import path from "node:path";

export function loadSkill(name: string): string {
  const file = path.join(process.cwd(), "engine", "skills", `${name}.md`);
  return fs.readFileSync(file, "utf8");
}

export function loadBrandDoc(slug: string, file: string): string | null {
  const p = path.join(process.cwd(), "brands", slug, file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}
