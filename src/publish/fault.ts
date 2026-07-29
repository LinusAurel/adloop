/**
 * Test-only fault injection after a successful Meta write has been persisted
 * to publication_step. Models process crash between Meta success and the
 * next step — resume must not recreate the object.
 */
export type CrashAfterPersistHook = (
  operation: string,
  externalId: string,
) => Promise<void> | void;

let crashAfterPersist: CrashAfterPersistHook | null = null;

/** Force lease expiry checks to treat `now` as this instant (tests). */
let clockNowMs: number | null = null;

export function setCrashAfterPersistForTests(
  hook: CrashAfterPersistHook | null,
): void {
  crashAfterPersist = hook;
}

export function setPublishClockForTests(nowMs: number | null): void {
  clockNowMs = nowMs;
}

export function publishNow(): Date {
  return clockNowMs === null ? new Date() : new Date(clockNowMs);
}

export async function maybeCrashAfterPersist(
  operation: string,
  externalId: string,
): Promise<void> {
  if (crashAfterPersist) {
    await crashAfterPersist(operation, externalId);
  }
}
