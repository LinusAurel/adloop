import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, requireOwnedResource } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { env } from "@/lib/env";
import { errorResponse } from "@/lib/api-error";
import { defaultSyncWindow } from "@/meta/insight-sync";
import { initialReadiness, ReadinessSchema } from "@/meta/oauth";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";
import { createRun } from "@/queue/create-run";

const BodySchema = z.object({
  runId: z.string().uuid(),
  metaAdAccountId: z.string().uuid(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const ownershipError = await requireOwnedResource(
    pool,
    auth.session,
    "metaAdAccount",
    parsed.data.metaAdAccountId,
  );
  if (ownershipError) return ownershipError;

  const account = await pool.query<{ timezone_name: string; selected: boolean }>(
    `SELECT timezone_name, selected
     FROM meta_ad_account
     WHERE id = $1 AND tenant_id = $2`,
    [parsed.data.metaAdAccountId, auth.session.tenantId],
  );
  if (!account.rows[0]) return errorResponse(404, "not_found");
  if (!account.rows[0].selected) return errorResponse(409, "account_not_selected");

  ensureQueueBootstrapped();
  const window = defaultSyncWindow(
    account.rows[0].timezone_name,
    env.SYNC_BACKFILL_DAYS,
  );
  const syncRunId = parsed.data.runId;
  const result = await createRun(pool, {
    runId: parsed.data.runId,
    tenantId: auth.session.tenantId,
    family: "meta_insight_sync",
    input: {
      metaAdAccountId: parsed.data.metaAdAccountId,
      syncRunId,
      windowStart: window.start,
      windowEnd: window.end,
    },
  });

  if (result.outcome === "concurrency_conflict") {
    return errorResponse(409, "sync_in_progress");
  }
  if (result.outcome === "conflict") return errorResponse(409, "idempotency_conflict");
  if (result.outcome === "unknown_family") return errorResponse(500, "sync_unavailable");
  if (result.outcome === "invalid_input") return errorResponse(400, "validation_error");

  const readiness = initialReadiness();
  readiness.base_facts = {
    status: "syncing",
    progress: {
      labelCode: "daily_facts",
      completed: 0,
      total: env.SYNC_BACKFILL_DAYS,
      percent: 0,
    },
    blocks: ["strategist", "insights"],
    messageCode: "base_facts_syncing",
  };
  await pool.query(
    `UPDATE meta_ad_account
     SET readiness = $1::jsonb, updated_at = now()
     WHERE id = $2 AND tenant_id = $3`,
    [
      JSON.stringify(ReadinessSchema.parse(readiness)),
      parsed.data.metaAdAccountId,
      auth.session.tenantId,
    ],
  );

  return NextResponse.json(
    {
      runId: result.runId,
      syncRunId,
      statusUrl: `/api/runs/${result.runId}`,
    },
    { status: 202 },
  );
}
