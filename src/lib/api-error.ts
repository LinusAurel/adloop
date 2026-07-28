import { NextResponse } from "next/server";

export interface ApiErrorBody {
  error: string;
  params?: Readonly<Record<string, string | number | boolean>>;
}

/** SPEC §8.2: stable identifiers and parameters, never user-facing prose. */
export function errorResponse(
  status: number,
  error: string,
  params?: ApiErrorBody["params"],
): NextResponse {
  return NextResponse.json(params ? { error, params } : { error }, { status });
}
