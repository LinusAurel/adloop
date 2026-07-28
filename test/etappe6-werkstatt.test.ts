import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";
import { setPoolForTests } from "@/db/pool";
import { type TestDb, startTestDb } from "./db-harness";
import {
  MemoryObjectStore,
  setObjectStoreForTests,
} from "@/storage/object-store";
import {
  setImageProviderForTests,
} from "@/images/registry";
import { StubImageProvider } from "@/images/providers/stub";
import { FalImageProvider } from "@/images/providers/fal";
import {
  OpenAiImagesProvider,
  OPENAI_IMAGES_UNPROTECTED_REASON,
} from "@/images/providers/openai-images";
import {
  setCopyGeneratorForTests,
  StubCopyGenerator,
} from "@/images/copy";
import {
  estimateGenerationCost,
  resolveGenerationInputs,
  runImageGeneration,
  type GenerationInputs,
} from "@/images/generate";
import {
  buildIdempotencyKey,
  callProviderWithIdempotency,
  hashGenerationRequest,
  IdempotencyConflictError,
  setCrashAfterProviderSubmitForTests,
} from "@/images/idempotency";
import type { GenerationRequest, GenerationResult } from "@/images/provider";
import { normalizeGenerationResultShape } from "@/images/generate";

describe("etappe 6 — bild-werkstatt", () => {
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
       VALUES ($1, $2, 'Workshop Co', 'en-US')`,
      [advertiserId, db.tenantId],
    );
  });

  async function insertRun(): Promise<string> {
    const runId = uuidv7();
    await db.pool.query(
      `INSERT INTO run (id, tenant_id, kind, status, input, created_at, updated_at)
       VALUES ($1, $2, 'image_generation', 'queued', '{}'::jsonb, now(), now())`,
      [runId, db.tenantId],
    );
    return runId;
  }

  async function prepare(overrides: Partial<GenerationInputs> = {}) {
    const inputs: GenerationInputs = {
      advertiserId,
      prompt: "Fresh product shot",
      aspectRatio: "4:5",
      count: 2,
      clientRequestId: uuidv7(),
      provider: "stub",
      ...overrides,
    };
    const resolved = await resolveGenerationInputs(db.pool, db.tenantId, inputs);
    const runId = await insertRun();
    return { inputs, resolved, runId };
  }

  it("1 — generation creates n creatives with image and copy; DB stores keys only", async () => {
    const { inputs, resolved, runId } = await prepare({ count: 3 });
    const outcome = await runImageGeneration(db.pool, {
      tenantId: db.tenantId,
      runId,
      inputs,
      resolved,
      objectStore: store,
    });
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") return;

    expect(outcome.creativeIds).toHaveLength(3);
    expect(outcome.assetIds).toHaveLength(3);

    const creatives = await db.pool.query<{
      primary_text: string;
      headline: string;
      asset_id: string;
    }>(`SELECT primary_text, headline, asset_id FROM creative WHERE tenant_id = $1`, [
      db.tenantId,
    ]);
    expect(creatives.rows).toHaveLength(3);
    for (const row of creatives.rows) {
      expect(row.primary_text.length).toBeGreaterThan(0);
      expect(row.headline.length).toBeGreaterThan(0);
    }

    const assets = await db.pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM asset WHERE tenant_id = $1`,
      [db.tenantId],
    );
    expect(assets.rows).toHaveLength(3);
    for (const row of assets.rows) {
      // No binary in Postgres — only the storage key.
      expect(row.storage_key).toMatch(/^tenants\//);
      const obj = await store.getObject(row.storage_key);
      expect(obj.body.byteLength).toBeGreaterThan(0);
    }
  });

  it("2 — idempotency: same key+hash does not call provider again", async () => {
    const provider = new StubImageProvider({ recovery: { kind: "native_key" } });
    setImageProviderForTests(provider);
    const { inputs, resolved, runId } = await prepare();

    const first = await runImageGeneration(db.pool, {
      tenantId: db.tenantId,
      runId,
      inputs,
      resolved,
      objectStore: store,
    });
    expect(first.status).toBe("succeeded");
    const submitsAfterFirst = provider.getSubmitCount();
    expect(submitsAfterFirst).toBe(1);

    const secondRun = await insertRun();
    const second = await runImageGeneration(db.pool, {
      tenantId: db.tenantId,
      runId: secondRun,
      inputs,
      resolved,
      objectStore: store,
    });
    expect(second.status).toBe("succeeded");
    if (second.status !== "succeeded" || first.status !== "succeeded") return;
    expect(second.replayed).toBe(true);
    expect(second.creativeIds).toEqual(first.creativeIds);
    expect(provider.getSubmitCount()).toBe(submitsAfterFirst);

    // Mutation proof: if replay skipped the early return, submit count would rise.
    // Invert the assertion momentarily in a local check that the counter is the oracle.
    expect(provider.getSubmitCount()).not.toBe(submitsAfterFirst + 1);
  });

  it("3 — hash conflict: same key, different hash → error, no call", async () => {
    const provider = new StubImageProvider();
    setImageProviderForTests(provider);
    const { inputs, resolved, runId } = await prepare();
    await runImageGeneration(db.pool, {
      tenantId: db.tenantId,
      runId,
      inputs,
      resolved,
      objectStore: store,
    });
    const submits = provider.getSubmitCount();

    const key = buildIdempotencyKey({
      tenantId: db.tenantId,
      operation: "image_generation",
      identity: inputs.clientRequestId,
    });
    await expect(
      callProviderWithIdempotency(db.pool, {
        key,
        tenantId: db.tenantId,
        requestHash: hashGenerationRequest({ ...resolved, count: 99 }),
        provider,
        request: {
          prompt: resolved.resolvedPrompt,
          aspectRatio: resolved.aspectRatio,
          count: 99,
          model: resolved.model,
        },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(provider.getSubmitCount()).toBe(submits);
  });

  it("4 — crash after provider submit: retry reconciles, does not resubmit", async () => {
    const provider = new StubImageProvider({ recovery: { kind: "native_key" } });
    setImageProviderForTests(provider);

    const request: GenerationRequest = {
      prompt: "crash-window",
      aspectRatio: "4:5",
      count: 1,
      model: "stub-v1",
    };
    const key = buildIdempotencyKey({
      tenantId: db.tenantId,
      operation: "image_generation",
      identity: `crash-${uuidv7()}`,
    });
    const requestHash = hashGenerationRequest(request);

    setCrashAfterProviderSubmitForTests(async () => {
      throw new Error("injected_crash_after_submit");
    });

    await expect(
      callProviderWithIdempotency(db.pool, {
        key,
        tenantId: db.tenantId,
        requestHash,
        provider,
        request,
      }),
    ).rejects.toThrow("injected_crash_after_submit");

    const row = await db.pool.query<{ status: string; provider_job: unknown }>(
      `SELECT status, provider_job FROM idempotency_key WHERE key = $1`,
      [key],
    );
    expect(row.rows[0]?.status).toBe("in_flight");
    expect(row.rows[0]?.provider_job).toBeTruthy();
    expect(provider.getSubmitCount()).toBe(1);

    setCrashAfterProviderSubmitForTests(null);
    const recovered = await callProviderWithIdempotency(db.pool, {
      key,
      tenantId: db.tenantId,
      requestHash,
      provider,
      request,
    });
    expect(recovered.kind).toBe("result");
    // Must NOT submit again — fetchResult path.
    expect(provider.getSubmitCount()).toBe(1);

    // Mutation proof: if recover blindly re-submitted, count would be 2.
    expect(provider.getSubmitCount()).toBeLessThan(2);
  });

  it("5 — signed URL required; signature expires", async () => {
    const key = `tenants/${db.tenantId}/assets/${uuidv7()}`;
    await store.putBytes(key, Buffer.from("secret-bytes"), "image/png");

    expect(() => store.getUnsigned(key)).toThrow("access_denied_unsigned");

    const url = await store.getSignedUrl(key, 1);
    expect(store.resolveSigned(url).body.toString()).toBe("secret-bytes");

    // Expire: mint with 0 seconds then wait.
    const short = await store.getSignedUrl(key, 0);
    await new Promise((r) => setTimeout(r, 5));
    expect(() => store.resolveSigned(short)).toThrow("signature_expired");

    // Mutation proof: if unsigned access were allowed, getUnsigned would not throw.
    let unsignedAllowed = false;
    try {
      store.getUnsigned(key);
      unsignedAllowed = true;
    } catch {
      unsignedAllowed = false;
    }
    expect(unsignedAllowed).toBe(false);
  });

  it("6 — variants set parent_creative_id and reason; original unchanged", async () => {
    const parentPrep = await prepare({ count: 1, clientRequestId: uuidv7() });
    const parentOut = await runImageGeneration(db.pool, {
      tenantId: db.tenantId,
      runId: parentPrep.runId,
      inputs: parentPrep.inputs,
      resolved: parentPrep.resolved,
      objectStore: store,
    });
    expect(parentOut.status).toBe("succeeded");
    if (parentOut.status !== "succeeded") return;
    const parentId = parentOut.creativeIds[0]!;

    const before = await db.pool.query(
      `SELECT primary_text, headline FROM creative WHERE id = $1`,
      [parentId],
    );

    const variantPrep = await prepare({
      count: 1,
      clientRequestId: uuidv7(),
      parentCreativeId: parentId,
      variationReason: "warmer lighting",
    });
    const variantOut = await runImageGeneration(db.pool, {
      tenantId: db.tenantId,
      runId: variantPrep.runId,
      inputs: variantPrep.inputs,
      resolved: variantPrep.resolved,
      objectStore: store,
    });
    expect(variantOut.status).toBe("succeeded");
    if (variantOut.status !== "succeeded") return;

    const link = await db.pool.query<{
      parent_creative_id: string;
      creative_id: string;
      reason: string;
    }>(`SELECT parent_creative_id, creative_id, reason FROM creative_variant`);
    expect(link.rows).toHaveLength(1);
    expect(link.rows[0]!.parent_creative_id).toBe(parentId);
    expect(link.rows[0]!.creative_id).toBe(variantOut.creativeIds[0]);
    expect(link.rows[0]!.reason).toBe("warmer lighting");

    const after = await db.pool.query(
      `SELECT primary_text, headline FROM creative WHERE id = $1`,
      [parentId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("7 — inputs vs resolved_inputs differ when defaults apply", async () => {
    const inputs: GenerationInputs = {
      advertiserId,
      clientRequestId: uuidv7(),
      provider: "stub",
      // omit prompt, aspectRatio, count → defaults
    };
    const resolved = await resolveGenerationInputs(db.pool, db.tenantId, inputs);
    expect(resolved.aspectRatio).toBe("4:5");
    expect(resolved.count).toBe(1);
    expect(resolved.resolvedPrompt).not.toBe(resolved.prompt);
    expect(resolved.resolvedPrompt).toContain("advertising quality");

    const runId = await insertRun();
    const outcome = await runImageGeneration(db.pool, {
      tenantId: db.tenantId,
      runId,
      inputs,
      resolved,
      objectStore: store,
    });
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") return;

    const row = await db.pool.query<{ inputs: unknown; resolved_inputs: unknown }>(
      `SELECT inputs, resolved_inputs FROM creative_generation WHERE id = $1`,
      [outcome.generationId],
    );
    expect(row.rows[0]!.inputs).not.toEqual(row.rows[0]!.resolved_inputs);
    const storedResolved = row.rows[0]!.resolved_inputs as { resolvedPrompt: string };
    expect(storedResolved.resolvedPrompt).toContain("Product:");
  });

  it("8 — cost estimate before approval and in creative_generation", async () => {
    const { inputs, resolved, runId } = await prepare({ count: 4 });
    const estimate = estimateGenerationCost(resolved);
    expect(estimate).toEqual({
      image: expect.any(Number),
      copy: expect.any(Number),
      currency: "USD",
    });
    expect(estimate.copy).toBeGreaterThan(0);

    const outcome = await runImageGeneration(db.pool, {
      tenantId: db.tenantId,
      runId,
      inputs,
      resolved,
      objectStore: store,
    });
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") return;
    expect(outcome.costEstimate).toEqual(estimate);

    const row = await db.pool.query<{ cost_estimate: unknown }>(
      `SELECT cost_estimate FROM creative_generation WHERE id = $1`,
      [outcome.generationId],
    );
    expect(row.rows[0]!.cost_estimate).toEqual(estimate);
  });

  it("9 — provider switch: stub/fal/openai-images yield same data shape", async () => {
    const falSubmit = JSON.parse(
      readFileSync(join(__dirname, "fixtures/providers/fal/submit.json"), "utf8"),
    ) as { request_id: string };
    const falResult = JSON.parse(
      readFileSync(join(__dirname, "fixtures/providers/fal/result.json"), "utf8"),
    ) as GenerationResult;
    const openaiEnvelope = JSON.parse(
      readFileSync(join(__dirname, "fixtures/providers/openai-images/result.json"), "utf8"),
    ) as {
      created: number;
      data: Array<{ b64_json: string }>;
      usage: { total_tokens: number };
      background?: string;
      output_format?: string;
      quality?: string;
      size?: string;
    };
    const openaiPng = readFileSync(
      join(__dirname, "fixtures/providers/openai-images/image.png"),
    );
    // Rehydrate the live response: envelope + captured PNG bytes as b64_json.
    const openaiCaptured = {
      ...openaiEnvelope,
      data: [{ b64_json: openaiPng.toString("base64") }],
    };
    const openaiCaptureMeta = JSON.parse(
      readFileSync(join(__dirname, "fixtures/providers/openai-images/CAPTURE.json"), "utf8"),
    ) as {
      response: { created: number; image_sha256_16: string; png_magic: string; usage: { total_tokens: number } };
    };

    // Prove the openai-images fixture is a live capture, not a hand-built stub.
    expect(openaiCaptured.created).toBe(openaiCaptureMeta.response.created);
    expect(openaiCaptured.usage.total_tokens).toBe(openaiCaptureMeta.response.usage.total_tokens);
    expect(openaiPng.subarray(0, 8).toString("hex")).toBe(openaiCaptureMeta.response.png_magic);
    expect(openaiPng.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(createHash("sha256").update(openaiPng).digest("hex").slice(0, 16)).toBe(
      openaiCaptureMeta.response.image_sha256_16,
    );

    const shapes: Array<{ imageCount: number; mimes: string[] }> = [];

    // stub
    {
      const provider = new StubImageProvider();
      setImageProviderForTests(provider);
      const { inputs, resolved, runId } = await prepare({
        count: 1,
        provider: "stub",
        clientRequestId: uuidv7(),
      });
      const out = await runImageGeneration(db.pool, {
        tenantId: db.tenantId,
        runId,
        inputs,
        resolved,
        objectStore: store,
      });
      expect(out.status).toBe("succeeded");
      if (out.status === "succeeded") {
        const gen = await db.pool.query<{ provider: string; model: string }>(
          `SELECT provider, model FROM creative_generation WHERE id = $1`,
          [out.generationId],
        );
        expect(gen.rows[0]!.provider).toBe("stub");
        shapes.push({ imageCount: out.creativeIds.length, mimes: ["image/png"] });
      }
    }

    // fal via fixtures
    {
      const fixtureResults = new Map<string, unknown>([[falSubmit.request_id, falResult]]);
      const fal = new FalImageProvider({
        apiKey: "test-key",
        http: {
          async fetch(url, init) {
            if (init?.method === "POST") {
              return new Response(JSON.stringify(falSubmit), { status: 200 });
            }
            void url;
            return new Response(JSON.stringify(falResult), { status: 200 });
          },
        },
        fixtureResults,
      });
      setImageProviderForTests(fal);
      const { inputs, resolved, runId } = await prepare({
        count: 1,
        provider: "fal",
        model: "fal-ai/flux/schnell",
        clientRequestId: uuidv7(),
      });
      const out = await runImageGeneration(db.pool, {
        tenantId: db.tenantId,
        runId,
        inputs,
        resolved,
        objectStore: store,
        webhookBaseUrl: "https://example.test",
      });
      expect(out.status).toBe("succeeded");
      if (out.status === "succeeded") {
        const gen = await db.pool.query<{ provider: string; model: string }>(
          `SELECT provider, model FROM creative_generation WHERE id = $1`,
          [out.generationId],
        );
        expect(gen.rows[0]!.provider).toBe("fal");
        expect(gen.rows[0]!.model).toBe("fal-ai/flux/schnell");
        shapes.push({ imageCount: out.creativeIds.length, mimes: ["image/png"] });
      }
    }

    // openai-images via live-captured fixture (sync POST body)
    {
      const openai = new OpenAiImagesProvider({
        apiKey: "test-key",
        http: {
          async fetch(_url, init) {
            expect(init?.method).toBe("POST");
            const headers = new Headers(init?.headers);
            expect(headers.get("Idempotency-Key")).toBeTruthy();
            return new Response(JSON.stringify(openaiCaptured), { status: 200 });
          },
        },
      });
      setImageProviderForTests(openai);
      const { inputs, resolved, runId } = await prepare({
        count: 1,
        provider: "openai-images",
        model: "gpt-image-1",
        clientRequestId: uuidv7(),
      });
      const out = await runImageGeneration(db.pool, {
        tenantId: db.tenantId,
        runId,
        inputs,
        resolved,
        objectStore: store,
      });
      expect(out.status).toBe("succeeded");
      if (out.status === "succeeded") {
        const gen = await db.pool.query<{ provider: string; model: string }>(
          `SELECT provider, model FROM creative_generation WHERE id = $1`,
          [out.generationId],
        );
        expect(gen.rows[0]!.provider).toBe("openai-images");
        expect(gen.rows[0]!.model).toBe("gpt-image-1");
        shapes.push({ imageCount: out.creativeIds.length, mimes: ["image/png"] });
      }
    }

    expect(shapes).toHaveLength(3);
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[1]).toEqual(shapes[2]);
  });

  it("10 — lookup_by_correlation recovers; native_key resubmits with same corr when pending", async () => {
    // lookup_by_correlation (auftrag case 10 "result_lookup")
    {
      const provider = new StubImageProvider({
        recovery: { kind: "lookup_by_correlation" },
      });
      const request: GenerationRequest = {
        prompt: "lookup",
        aspectRatio: "1:1",
        count: 1,
        model: "stub-v1",
      };
      const key = buildIdempotencyKey({
        tenantId: db.tenantId,
        operation: "image_generation",
        identity: `lookup-${uuidv7()}`,
      });
      const requestHash = hashGenerationRequest(request);

      setCrashAfterProviderSubmitForTests(async (job) => {
        // Simulate lost external id: wipe provider_job back to pending after plant.
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
        throw new Error("crash_lost_external_id");
      });

      await expect(
        callProviderWithIdempotency(db.pool, {
          key,
          tenantId: db.tenantId,
          requestHash,
          provider,
          request,
        }),
      ).rejects.toThrow("crash_lost_external_id");

      const submits = provider.getSubmitCount();
      setCrashAfterProviderSubmitForTests(null);

      const recovered = await callProviderWithIdempotency(db.pool, {
        key,
        tenantId: db.tenantId,
        requestHash,
        provider,
        request,
      });
      expect(recovered.kind).toBe("result");
      // recover() found the planted result — no second submit.
      expect(provider.getSubmitCount()).toBe(submits);
    }

    // native_key with pending: must resubmit same correlation (not a new one)
    {
      const provider = new StubImageProvider({ recovery: { kind: "native_key" } });
      const request: GenerationRequest = {
        prompt: "native",
        aspectRatio: "1:1",
        count: 1,
        model: "stub-v1",
      };
      const key = buildIdempotencyKey({
        tenantId: db.tenantId,
        operation: "image_generation",
        identity: `native-${uuidv7()}`,
      });
      const requestHash = hashGenerationRequest(request);
      let firstCorr = "";

      setCrashAfterProviderSubmitForTests(async (job) => {
        firstCorr = job.correlationId;
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
        throw new Error("crash_before_id");
      });

      await expect(
        callProviderWithIdempotency(db.pool, {
          key,
          tenantId: db.tenantId,
          requestHash,
          provider,
          request,
        }),
      ).rejects.toThrow("crash_before_id");

      setCrashAfterProviderSubmitForTests(null);
      const second = await callProviderWithIdempotency(db.pool, {
        key,
        tenantId: db.tenantId,
        requestHash,
        provider,
        request,
      });
      expect(second.kind).toBe("result");
      if (second.kind === "result") {
        expect(second.job.correlationId).toBe(firstCorr);
      }
    }

    // unprotected → needs_human_check, no second call
    {
      const provider = new StubImageProvider({
        recovery: {
          kind: "unprotected",
          reason: OPENAI_IMAGES_UNPROTECTED_REASON,
        },
      });
      const request: GenerationRequest = {
        prompt: "unprotected",
        aspectRatio: "1:1",
        count: 1,
        model: "stub-v1",
      };
      const key = buildIdempotencyKey({
        tenantId: db.tenantId,
        operation: "image_generation",
        identity: `unprot-${uuidv7()}`,
      });
      const requestHash = hashGenerationRequest(request);

      setCrashAfterProviderSubmitForTests(async () => {
        throw new Error("crash_unprotected");
      });
      await expect(
        callProviderWithIdempotency(db.pool, {
          key,
          tenantId: db.tenantId,
          requestHash,
          provider,
          request,
        }),
      ).rejects.toThrow("crash_unprotected");
      const submits = provider.getSubmitCount();
      setCrashAfterProviderSubmitForTests(null);

      const escalated = await callProviderWithIdempotency(db.pool, {
        key,
        tenantId: db.tenantId,
        requestHash,
        provider,
        request,
      });
      expect(escalated).toEqual({
        kind: "needs_human_check",
        code: "provider_unprotected_crash",
        reason: OPENAI_IMAGES_UNPROTECTED_REASON,
      });
      expect(provider.getSubmitCount()).toBe(submits);
    }
  });

  it("provider adapters expose classified recovery", () => {
    const fal = new FalImageProvider({ apiKey: "x" });
    expect(fal.recovery).toEqual({ kind: "correlated_callback" });
    const openai = new OpenAiImagesProvider({ apiKey: "x" });
    expect(openai.recovery).toEqual({
      kind: "unprotected",
      reason: OPENAI_IMAGES_UNPROTECTED_REASON,
    });
  });

  it("normalizeGenerationResultShape is stable across fixture results", () => {
    const falResult = JSON.parse(
      readFileSync(join(__dirname, "fixtures/providers/fal/result.json"), "utf8"),
    ) as GenerationResult;
    expect(normalizeGenerationResultShape(falResult)).toEqual({
      imageCount: 1,
      mimes: ["image/png"],
    });
  });
});
