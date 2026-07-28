import { NextResponse } from "next/server";
import type { JobError } from "@/queue/types";

/** §5: every API error uses this exact shape, unconditionally. */
export function errorResponse(status: number, error: JobError): NextResponse {
  return NextResponse.json({ error }, { status });
}
