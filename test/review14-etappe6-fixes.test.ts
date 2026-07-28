import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { uuidv7 } from "uuidv7";
import { setPoolForTests } from "@/db/pool";
import { type TestDb, startTestDb } from "./db-harness";
import {
  MemoryObjectStore,
  policyAllowsPublicRead,
  setObjectStoreForTests,
} from "@/storage/object-store";
import { setImageProviderForTests } from "@/images/registry";
import { StubImageProvider } from "@/images/providers/stub";
import {
  setCopyGeneratorForTests,
  StubCopyGenerator,
} from "@/images/copy";
import {
  resolveConfiguredProvider,
  resolveGenerationInputs,
  runImageGeneration,
  ProviderNotAllowedError,
  type GenerationInputs,
} from "@/images/generate";
import {
  buildIdempotencyKey,
  callProviderWithIdempotency,
  hashGenerationRequest,
  setCrashAfterProviderSubmitForTests,
} from "@/images/idempotency";
import type { GenerationRequest, GenerationResult } from "@/images/provider";
import {
  materializeWebhookResult,
  POST as falWebhookPost,
} from "@/app/api/webhooks/fal/[correlationId]/route";
import { resetEnvCacheForTests } from "@/lib/env";

describe("review 14 — etappe 6 findings", () => {
  let db: TestDb;
  let store: MemoryObjectStore;
  let advertiserId: string;

  beforeAll(async () => {
    db = await startTestDb();
    setPoolForTests(db.pool);
    setCopyGeneratorForTests(new StubCopyGenerator());
  }, 60_000);

  afterAll(async () => {
    setCrashAfterProviderSubmitForTests(null);
    setImageProviderForTests(null);
    setObjectStoreForTests(null);
    setCopyGeneratorForTests(null);
    setPoolForTests(null);
    await db.stop();
  });

  beforeEach(async () => {
    setCrashAfterProviderSubmitForTests(null);
    store = new MemoryObjectStore();
    setObjectStoreForTests(store);
    setImageProviderForTests(new StubImageProvider({ recovery: { kind: "native_key" } }));

    await db.pool.query(`DELETE FROM creative_variant`);
    await db.pool.query(`DELETE FROM creative WHERE tenant_id = $1`, [db.tenantId]);
    await db.pool.query(`DELETE FROM creative_generation WHERE tenant_id = $1`, [db.tenantId]);
    await db.pool.query(`DELETE FROM asset WHERE tenant_id = $1`, [db.tenantId]);
    await db.pool.query(`DELETE FROM idempotency_key WHERE tenant_id = $1`, [db.tenantId]);
    await db.pool.query(`DELETE FROM job WHERE tenant_id = $1`, [db.tenantId]);
    await db.pool.query(`DELETE FROM run WHERE tenant_id = $1`, [db.tenantId]);
    await db.pool.query(`DELETE FROM advertiser WHERE tenant_id = $1`, [db.tenantId]);

    advertiserId = uuidv7();
    await db.pool.query(
      `INSERT INTO advertiser (id, tenant_id, name, content_locale)
       VALUES ($1, $2, 'Review14 Co', 'en-US')`,
      [advertiserId, db.tenantId],
    );
  });

  it("F1 — correlated_callback crash waits; never blind-resubmits; webhook completes", async () => {
    const provider = new StubImageProvider({
      recovery: { kind: "correlated_callback" },
    });
    const request: GenerationRequest = {
      prompt: "fal-crash",
      aspectRatio: "1:1",
      count: 1,
      model: "stub-v1",
      webhookBaseUrl: "https://example.test",
    };
    const key = buildIdempotencyKey({
      tenantId: db.tenantId,
      operation: "image_generation",
      identity: `f1-${uuidv7()}`,
    });
    const requestHash = hashGenerationRequest(request);

    setCrashAfterProviderSubmitForTests(async (job) => {
      // Simulate process death: lose request_id AND in-memory recover cache.
      provider.discardMemory();
      await db.pool.query(
        `UPDATE idempotency_key
         SET provider_job = $1::jsonb
         WHERE key = $2`,
        [
          JSON.stringify({
            externalId: "pending",
            correlationId: job.correlationId,
            raw: { phase: "submitting" },
          }),
          key,
        ],
      );
      throw new Error("crash_before_request_id");
    });

    await expect(
      callProviderWithIdempotency(db.pool, {
        key,
        tenantId: db.tenantId,
        requestHash,
        provider,
        request,
      }),
    ).rejects.toThrow("crash_before_request_id");
    expect(provider.getSubmitCount()).toBe(1);

    setCrashAfterProviderSubmitForTests(null);

    const waiting = await callProviderWithIdempotency(db.pool, {
      key,
      tenantId: db.tenantId,
      requestHash,
      provider,
      request,
    });
    expect(waiting.kind).toBe("awaiting_callback");
    expect(provider.getSubmitCount()).toBe(1);

    const row = await db.pool.query<{ provider_job: { raw?: { phase?: string } } }>(
      `SELECT provider_job FROM idempotency_key WHERE key = $1`,
      [key],
    );
    expect(row.rows[0]?.provider_job?.raw?.phase).toBe("awaiting_callback");

    if (waiting.kind !== "awaiting_callback") return;
    const planted: GenerationResult = {
      images: [
        {
          bytesBase64: Buffer.from("webhook-bytes").toString("base64"),
          mime: "image/jpeg",
          width: 512,
          height: 512,
        },
      ],
    };
    provider.plantResult(waiting.correlationId, planted);

    const completed = await callProviderWithIdempotency(db.pool, {
      key,
      tenantId: db.tenantId,
      requestHash,
      provider,
      request,
    });
    expect(completed.kind).toBe("result");
    expect(provider.getSubmitCount()).toBe(1);
  });

  it("F2 — webhook without secret returns 503; bad signature 401; good signature accepted", async () => {
    const correlationId = uuidv7();
    const key = `tenant:${db.tenantId}:f2`;
    await db.pool.query(
      `INSERT INTO idempotency_key (
         key, tenant_id, request_hash, status, correlation_id, provider
       ) VALUES ($1, $2, 'hash', 'in_flight', $3, 'fal')`,
      [key, db.tenantId, correlationId],
    );

    const body = JSON.stringify({
      images: [
        {
          bytesBase64: Buffer.from("ok").toString("base64"),
          content_type: "image/png",
          width: 10,
          height: 10,
        },
      ],
    });

    const prevSecret = process.env.FAL_WEBHOOK_SECRET;
    delete process.env.FAL_WEBHOOK_SECRET;
    resetEnvCacheForTests();

    const unconfigured = await falWebhookPost(
      new NextRequest("http://localhost/api/webhooks/fal/" + correlationId, {
        method: "POST",
        body,
      }),
      { params: Promise.resolve({ correlationId }) },
    );
    expect(unconfigured.status).toBe(503);
    const unconfiguredBody = (await unconfigured.json()) as { error: string };
    expect(unconfiguredBody.error).toBe("webhook_not_configured");

    process.env.FAL_WEBHOOK_SECRET = "test-fal-webhook-secret";
    resetEnvCacheForTests();

    const badSig = await falWebhookPost(
      new NextRequest("http://localhost/api/webhooks/fal/" + correlationId, {
        method: "POST",
        body,
        headers: { "x-fal-webhook-signature": "deadbeef" },
      }),
      { params: Promise.resolve({ correlationId }) },
    );
    expect(badSig.status).toBe(401);

    const goodSig = createHmac("sha256", "test-fal-webhook-secret")
      .update(body)
      .digest("hex");
    const ok = await falWebhookPost(
      new NextRequest("http://localhost/api/webhooks/fal/" + correlationId, {
        method: "POST",
        body,
        headers: { "x-fal-webhook-signature": goodSig },
      }),
      { params: Promise.resolve({ correlationId }) },
    );
    expect(ok.status).toBe(200);
    const status = await db.pool.query<{ status: string }>(
      `SELECT status FROM idempotency_key WHERE key = $1`,
      [key],
    );
    expect(status.rows[0]?.status).toBe("succeeded");

    if (prevSecret === undefined) delete process.env.FAL_WEBHOOK_SECRET;
    else process.env.FAL_WEBHOOK_SECRET = prevSecret;
    resetEnvCacheForTests();
    process.env.FAL_WEBHOOK_SECRET = "test-fal-webhook-secret";
    resetEnvCacheForTests();
  });

  it("F3 — fal webhook downloads URL bytes; keeps content_type", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02]);
    const result = await materializeWebhookResult(
      {
        images: [
          {
            url: "https://v3b.fal.media/files/example.jpg",
            width: 512,
            height: 512,
            content_type: "image/jpeg",
          },
        ],
      },
      {
        async fetch(url) {
          expect(String(url)).toContain("fal.media");
          return new Response(jpegBytes, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        },
      },
    );
    expect(result).not.toBeNull();
    expect(result!.images[0]!.mime).toBe("image/jpeg");
    expect(Buffer.from(result!.images[0]!.bytesBase64, "base64").equals(jpegBytes)).toBe(
      true,
    );
    // Must NOT be base64 of the URL string.
    expect(result!.images[0]!.bytesBase64).not.toBe(
      Buffer.from("https://v3b.fal.media/files/example.jpg").toString("base64"),
    );
  });

  it("F4 — allowlist only under NODE_ENV=test; workshop must not force stub", async () => {
    const prev = process.env.IMAGE_PROVIDER_REQUEST_ALLOWLIST;
    const prevProvider = process.env.IMAGE_PROVIDER;
    const prevNode = process.env.NODE_ENV;

    process.env.IMAGE_PROVIDER = "fal";
    delete process.env.IMAGE_PROVIDER_REQUEST_ALLOWLIST;
    (process.env as { NODE_ENV?: string }).NODE_ENV = "test";
    resetEnvCacheForTests();
    // Mismatch without allowlist → hard error (not silent ignore).
    expect(() => resolveConfiguredProvider("stub")).toThrow(ProviderNotAllowedError);
    expect(resolveConfiguredProvider(undefined)).toBe("fal");

    process.env.IMAGE_PROVIDER_REQUEST_ALLOWLIST = "stub";
    resetEnvCacheForTests();
    expect(resolveConfiguredProvider("stub")).toBe("stub");
    expect(() => resolveConfiguredProvider("openai-images")).toThrow(
      ProviderNotAllowedError,
    );

    process.env.IMAGE_PROVIDER_REQUEST_ALLOWLIST =
      prev ?? "stub,fal,openai-images";
    if (prevProvider === undefined) delete process.env.IMAGE_PROVIDER;
    else process.env.IMAGE_PROVIDER = prevProvider;
    (process.env as { NODE_ENV?: string }).NODE_ENV = prevNode;
    resetEnvCacheForTests();
    process.env.IMAGE_PROVIDER_REQUEST_ALLOWLIST = "stub,fal,openai-images";
    resetEnvCacheForTests();

    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const workshop = readFileSync(
      join(__dirname, "../src/app/workshop/page.tsx"),
      "utf8",
    );
    expect(workshop).not.toMatch(/provider:\s*["']stub["']/);
  });

  it("F5 — partial creatives resume to expected count", async () => {
    const provider = new StubImageProvider({ recovery: { kind: "native_key" } });
    setImageProviderForTests(provider);

    const clientRequestId = uuidv7();
    const inputs: GenerationInputs = {
      advertiserId,
      prompt: "partial",
      aspectRatio: "1:1",
      count: 3,
      clientRequestId,
      provider: "stub",
    };
    const resolved = await resolveGenerationInputs(db.pool, db.tenantId, inputs);
    const runId = uuidv7();
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input, created_at, updated_at)
       VALUES ($1, $2, 'image_generation', 'queued', '{}'::jsonb, now(), now())`,
      [runId, db.tenantId],
    );

    let copyCalls = 0;
    setCopyGeneratorForTests({
      async generate(params) {
        copyCalls += 1;
        if (copyCalls === 2) {
          throw new Error("copy_failed_midway");
        }
        return new StubCopyGenerator().generate(params);
      },
    });

    await expect(
      runImageGeneration(db.pool, {
        tenantId: db.tenantId,
        runId,
        inputs,
        resolved,
        objectStore: store,
      }),
    ).rejects.toThrow("copy_failed_midway");

    const mid = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM creative WHERE tenant_id = $1`,
      [db.tenantId],
    );
    expect(Number(mid.rows[0]!.n)).toBe(1);

    setCopyGeneratorForTests(new StubCopyGenerator());
    const resumed = await runImageGeneration(db.pool, {
      tenantId: db.tenantId,
      runId,
      inputs,
      resolved,
      objectStore: store,
    });
    expect(resumed.status).toBe("succeeded");
    if (resumed.status !== "succeeded") return;
    expect(resumed.creativeIds).toHaveLength(3);

    const final = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM creative WHERE tenant_id = $1`,
      [db.tenantId],
    );
    expect(Number(final.rows[0]!.n)).toBe(3);
  });

  it("F6 — public-read bucket policy is detected; private/no policy is fine", () => {
    expect(
      policyAllowsPublicRead(
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: "*",
              Action: ["s3:GetObject"],
              Resource: ["arn:aws:s3:::adloop/*"],
            },
          ],
        }),
      ),
    ).toBe(true);

    expect(
      policyAllowsPublicRead(
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Deny",
              Principal: "*",
              Action: ["s3:GetObject"],
              Resource: ["arn:aws:s3:::adloop/*"],
            },
          ],
        }),
      ),
    ).toBe(false);

    expect(policyAllowsPublicRead(undefined)).toBe(false);
  });
});
