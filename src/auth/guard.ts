import type { NextRequest, NextResponse } from "next/server";
import type { Queryable } from "@/db/queryable";
import { errorResponse } from "@/lib/api-error";
import { getSession, type Session } from "./session";

export type Authentication =
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse };

export function authenticate(request: NextRequest): Authentication {
  const session = getSession(request);
  return session
    ? { ok: true, session }
    : { ok: false, response: errorResponse(401, "unauthenticated") };
}

const OWNED_RESOURCE_TABLES = {
  run: "run",
  job: "job",
  metaConnection: "meta_connection",
  metaAdAccount: "meta_ad_account",
  advertiser: "advertiser",
  asset: "asset",
  creative: "creative",
} as const;

export type OwnedResource = keyof typeof OWNED_RESOURCE_TABLES;

/**
 * Central object ownership guard. A false result is always exposed as 404,
 * whether the id is absent or belongs to another tenant.
 */
export async function ownsResource(
  db: Queryable,
  session: Session,
  resource: OwnedResource,
  id: string,
): Promise<boolean> {
  const table = OWNED_RESOURCE_TABLES[resource];
  const result = await db.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2`,
    [id, session.tenantId],
  );
  return result.rowCount === 1;
}

export async function requireOwnedResource(
  db: Queryable,
  session: Session,
  resource: OwnedResource,
  id: string,
): Promise<NextResponse | null> {
  return (await ownsResource(db, session, resource, id))
    ? null
    : errorResponse(404, "not_found");
}
