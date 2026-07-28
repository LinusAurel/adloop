import { NextRequest, NextResponse } from "next/server";
import { authenticate, requireOwnedResource } from "@/auth/guard";
import { getPool } from "@/db/pool";
import { errorResponse } from "@/lib/api-error";
import { ensureQueueBootstrapped } from "@/queue/bootstrap";
import {
  AdReviewRequestSchema,
  executeAdReview,
  previewAdReview,
} from "@/strategist/ad-review";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  ensureQueueBootstrapped();
  const json = await request.json().catch(() => null);
  const parsed = AdReviewRequestSchema.safeParse(json);
  if (!parsed.success) return errorResponse(400, "validation_error");

  const pool = getPool();
  const ownershipError = await requireOwnedResource(
    pool,
    auth.session,
    "metaAdAccount",
    parsed.data.adAccountId,
  );
  if (ownershipError) return ownershipError;

  if (!parsed.data.execute) {
    const preview = await previewAdReview(pool, {
      tenantId: auth.session.tenantId,
      userId: auth.session.userId,
      request: parsed.data,
    });
    if (preview.outcome === "snapshot_mismatch") {
      return errorResponse(409, "snapshot_mismatch");
    }
    if (preview.outcome === "not_found") {
      return errorResponse(404, "not_found");
    }
    return NextResponse.json(preview);
  }

  const result = await executeAdReview(pool, {
    tenantId: auth.session.tenantId,
    userId: auth.session.userId,
    request: parsed.data,
  });

  switch (result.outcome) {
    case "created":
    case "idempotent_replay":
      return NextResponse.json(
        {
          accepted: true,
          runId: result.runId,
          chatId: result.chatId,
          creativeStrategyRunId: result.creativeStrategyRunId,
          ...(result.outcome === "created"
            ? {
                runType: result.runType,
                titleCode: result.titleCode,
                titleParams: result.titleParams,
              }
            : {}),
        },
        { status: 201 },
      );
    case "conflict":
      return errorResponse(409, "idempotency_conflict");
    case "concurrency_conflict":
      return errorResponse(409, "review_already_running", {
        runType: result.runType,
        metaAdId: result.metaAdId,
      });
    case "snapshot_mismatch":
      return errorResponse(409, "snapshot_mismatch");
    case "not_found":
      return errorResponse(404, "not_found");
  }
}
