import { registerFamily, isFamilyRegistered } from "./registry";
import { echoFamily } from "./families/echo";
import { metaInsightSyncFamily } from "./families/meta-insight-sync";

/**
 * The Next.js app process (API routes) needs the registry populated too —
 * createRun() looks families up to validate input at submission time. Only
 * `echo` here: `always_fails` / `sleeps_forever` are test-only and must
 * never be reachable from the public API (see families/*.ts).
 *
 * Guarded by isFamilyRegistered instead of a module-level call because
 * Next.js can reload route modules (dev mode, or repeated cold invocations
 * in some runtimes) — registerFamily() throws on a duplicate name.
 */
export function ensureQueueBootstrapped(): void {
  if (!isFamilyRegistered(echoFamily.name)) {
    registerFamily(echoFamily);
  }
  if (!isFamilyRegistered(metaInsightSyncFamily.name)) {
    registerFamily(metaInsightSyncFamily);
  }
}
