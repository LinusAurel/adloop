import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { requestLoginCode, verifyLoginCode } from "@/auth/login-code";
import type { TestDb } from "./db-harness";
import { startTestDb } from "./db-harness";

describe("email code login", () => {
  let db: TestDb;
  let userId: string;
  const email = "login@example.com";

  beforeAll(async () => {
    db = await startTestDb();
    userId = uuidv7();
    await db.pool.query(
      `INSERT INTO app_user (id, tenant_id, email, role)
       VALUES ($1, $2, $3, 'owner')`,
      [userId, db.tenantId, email],
    );
  }, 60_000);

  afterAll(async () => {
    await db.stop();
  });

  it("redeems a six-digit code exactly once", async () => {
    expect(
      await requestLoginCode(db.pool, email, { generateCode: () => "123456" }),
    ).toBe("accepted");

    await expect(verifyLoginCode(db.pool, email, "123456")).resolves.toEqual({
      userId,
      tenantId: db.tenantId,
    });
    await expect(verifyLoginCode(db.pool, email, "123456")).resolves.toBeNull();
  });

  it("locks a code after five wrong attempts", async () => {
    await requestLoginCode(db.pool, email, { generateCode: () => "654321" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(verifyLoginCode(db.pool, email, "000000")).resolves.toBeNull();
    }
    await expect(verifyLoginCode(db.pool, email, "654321")).resolves.toBeNull();
  });

  it("does not reveal unknown email addresses", async () => {
    await expect(requestLoginCode(db.pool, "unknown@example.com")).resolves.toBe("accepted");
  });
});
