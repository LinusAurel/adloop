import { registerFamily, isFamilyRegistered } from "./registry";
import { echoFamily } from "./families/echo";
import { metaInsightSyncFamily } from "./families/meta-insight-sync";
import { metricSnapshotComputeFamily } from "./families/metric-snapshot-compute";
import { agentTurnFamily } from "@/agent/turn";
import {
  copychiefReviewFamily,
  croReviewFamily,
  variationsFamily,
} from "./families/strategist-review";
import { imageGenerationFamily } from "./families/image-generation";
import { metaPublishFamily } from "./families/meta-publish";
import { ensureToolsBootstrapped } from "@/agent/tools/bootstrap";

/**
 * The Next.js app process (API routes) needs the registry populated too —
 * createRun() looks families up to validate input at submission time. Only
 * production families here: `always_fails` / `sleeps_forever` are test-only
 * and must never be reachable from the public API (see families/*.ts).
 * `metric_snapshot_compute` is registered so the sync handler can enqueue it,
 * but POST /api/runs rejects that family as internal-only.
 *
 * Guarded by isFamilyRegistered instead of a module-level call because
 * Next.js can reload route modules (dev mode, or repeated cold invocations
 * in some runtimes) — registerFamily() throws on a duplicate name.
 */
export function ensureQueueBootstrapped(): void {
  ensureToolsBootstrapped();
  if (!isFamilyRegistered(echoFamily.name)) {
    registerFamily(echoFamily);
  }
  if (!isFamilyRegistered(metaInsightSyncFamily.name)) {
    registerFamily(metaInsightSyncFamily);
  }
  if (!isFamilyRegistered(metricSnapshotComputeFamily.name)) {
    registerFamily(metricSnapshotComputeFamily);
  }
  if (!isFamilyRegistered(agentTurnFamily.name)) {
    registerFamily(agentTurnFamily);
  }
  if (!isFamilyRegistered(copychiefReviewFamily.name)) {
    registerFamily(copychiefReviewFamily);
  }
  if (!isFamilyRegistered(croReviewFamily.name)) {
    registerFamily(croReviewFamily);
  }
  if (!isFamilyRegistered(variationsFamily.name)) {
    registerFamily(variationsFamily);
  }
  if (!isFamilyRegistered(imageGenerationFamily.name)) {
    registerFamily(imageGenerationFamily);
  }
  if (!isFamilyRegistered(metaPublishFamily.name)) {
    registerFamily(metaPublishFamily);
  }
}
