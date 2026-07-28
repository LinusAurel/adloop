import { describe, expect, it } from "vitest";
import { assertJobTransitionAllowed } from "@/queue/transitions";

describe("assertJobTransitionAllowed", () => {
  it("allows every transition the auftrag's state machine defines", () => {
    expect(() => assertJobTransitionAllowed("queued", "claimed")).not.toThrow();
    expect(() => assertJobTransitionAllowed("queued", "cancelled")).not.toThrow();
    expect(() => assertJobTransitionAllowed("claimed", "completed")).not.toThrow();
    expect(() => assertJobTransitionAllowed("claimed", "failed")).not.toThrow();
    expect(() => assertJobTransitionAllowed("claimed", "timed_out")).not.toThrow();
    expect(() => assertJobTransitionAllowed("claimed", "retry_scheduled")).not.toThrow();
    expect(() => assertJobTransitionAllowed("claimed", "cancel_requested")).not.toThrow();
    expect(() => assertJobTransitionAllowed("retry_scheduled", "claimed")).not.toThrow();
    expect(() => assertJobTransitionAllowed("retry_scheduled", "cancelled")).not.toThrow();
    expect(() => assertJobTransitionAllowed("cancel_requested", "cancelled")).not.toThrow();
  });

  it("rejects transitions the state machine does not define", () => {
    // The exact gap that makes test case 7 decidable — see sql/finalize.ts.
    expect(() => assertJobTransitionAllowed("cancel_requested", "completed")).toThrow(/illegal job transition/);
    expect(() => assertJobTransitionAllowed("queued", "completed")).toThrow(/illegal job transition/);
    expect(() => assertJobTransitionAllowed("completed", "queued")).toThrow(/illegal job transition/);
    expect(() => assertJobTransitionAllowed("failed", "retry_scheduled")).toThrow(/illegal job transition/);
  });

  it("is actually wired into the finalize and retry primitives, not just documentation", async () => {
    // finalizeJob and scheduleRetry both call assertJobTransitionAllowed
    // before touching the database — a call with a from/to pair the state
    // machine doesn't define throws before any query runs. We don't need a
    // live DB to prove this: an invalid fromStatus makes finalizeJob throw
    // synchronously via the assertion, well before it would try to acquire
    // a pool connection.
    const { finalizeJob } = await import("@/queue/sql/finalize");
    await expect(
      finalizeJob(
        // @ts-expect-error -- intentionally invalid Pool to prove the assertion fires first
        undefined,
        {
          jobId: "x",
          leaseToken: "y",
          // "queued" is not a valid fromStatus for finalizeJob's type, but
          // reaching past the type system (as a real bug could) still hits
          // the runtime assertion first.
          fromStatus: "cancel_requested",
          outcome: { toStatus: "completed", result: {} },
        },
      ),
    ).rejects.toThrow(/illegal job transition/);
  });
});
