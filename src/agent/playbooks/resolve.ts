import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { constants as fsConstants } from "node:fs";
import type { Queryable } from "@/db/queryable";
import { hashPlaybookFiles } from "@/lib/canonical-json";
// PLAYBOOK_DIR is read from process.env (not cached env) so tests can
// point at a temp directory without resetting the env proxy.

export type PlaybookSource = "db" | "dir" | "fixture";

export interface ResolvedPlaybook {
  slug: string;
  source: PlaybookSource;
  files: Readonly<Record<string, string>>;
  contentHash: string;
  /** `<source>:<sha256>` — stored on run.playbook_version */
  version: string;
}

export class PlaybookMissingError extends Error {
  readonly code = "playbook_missing";
  constructor(readonly slug: string) {
    super(`playbook_missing:${slug}`);
    this.name = "PlaybookMissingError";
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readPlaybookDirectory(
  root: string,
): Promise<Record<string, string> | null> {
  if (!(await pathExists(join(root, "PLAYBOOK.md")))) return null;
  const files: Record<string, string> = {};
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files[entry.name] = await readFile(join(root, entry.name), "utf8");
  }
  return files;
}

/**
 * Resolution order (auftrag §0.5 — overrides SPEC §7.2 and removes
 * ALLOW_SYNTHETIC_PLAYBOOKS):
 *
 * 1. Active DB override for (tenant, slug)
 * 2. PLAYBOOK_DIR/<slug>/
 * 3. fixtures/<slug>/ — ONLY when NODE_ENV=test
 *
 * Fail-closed in production: missing private playbook aborts; never falls
 * through to a fixture.
 */
export async function resolvePlaybook(
  db: Queryable,
  params: { tenantId: string; slug: string },
): Promise<ResolvedPlaybook> {
  const override = await db.query<{
    files: Record<string, string>;
    content_hash: string;
  }>(
    `SELECT files, content_hash FROM playbook_override
     WHERE tenant_id = $1 AND playbook_slug = $2 AND active = true
     LIMIT 1`,
    [params.tenantId, params.slug],
  );
  const dbRow = override.rows[0];
  if (dbRow) {
    const files = dbRow.files;
    const contentHash = hashPlaybookFiles(files);
    return {
      slug: params.slug,
      source: "db",
      files,
      contentHash,
      version: `db:${contentHash}`,
    };
  }

  const playbookDir = process.env.PLAYBOOK_DIR;
  if (playbookDir) {
    const fromDir = await readPlaybookDirectory(join(playbookDir, params.slug));
    if (fromDir) {
      const contentHash = hashPlaybookFiles(fromDir);
      return {
        slug: params.slug,
        source: "dir",
        files: fromDir,
        contentHash,
        version: `dir:${contentHash}`,
      };
    }
  }

  if (process.env.NODE_ENV === "test") {
    const fixtureRoot = join(process.cwd(), "fixtures", "playbooks", params.slug);
    const fromFixture = await readPlaybookDirectory(fixtureRoot);
    if (fromFixture) {
      const contentHash = hashPlaybookFiles(fromFixture);
      return {
        slug: params.slug,
        source: "fixture",
        files: fromFixture,
        contentHash,
        version: `fixture:${contentHash}`,
      };
    }
  }

  throw new PlaybookMissingError(params.slug);
}

export function playbookBody(playbook: ResolvedPlaybook): string {
  const main = playbook.files["PLAYBOOK.md"] ?? "";
  const extras = Object.keys(playbook.files)
    .filter((name) => name !== "PLAYBOOK.md")
    .sort()
    .map((name) => `\n\n## File: ${name}\n\n${playbook.files[name]}`)
    .join("");
  return main + extras;
}
