import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/auth/guard";
import { errorResponse } from "@/lib/api-error";
import { PublishError } from "@/publish/schemas";
import { campaignIsCbo } from "@/publish/resolve";
import {
  buildLiveWriteClient,
  campaignReaderFromClient,
} from "@/publish/live-client";
import { getWriteClientOrThrow } from "@/publish/client-factory";


/** Every API route touches auth or the database — nothing here is static.
 * Without this, `next build` executes module code and fails on env validation. */
export const dynamic = "force-dynamic";
const QuerySchema = z.object({
  metaAdAccountId: z.string().uuid(),
  campaignId: z.string().min(1),
});

/**
 * Look up an existing Meta campaign's budget level so the Launch form can
 * hide the budget field for CBO (campaign already has daily/lifetime budget).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const parsed = QuerySchema.safeParse({
    metaAdAccountId: request.nextUrl.searchParams.get("metaAdAccountId"),
    campaignId: request.nextUrl.searchParams.get("campaignId"),
  });
  if (!parsed.success) return errorResponse(400, "validation_error");

  try {
    const live = await buildLiveWriteClient(
      auth.session.tenantId,
      parsed.data.metaAdAccountId,
    );
    const reader = campaignReaderFromClient(getWriteClientOrThrow(live));
    const budgets = await reader.getCampaign(parsed.data.campaignId);
    const isCbo = campaignIsCbo(budgets);
    return NextResponse.json({
      campaignId: parsed.data.campaignId,
      isCbo,
      budgetRequired: !isCbo,
    });
  } catch (error) {
    if (error instanceof PublishError) {
      return errorResponse(400, error.code, error.params);
    }
    return errorResponse(400, "campaign_not_found");
  }
}
