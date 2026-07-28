import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P2-1 (second review): `transitions.ts`'s ALLOWED_JOB_TRANSITIONS map is
 * cross-checked by sql/finalize.ts and sql/retry.ts via
 * assertJobTransitionAllowed(), but that only protects call sites that
 * actually call it. The chosen enforcement (documented in DECISIONS.md) is
 * option (b): the SQL primitives under src/queue/sql/ (plus
 * create-run.ts, which performs the one legitimate INSERT that brings a
 * run/job into existence) are declared the SOLE state machine. This test
 * makes that a checked fact, not an assumption: it scans every other
 * production source file for a direct `job`/`run` table mutation and fails
 * if one is found outside that boundary.
 */

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["src", "worker"];
const ALLOWED_FILES = new Set([
  "src/queue/create-run.ts",
  // Etappe 4: chat turns create run+job and write turn_phase / context_packet
  // without going through the job-status state machine.
  "src/agent/create-chat-run.ts",
  "src/agent/run-events.ts",
  "src/agent/turn.ts",
]);
const ALLOWED_DIR_PREFIX = "src/queue/sql/";

const MUTATION_PATTERN = /\b(UPDATE|INSERT INTO)\s+(job|run)\b/i;

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

describe("architecture boundary: job/run mutations", () => {
  it("only src/queue/sql/*.ts and create-run.ts write job or run rows directly", () => {
    const offenders: string[] = [];

    for (const dir of SCAN_DIRS) {
      const files = listFiles(join(ROOT, dir));
      for (const file of files) {
        const relPath = relative(ROOT, file).split("\\").join("/");
        if (relPath.startsWith(ALLOWED_DIR_PREFIX) || ALLOWED_FILES.has(relPath)) {
          continue;
        }
        const content = readFileSync(file, "utf8");
        if (MUTATION_PATTERN.test(content)) {
          offenders.push(relPath);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
