import { z } from "zod";
import type { JobFamilyDefinition } from "../types";

const SleepsForeverInputSchema = z.object({}).strict();
const SleepsForeverResultSchema = z.never();

export type SleepsForeverInput = z.infer<typeof SleepsForeverInputSchema>;

/**
 * Test-only family (§6): deliberately never resolves and never checks its
 * AbortSignal, to prove that timeoutMs is enforced by the runner (a race,
 * see run-job.ts) and not by handler cooperation. A cooperative handler
 * would make the timeout path untestable.
 */
export const sleepsForeverFamily: JobFamilyDefinition<SleepsForeverInput, never> = {
  name: "sleeps_forever",
  inputSchema: SleepsForeverInputSchema,
  resultSchema: SleepsForeverResultSchema,
  maxAttempts: 1,
  timeoutMs: 50,
  handler(): Promise<never> {
    return new Promise<never>(() => {
      /* never resolves, never rejects, ignores ctx.signal on purpose */
    });
  },
};
