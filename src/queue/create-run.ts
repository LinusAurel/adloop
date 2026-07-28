import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { withTransaction, type Queryable } from "../db/queryable";
import { getFamily } from "./registry";

export const CreateRunInputSchema = z.object({
  runId: z.string().uuid(),
  tenantId: z.string().uuid(),
  family: z.string().min(1),
  input: z.unknown(),
});
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;

export type CreateRunResult =
  | { outcome: "created"; runId: string }
  | { outcome: "idempotent_replay"; runId: string }
  | { outcome: "conflict"; runId: string }
  | { outcome: "unknown_family" }
  | { outcome: "invalid_input"; message: string };

/** Deterministic key-order comparison — jsonb round-trips can reorder keys. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

/**
 * §5 idempotency contract: POSTing the same runId with the same body twice
 * is a no-op that returns the original 201; the same runId with a
 * different body is a 409. Etappe 1: exactly one job per run (job.run_id
 * carries a UNIQUE constraint — see migrations), so creating the run and
 * its job is one transaction and "the run already existed" is the only
 * fork in the logic.
 *
 * Accepts a `Queryable` (see db/queryable.ts) so a concurrency test can pin
 * two competing submissions to two distinct, pid-identified Postgres
 * backend connections instead of racing two calls over the same `Pool`.
 */
export async function createRun(db: Queryable, params: CreateRunInput): Promise<CreateRunResult> {
  const family = getFamily(params.family);
  if (!family) {
    return { outcome: "unknown_family" };
  }

  const parsedInput = family.inputSchema.safeParse(params.input);
  if (!parsedInput.success) {
    return { outcome: "invalid_input", message: parsedInput.error.message };
  }

  const result = await withTransaction(db, async (client) => {
    const inserted = await client.query(
      `INSERT INTO run (id, tenant_id, kind, status, input, created_at, updated_at)
       VALUES ($1, $2, $3, 'queued', $4::jsonb, now(), now())
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [params.runId, params.tenantId, params.family, JSON.stringify(params.input)],
    );

    if (inserted.rows[0]) {
      await client.query(
        `INSERT INTO job (id, tenant_id, run_id, family, status, input, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, now(), now())`,
        [uuidv7(), params.tenantId, params.runId, params.family, JSON.stringify(parsedInput.data)],
      );
      return { outcome: "created", runId: params.runId } as const;
    }

    // Run already existed (either a genuine retry, or we lost a race to
    // insert it — ON CONFLICT DO NOTHING blocks on the other transaction's
    // commit, so by the time we get here the row is final either way).
    const existing = await client.query(`SELECT * FROM run WHERE id = $1`, [params.runId]);
    const existingRun = existing.rows[0] as { tenant_id: string; kind: string; input: unknown } | undefined;
    if (!existingRun) {
      return { outcome: "conflict", runId: params.runId } as const;
    }

    const sameRequest =
      existingRun.tenant_id === params.tenantId &&
      existingRun.kind === params.family &&
      canonical(existingRun.input) === canonical(params.input);

    return sameRequest
      ? ({ outcome: "idempotent_replay", runId: params.runId } as const)
      : ({ outcome: "conflict", runId: params.runId } as const);
  });

  if (result.outcome === "created") {
    await db.query(`SELECT pg_notify('job_available', $1)`, [params.runId]);
  }

  return result;
}
