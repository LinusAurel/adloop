import {
  createHmac,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { uuidv7 } from "uuidv7";
import type { Queryable } from "@/db/queryable";
import { withTransaction } from "@/db/queryable";
import { env } from "@/lib/env";

const CODE_TTL_MINUTES = 10;
const REQUEST_WINDOW_MINUTES = 15;
const MAX_REQUESTS_PER_WINDOW = 5;

function codeHash(id: string, code: string): Buffer {
  return createHmac("sha256", env.SESSION_SECRET)
    .update(`login-code:${id}:${code}`)
    .digest();
}

function sixDigitCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export type RequestCodeResult = "accepted" | "rate_limited";

export async function requestLoginCode(
  db: Queryable,
  email: string,
  options: { generateCode?: () => string } = {},
): Promise<RequestCodeResult> {
  const userResult = await db.query<{ id: string }>(
    `SELECT id FROM app_user WHERE email = $1 ORDER BY created_at LIMIT 2`,
    [email],
  );

  // Do not reveal whether an address exists. Ambiguous duplicate addresses
  // across tenants also fail closed until a membership chooser exists.
  if (userResult.rows.length !== 1) return "accepted";
  const userId = userResult.rows[0]!.id;

  const recent = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM login_code
     WHERE app_user_id = $1
       AND created_at > now() - ($2 || ' minutes')::interval`,
    [userId, REQUEST_WINDOW_MINUTES],
  );
  if (Number(recent.rows[0]!.count) >= MAX_REQUESTS_PER_WINDOW) {
    return "rate_limited";
  }

  const id = uuidv7();
  const code = options.generateCode?.() ?? sixDigitCode();
  if (!/^\d{6}$/.test(code)) throw new Error("login code generator returned an invalid code");
  await withTransaction(db, async (client) => {
    await client.query(
      `UPDATE login_code
       SET consumed_at = now()
       WHERE app_user_id = $1
         AND consumed_at IS NULL`,
      [userId],
    );
    await client.query(
      `INSERT INTO login_code (
         id, app_user_id, code_hash, expires_at, created_at
       ) VALUES (
         $1, $2, $3, now() + ($4 || ' minutes')::interval, now()
       )`,
      [id, userId, codeHash(id, code).toString("hex"), CODE_TTL_MINUTES],
    );
  });

  if (env.AUTH_CODE_DELIVERY === "log") {
    // Development delivery adapter. Never log a Meta token here.
    // eslint-disable-next-line no-console
    console.info(`[auth] code for ${email}: ${code}`);
  }
  return "accepted";
}

export interface VerifiedLogin {
  userId: string;
  tenantId: string;
}

export async function verifyLoginCode(
  db: Queryable,
  email: string,
  code: string,
): Promise<VerifiedLogin | null> {
  return withTransaction(db, async (client) => {
    const result = await client.query<{
      id: string;
      code_hash: string;
      attempts: number;
      user_id: string;
      tenant_id: string;
    }>(
      `SELECT
         c.id,
         c.code_hash,
         c.attempts,
         u.id AS user_id,
         u.tenant_id
       FROM app_user u
       JOIN login_code c ON c.app_user_id = u.id
       WHERE u.email = $1
         AND c.consumed_at IS NULL
         AND c.expires_at > now()
         AND c.attempts < 5
       ORDER BY c.created_at DESC
       LIMIT 1
       FOR UPDATE OF c`,
      [email],
    );

    const row = result.rows[0];
    if (!row) {
      // Keep the unknown/expired path close to the valid path's crypto cost.
      timingSafeEqual(codeHash("00000000-0000-0000-0000-000000000000", code), Buffer.alloc(32));
      return null;
    }

    await client.query(
      `UPDATE login_code
       SET attempts = attempts + 1
       WHERE id = $1`,
      [row.id],
    );

    const expected = Buffer.from(row.code_hash, "hex");
    const supplied = codeHash(row.id, code);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return null;
    }

    await client.query(
      `UPDATE login_code
       SET consumed_at = now()
       WHERE id = $1`,
      [row.id],
    );
    return { userId: row.user_id, tenantId: row.tenant_id };
  });
}
