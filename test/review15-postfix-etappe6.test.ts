import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setPoolForTests } from "@/db/pool";
import {
  acquireTwoDistinctClients,
  createBarrier,
  startTestDb,
  type TestDb,
} from "./db-harness";
import {
  MemoryObjectStore,
  policyAllowsPublicRead,
  resolveBucketPrivacyAfterPutFailure,
  setObjectStoreForTests,
} from "@/storage/object-store";
import { setImageProviderForTests } from "@/images/registry";
import { StubImageProvider } from "@/images/providers/stub";
import {
  setCopyGeneratorForTests,
  StubCopyGenerator,
} from "@/images/copy";
import {
  deterministicAssetId,
  ProviderNotAllowedError,
  resolveConfiguredProvider,
  resolveGenerationInputs,
  runImageGeneration,
  type GenerationInputs,
} from "@/images/generate";
import {
  buildIdempotencyKey,
  callProviderWithIdempotency,
  hashGenerationRequest,
  setBeforeClaimSubmitForTests,
  setCrashAfterProviderSubmitForTests,
} from "@/images/idempotency";
import type { GenerationRequest } from "@/images/provider";
import {
  downloadImageBytes,
  materializeWebhookResult,
  mimeFromMagicBytes,
} from "@/app/api/webhooks/fal/[correlationId]/route";
import { resetEnvCacheForTests } from "@/lib/env";
import { uuidv7 } from "uuidv7";

