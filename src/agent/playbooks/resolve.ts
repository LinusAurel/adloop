import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { constants as fsConstants } from "node:fs";
import type { Queryable } from "@/db/queryable";
import { hashPlaybookFiles } from "@/lib/canonical-json";
// PLAYBOOK_DIR is read from process.env (not cached env) so tests can
// point at a temp directory without resetting the env proxy.

export type PlaybookSource = "db" | "dir" | "bundled";

/** Shipped defaults live here — the open base every install starts from. */
const BUNDLED_ROOT = join(process.cwd(), "playbooks");

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
 * Resolution order:
 *
 * 1. Active DB override for (tenant, slug) — what the operator edited
 * 2. PLAYBOOK_DIR/<slug>/ — private playbooks, not in this repo
 * 3. playbooks/<slug>/ — the shipped defaults
 *
 * The shipped defaults were added because the chain had no floor: without
 * PLAYBOOK_DIR every agent run aborted with playbook_missing, which made a
 * fresh install look broken rather than unconfigured. They are the open base
 * of the open core — private playbooks refine them, they do not replace a void.
 *
 * There is no separate test fixture directory. Tests that need a specific text
 * point PLAYBOOK_DIR at a temp directory; everything else runs against the same
 * defaults production runs on, which is the only way a test says anything about
 * production.
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

  const bundled = await readPlaybookDirectory(join(BUNDLED_ROOT, params.slug));
  if (bundled) {
    const contentHash = hashPlaybookFiles(bundled);
    return {
      slug: params.slug,
      source: "bundled",
      files: bundled,
      contentHash,
      version: `bundled:${contentHash}`,
    };
  }

  throw new PlaybookMissingError(params.slug);
}

/**
 * Every playbook the operator can see, with where it currently comes from.
 * Slugs are the union of what is shipped, what a private directory adds, and
 * what has been overridden — an override for a slug that no longer ships must
 * stay visible, or it would keep taking effect invisibly.
 */
export async function listPlaybooks(
  db: Queryable,
  params: { tenantId: string },
): Promise<Array<{ slug: string; source: PlaybookSource; files: Record<string, string> }>> {
  const slugs = new Set<string>();

  for (const root of [BUNDLED_ROOT, process.env.PLAYBOOK_DIR].filter(Boolean) as string[]) {
    if (!(await pathExists(root))) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) slugs.add(entry.name);
    }
  }

  const overridden = await db.query<{ playbook_slug: string }>(
    `SELECT playbook_slug FROM playbook_override
     WHERE tenant_id = $1 AND active = true`,
    [params.tenantId],
  );
  for (const row of overridden.rows) slugs.add(row.playbook_slug);

  const out = [];
  for (const slug of [...slugs].sort()) {
    const resolved = await resolvePlaybook(db, { tenantId: params.tenantId, slug });
    out.push({ slug, source: resolved.source, files: { ...resolved.files } });
  }
  return out;
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
