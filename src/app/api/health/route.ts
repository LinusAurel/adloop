import { NextResponse } from "next/server";
import { getPool } from "@/db/pool";

export async function GET(): Promise<NextResponse> {
  try {
    await getPool().query("SELECT 1");
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
