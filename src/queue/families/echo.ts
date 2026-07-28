import { z } from "zod";
import type { JobFamilyDefinition } from "../types";
import { delay, throwIfAborted } from "../abortable";

const EchoInputSchema = z.object({ text: z.string() });
const EchoResultSchema = z.object({ text: z.string() });

export type EchoInput = z.infer<typeof EchoInputSchema>;
export type EchoResult = z.infer<typeof EchoResultSchema>;

/**
 * §6: trivial-looking, but exercises every queue guarantee — five 1s
 * steps, progress after each, and a cancellation checkpoint before each
 * step, after each wait, and immediately before the result.
 */
export const echoFamily: JobFamilyDefinition<EchoInput, EchoResult> = {
  name: "echo",
  inputSchema: EchoInputSchema,
  resultSchema: EchoResultSchema,
  maxAttempts: 3,
  timeoutMs: 15000,
  async handler(ctx) {
    for (let step = 1; step <= 5; step++) {
      throwIfAborted(ctx.signal); // vor jedem Schritt
      await delay(1000, ctx.signal);
      throwIfAborted(ctx.signal); // nach jedem Warten
      await ctx.progress({
        state: `step_${step}`,
        code: "echo_step",
        params: { step, total: 5 },
        percent: step * 20,
      });
    }
    throwIfAborted(ctx.signal); // unmittelbar vor dem Ergebnis
    return { text: ctx.input.text };
  },
};
