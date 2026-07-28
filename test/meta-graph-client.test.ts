import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MetaGraphClient,
  MetaGraphError,
  type PageResult,
} from "@/meta/graph-client";
import page1 from "./fixtures/meta/ad-accounts-page-1.json";
import page2 from "./fixtures/meta/ad-accounts-page-2.json";
import page3 from "./fixtures/meta/ad-accounts-page-3.json";
import rateLimit from "./fixtures/meta/rate-limit-code-17.json";

const ItemSchema = z.object({ id: z.string() }).passthrough();
const PageSchema: z.ZodType<PageResult<z.infer<typeof ItemSchema>>> = z.object({
  data: z.array(ItemSchema),
  paging: z
    .object({
      next: z.string().optional(),
      cursors: z.object({ after: z.string().optional() }).optional(),
    })
    .optional(),
});

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("MetaGraphClient", () => {
  it("follows all paging.next links and exposes a token-free resume cursor", async () => {
    const responses = [page1, page2, page3];
    const requested: string[] = [];
    const cursors: Array<string | null> = [];
    const client = new MetaGraphClient({
      accessToken: "synthetic-access-token",
      apiVersion: "v25.0",
      fetchImpl: async (input) => {
        requested.push(String(input));
        return jsonResponse(responses.shift());
      },
    });

    const ids: string[] = [];
    const count = await client.paginate({
      path: "/me/adaccounts",
      pageSchema: PageSchema,
      onPage: async (page) => {
        ids.push(...page.data.map((item) => item.id));
        cursors.push(page.nextCursor);
      },
    });

    expect(count).toBe(3);
    expect(ids).toEqual([
      "act_000000000000000",
      "act_000000000000001",
      "act_000000000000002",
    ]);
    expect(requested).toHaveLength(3);
    expect(cursors[0]).toBe("/v25.0/me/adaccounts?after=cursor-1");
    expect(cursors.join("")).not.toContain("synthetic-access-token");
  });

  it("waits and retries code 17 instead of aborting", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = new MetaGraphClient({
      accessToken: "synthetic-access-token",
      apiVersion: "v25.0",
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(rateLimit, 429, {
              "x-business-use-case-usage":
                '{"act_000000000000000":[{"estimated_time_to_regain_access":0.001}]}',
            })
          : jsonResponse({ id: "ok" });
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await expect(client.request("/me", z.object({ id: z.string() }))).resolves.toMatchObject({
      data: { id: "ok" },
    });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([60]);
  });

  it("passes through Meta diagnostics without exposing the access token", async () => {
    const client = new MetaGraphClient({
      accessToken: "synthetic-access-token",
      apiVersion: "v25.0",
      maxRateLimitRetries: 0,
      fetchImpl: async () => jsonResponse(rateLimit, 429),
    });

    const error = await client
      .request("/me", z.object({ id: z.string() }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MetaGraphError);
    expect(error).toMatchObject({
      code: 17,
      errorSubcode: 99,
      errorUserMessage: "Synthetic retry message",
      fbtraceId: "fixture-trace-id",
    });
    expect(String(error)).not.toContain("synthetic-access-token");
  });
});
