import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { META_INSIGHT_FIELDS } from "@/meta/insight-sync";

const execFileAsync = promisify(execFile);

describe("live Meta Insights field contract", () => {
  it("accepts every field used by the sync", async () => {
    expect(process.env.AD_ACCOUNT_ID, "AD_ACCOUNT_ID must be set").toBeTruthy();

    try {
      await execFileAsync(
        "meta",
        ["ads", "insights", "get", "--fields", META_INSIGHT_FIELDS.join(",")],
        { env: process.env, timeout: 25_000 },
      );
    } catch (error) {
      const failure = error as Error & { stderr?: string; stdout?: string };
      const output = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`.trim();
      const unknownField = output.match(
        /([a-z][a-z0-9_]*) is not valid for fields param/i,
      )?.[1];
      if (unknownField) {
        throw new Error(`Unknown Meta Insights field: ${unknownField}`);
      }
      throw new Error(`Meta Insights field contract request failed: ${output || failure.message}`);
    }
  });
});
