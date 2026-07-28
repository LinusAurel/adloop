import { z } from "zod";
import type { JobFamilyDefinition } from "../types";
import { HandlerError } from "../errors";

const AlwaysFailsInputSchema = z.object({}).strict();
const AlwaysFailsResultSchema = z.never();

export type AlwaysFailsInput = z.infer<typeof AlwaysFailsInputSchema>;

/**
 * Test-only family (§6): registered only by tests, never by the production
 * worker (see worker/index.ts). Backoff shortened to 10/20ms so retry tests
 * don't spend real wall-clock time on §4.7's default 1s/2s/4s schedule.
 */
export const alwaysFailsFamily: JobFamilyDefinition<AlwaysFailsInput, never> = {
  name: "always_fails",
  inputSchema: AlwaysFailsInputSchema,
  resultSchema: AlwaysFailsResultSchema,
  maxAttempts: 3,
  timeoutMs: 5000,
  backoffBaseMs: 10,
  backoffMaxMs: 20,
  async handler(): Promise<never> {
    throw new HandlerError("ALWAYS_FAILS", "this test family always fails", true);
  },
};
