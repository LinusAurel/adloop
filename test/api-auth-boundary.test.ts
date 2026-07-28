import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return routeFiles(path);
      return entry.name === "route.ts" ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("API authentication boundary", () => {
  it("routes every non-public API through the central session guard", async () => {
    const root = join(__dirname, "..", "src", "app", "api");
    const publicRoutes = new Set([
      "auth/email/request/route.ts",
      "auth/email/verify/route.ts",
      "health/route.ts",
    ]);
    const missing: string[] = [];

    for (const file of await routeFiles(root)) {
      const name = relative(root, file);
      if (publicRoutes.has(name)) continue;
      const body = await readFile(file, "utf8");
      if (!body.includes("authenticate(")) missing.push(name);
    }

    expect(missing).toEqual([]);
  });
});
