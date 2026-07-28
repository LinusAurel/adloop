import { JobCancelledError } from "./errors";

/** Checkpoint helper: throws if the job's signal has already fired. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new JobCancelledError();
}

/**
 * An abortable sleep. Plain `setTimeout` would make cancellation wait for
 * the full delay to elapse before a handler notices — this resolves (well,
 * rejects) the instant the signal fires, so §4.6's "reicht das Signal an
 * jeden asynchronen Aufruf weiter" is real, not aspirational.
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new JobCancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new JobCancelledError());
    };
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