describe("review 15 — postfix etappe 6", () => {
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
    setBeforeClaimSubmitForTests(null);
    setImageProviderForTests(null);
    setObjectStoreForTests(null);
    setCopyGeneratorForTests(null);
    setPoolForTests(null);
    await db.stop();
  });

  beforeEach(async () => {
    setCrashAfterProviderSubmitForTests(null);
    setBeforeClaimSubmitForTests(null);
    store = new MemoryObjectStore();
    setObjectStoreForTests(store);
    setImageProviderForTests(
      new StubImageProvider({ recovery: { kind: "correlated_callback" } }),
    );

    await db.pool.query(`DELETE FROM creative_variant`);
    await db.pool.query(`DELETE FROM creative WHERE tenant_id = $1`, [db.tenantId]);
    await db.pool.query(`DELETE FROM creative_generation WHERE tenant_id = $1`, [db.tenantId]);
    await db.pool.query(`DELETE FROM asset WHERE tenant_id = $1`, [db.tenantId]);
    await db.pool.query(`DELETE FROM idempotency_key WHERE tenant_id = $1`, [db.tenantId]);
    await db.pool.query(`DELETE FROM advertiser WHERE tenant_id = $1`, [db.tenantId]);

    advertiserId = uuidv7();
    await db.pool.query(
      `INSERT INTO advertiser (id, tenant_id, name, content_locale)
       VALUES ($1, $2, 'Review15 Co', 'en-US')`,
      [advertiserId, db.tenantId],
    );
  });

  it("P0 — parallel submit: exactly one CAS winner on two Postgres backends", async () => {
    const provider = new StubImageProvider({
      recovery: { kind: "correlated_callback" },
    });
    const request: GenerationRequest = {
      prompt: "race",
      aspectRatio: "1:1",
      count: 1,
      model: "stub-v1",
      webhookBaseUrl: "https://example.test",
    };
    const key = buildIdempotencyKey({
      tenantId: db.tenantId,
      operation: "image_generation",
      identity: `race-${uuidv7()}`,
    });
    const requestHash = hashGenerationRequest(request);

    const { clientA, pidA, clientB, pidB, release } =
      await acquireTwoDistinctClients(db.pool);
    expect(pidA).not.toBe(pidB);

    try {
      const barrier = createBarrier(2);
      setBeforeClaimSubmitForTests(() => barrier.arrive());

      const [outcomeA, outcomeB] = await Promise.all([
        callProviderWithIdempotency(clientA, {
          key,
          tenantId: db.tenantId,
          requestHash,
          provider,
          request,
        }),
        callProviderWithIdempotency(clientB, {
          key,
          tenantId: db.tenantId,
          requestHash,
          provider,
          request,
        }),
      ]);

      expect(provider.getSubmitCount()).toBe(1);

      const terminal = [outcomeA, outcomeB].filter(
        (o) => o.kind === "result" || o.kind === "replay",
      );
      expect(terminal.length).toBeGreaterThanOrEqual(1);
      // Loser is awaiting_callback or already sees the winner's succeeded replay.
      expect([outcomeA.kind, outcomeB.kind]).not.toContain("needs_human_check");
    } finally {
      setBeforeClaimSubmitForTests(null);
      release();
    }
  });

  it("P1 — streaming download aborts past 15 MiB without Content-Length", async () => {
    const chunk = new Uint8Array(1024 * 1024); // 1 MiB
    chunk.fill(0x41);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 20) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
    });

    await expect(
      downloadImageBytes("https://v3b.fal.media/files/huge.bin", {
        async fetch() {
          return new Response(stream, {
            status: 200,
            // Intentionally no Content-Length (chunked).
            headers: { "content-type": "application/octet-stream" },
          });
        },
      }),
    ).rejects.toThrow("download_too_large");
  });

  it("P2 — MIME from HTTP header / magic bytes, never guessed jpeg", async () => {
    // Minimal WebP: RIFF....WEBP
    const webp = Buffer.alloc(16);
    webp.write("RIFF", 0);
    webp.writeUInt32LE(8, 4);
    webp.write("WEBP", 8);
    expect(mimeFromMagicBytes(webp)).toBe("image/webp");

    const result = await materializeWebhookResult(
      {
        images: [
          {
            url: "https://v3b.fal.media/files/x.webp",
            width: 64,
            height: 64,
            // no content_type from Fal
          },
        ],
      },
      {
        async fetch() {
          return new Response(webp, {
            status: 200,
            headers: { "content-type": "image/webp" },
          });
        },
      },
    );
    expect(result!.images[0]!.mime).toBe("image/webp");
  });

  it("P1 — allowlist only in test; mismatch is provider_not_allowed", () => {
    const prevNode = process.env.NODE_ENV;
    const prevAllow = process.env.IMAGE_PROVIDER_REQUEST_ALLOWLIST;
    const prevProvider = process.env.IMAGE_PROVIDER;

    process.env.IMAGE_PROVIDER = "stub";
    process.env.IMAGE_PROVIDER_REQUEST_ALLOWLIST = "fal";
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    resetEnvCacheForTests();

    expect(() => resolveConfiguredProvider("fal")).toThrow(ProviderNotAllowedError);
    expect(resolveConfiguredProvider(undefined)).toBe("stub");
    expect(resolveConfiguredProvider("stub")).toBe("stub");

    (process.env as { NODE_ENV?: string }).NODE_ENV = "test";
    resetEnvCacheForTests();
    expect(resolveConfiguredProvider("fal")).toBe("fal");

    (process.env as { NODE_ENV?: string }).NODE_ENV = prevNode;
    process.env.IMAGE_PROVIDER_REQUEST_ALLOWLIST =
      prevAllow ?? "stub,fal,openai-images";
    if (prevProvider === undefined) delete process.env.IMAGE_PROVIDER;
    else process.env.IMAGE_PROVIDER = prevProvider;
    resetEnvCacheForTests();
    process.env.IMAGE_PROVIDER_REQUEST_ALLOWLIST = "stub,fal,openai-images";
    resetEnvCacheForTests();
  });

  it("P1 — permanent copy failure does not orphan assets on retry", async () => {
    const provider = new StubImageProvider({ recovery: { kind: "native_key" } });
    setImageProviderForTests(provider);

    const clientRequestId = uuidv7();
    const inputs: GenerationInputs = {
      advertiserId,
      prompt: "orphan",
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
        // Creative 1 ok; creative 2+ always fail (permanent).
        if (copyCalls >= 2) throw new Error("copy_permanent_fail");
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
    ).rejects.toThrow("copy_permanent_fail");

    const assetsAfterFirst = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM asset WHERE tenant_id = $1`,
      [db.tenantId],
    );
    expect(Number(assetsAfterFirst.rows[0]!.n)).toBe(2); // images 0 and 1
    const putsAfterFirst = store.putCount;

    // Retry twice more — must not create new assets or puts for image index 1.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        runImageGeneration(db.pool, {
          tenantId: db.tenantId,
          runId,
          inputs,
          resolved,
          objectStore: store,
        }),
      ).rejects.toThrow("copy_permanent_fail");
    }

    const assetsAfterRetries = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM asset WHERE tenant_id = $1`,
      [db.tenantId],
    );
    expect(Number(assetsAfterRetries.rows[0]!.n)).toBe(2);
    expect(store.putCount).toBe(putsAfterFirst);

    // Deterministic id is stable across retries.
    const generation = await db.pool.query<{ id: string }>(
      `SELECT id FROM creative_generation WHERE tenant_id = $1 LIMIT 1`,
      [db.tenantId],
    );
    const expectedId = deterministicAssetId(generation.rows[0]!.id, 1);
    const found = await db.pool.query(`SELECT 1 FROM asset WHERE id = $1`, [expectedId]);
    expect(found.rowCount).toBe(1);
  });

  it("P1 — bucket policy unverifiable / Get* is public", () => {
    expect(
      policyAllowsPublicRead(
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: "*",
              Action: "s3:Get*",
              Resource: ["arn:aws:s3:::adloop/*"],
            },
          ],
        }),
      ),
    ).toBe(true);

    expect(
      resolveBucketPrivacyAfterPutFailure({
        getPolicyError: { name: "AccessDenied" },
      }),
    ).toBe("unverifiable");

    expect(
      resolveBucketPrivacyAfterPutFailure({
        getPolicyError: { name: "NoSuchBucketPolicy" },
      }),
    ).toBe("private");

    expect(
      resolveBucketPrivacyAfterPutFailure({
        policyJson: JSON.stringify({
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: "*" },
              Action: ["s3:GetObject"],
              Resource: ["arn:aws:s3:::adloop/*"],
            },
          ],
        }),
      }),
    ).toBe("public");
  });
});
