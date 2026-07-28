import type { JobError } from "./types";

/** Thrown by handlers (directly or via the abortable helpers) when they notice cancellation. */
export class JobCancelledError extends Error {
  constructor(message = "job cancelled") {
    super(message);
    this.name = "JobCancelledError";
  }
}

/** A handler-thrown error that carries its own retry decision. */
export class HandlerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "HandlerError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Any error a handler throws that isn't a HandlerError is treated as an
 * unexpected bug in the handler, not a modeled failure — so it is never
 * retryable. §4.7: validation errors, aborts, and unknown families are
 * never retryable either; JobCancelledError is handled separately by the
 * caller before this function runs.
 */
export function normalizeError(err: unknown): JobError {
  if (err instanceof HandlerError) {
    return { code: err.code, message: err.message, retryable: err.retryable };
  }
  if (err instanceof Error) {
    return { code: "UNCAUGHT_EXCEPTION", message: err.message, retryable: false };
  }
  return { code: "UNKNOWN_ERROR", message: String(err), retryable: false };
}
