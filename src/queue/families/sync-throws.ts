import { z } from "zod";
import type { JobFamilyDefinition } from "../types";
import { HandlerError } from "../errors";

const SyncThrowsInputSchema = z.object({}).strict();
const SyncThrowsResultSchema = z.never();

export type SyncThrowsInput = z.infer<typeof SyncThrowsInputSchema>;

/**
 * Test-only family for P1-2 (second review): `handler` is deliberately NOT
 * an `async function` — a plain function that throws before ever
 * constructing a promise. `family.handler(ctx)` therefore throws
 * SYNCHRONOUSLY the instant it is called, rather than returning a rejected
 * promise. This is exactly the shape a real mistake could take (e.g. a
 * future family's handler validating something before its first `await`),
 * and is what used to skip run-job.ts's heartbeat cleanup entirely — see
 * run-job.ts's Promise.resolve().then(() => family.handler(ctx)) wrapper.
 */
export const syncThrowsFamily: JobFamilyDefinition<SyncThrowsInput, never> = {
  name: "sync_throws",
  inputSchema: SyncThrowsInputSchema,
  resultSchema: SyncThrowsResultSchema,
  maxAttempts: 1,
  timeoutMs: 5000,
  handler(): Promise<never> {
    throw new HandlerError("SYNC_THROW", "thrown synchronously, before returning a promise", false);
  },
};
