import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx|sql)$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("reach aggregation contract", () => {
  it("contains no query that sums reach across dates", async () => {
    const files = [
      ...(await sourceFiles(join(__dirname, "..", "src"))),
      ...(await sourceFiles(join(__dirname, "..", "migrations"))),
    ];
    const violations: string[] = [];
    for (const file of files) {
      const body = await readFile(file, "utf8");
      if (/\bsum\s*\(\s*(?:\w+\.)?reach\s*\)/i.test(body)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});
