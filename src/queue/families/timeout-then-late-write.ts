import { z } from "zod";
import type { JobFamilyDefinition } from "../types";

const TimeoutThenLateWriteInputSchema = z.object({}).strict();
const TimeoutThenLateWriteResultSchema = z.never();

export type TimeoutThenLateWriteInput = z.infer<typeof TimeoutThenLateWriteInputSchema>;

/**
 * Test-only family (§6 pattern), added for the timeout test's rigor
 * (second review test audit): `sleeps_forever` alone proves the runner
 * finalizes 'timed_out' fast, but never proves that a handler which keeps
 * running past the timeout and later tries to write is actually fenced out
 * — it never attempts a write at all. This one does: it ignores the abort
 * signal like sleeps_forever, but schedules a `ctx.progress()` call well
 * after its own `timeoutMs`, so a test can assert that call is rejected by
 * the fencing rule (§4.4) instead of silently succeeding.
 */
export const timeoutThenLateWriteFamily: JobFamilyDefinition<TimeoutThenLateWriteInput, never> = {
  name: "timeout_then_late_write",
  inputSchema: TimeoutThenLateWriteInputSchema,
  resultSchema: TimeoutThenLateWriteResultSchema,
  maxAttempts: 1,
  timeoutMs: 50,
  handler(ctx): Promise<never> {
    setTimeout(() => {
      void ctx
        .progress({
          state: "late",
          code: "late_write_attempt",
          params: {},
          percent: 99,
        })
        .catch(() => {
          /* fencing is expected to reject this; nothing to do here */
        });
    }, 300);
    return new Promise<never>(() => {
      /* never resolves, never rejects, ignores ctx.signal on purpose */
    });
  },
};
