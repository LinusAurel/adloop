import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { uuidv7 } from "uuidv7";
import { assembleContextPacket } from "@/agent/context-packet";
import {
  GET as getBrandProfile,
  PUT as putBrandProfile,
} from "@/app/api/brand-profile/route";
import { createSession, encodeSession, SESSION_COOKIE } from "@/auth/session";
import { emptyBrandProfile, type BrandProfile } from "@/brand/profile";
import {
  BrandProfileError,
  loadLatestBrandProfile,
  saveBrandProfile,
} from "@/brand/store";
import { setPoolForTests } from "@/db/pool";
import { startTestDb, type TestDb } from "./db-harness";

function profile(business: string): BrandProfile {
  return { ...emptyBrandProfile(), business };
}

describe("advertiser brand profile", () => {
  let db: TestDb;
  let userId: string;
  let advertiserId: string;
  let cookie: string;

  beforeAll(async () => {
    db = await startTestDb();
    setPoolForTests(db.pool);

    userId = uuidv7();
    await db.pool.query(
      `INSERT INTO app_user (id, tenant_id, email, role, ui_locale, agent_locale)
       VALUES ($1, $2, 'brand@example.com', 'owner', 'de', 'de')`,
      [userId, db.tenantId],
    );
    advertiserId = uuidv7();
    await db.pool.query(
      `INSERT INTO advertiser (id, tenant_id, name, content_locale)
       VALUES ($1, $2, 'Brand AG', 'de-DE')`,
      [advertiserId, db.tenantId],
    );
    cookie = `${SESSION_COOKIE}=${encodeSession(createSession(userId, db.tenantId))}`;
  }, 60_000);

  afterAll(async () => {
    setPoolForTests(null);
    await db.stop();
  });

  it("versions every save and refuses one built on a stale version", async () => {
    const first = await saveBrandProfile(db.pool, {
      tenantId: db.tenantId,
      advertiserId,
      profile: profile("Erste Fassung"),
      createdBy: userId,
      expectedVersion: null,
    });
    expect(first.version).toBe(1);

    const second = await saveBrandProfile(db.pool, {
      tenantId: db.tenantId,
      advertiserId,
      profile: profile("Zweite Fassung"),
      createdBy: userId,
      expectedVersion: 1,
    });
    expect(second.version).toBe(2);

    await expect(
      saveBrandProfile(db.pool, {
        tenantId: db.tenantId,
        advertiserId,
        profile: profile("Auf einer alten Fassung gebaut"),
        createdBy: userId,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "brand_profile_version_conflict" });

    const latest = await loadLatestBrandProfile(db.pool, db.tenantId, advertiserId);
    expect(latest?.version).toBe(2);
    expect(latest?.profile.business).toBe("Zweite Fassung");
  });

  it("does not hand one tenant's profile to another", async () => {
    const otherTenant = uuidv7();
    const otherAdvertiser = uuidv7();
    await db.pool.query(`INSERT INTO tenant (id, name) VALUES ($1, 'other')`, [otherTenant]);
    await db.pool.query(
      `INSERT INTO advertiser (id, tenant_id, name, content_locale)
       VALUES ($1, $2, 'Fremd GmbH', 'de-DE')`,
      [otherAdvertiser, otherTenant],
    );
    await saveBrandProfile(db.pool, {
      tenantId: otherTenant,
      advertiserId: otherAdvertiser,
      profile: profile("Fremde Marke"),
      createdBy: userId,
      expectedVersion: null,
    });

    // Same advertiser id, wrong tenant: nothing comes back.
    expect(
      await loadLatestBrandProfile(db.pool, db.tenantId, otherAdvertiser),
    ).toBeNull();

    const response = await getBrandProfile(
      new NextRequest(
        `http://localhost/api/brand-profile?advertiserId=${otherAdvertiser}`,
        { headers: { cookie } },
      ),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("rejects an unauthenticated read", async () => {
    const response = await getBrandProfile(
      new NextRequest(`http://localhost/api/brand-profile?advertiserId=${advertiserId}`),
    );
    expect(response.status).toBe(401);
  });

  it("reports a version conflict to the API caller as a stable code", async () => {
    const conflictAdvertiser = uuidv7();
    await db.pool.query(
      `INSERT INTO advertiser (id, tenant_id, name, content_locale)
       VALUES ($1, $2, 'Konflikt AG', 'de-DE')`,
      [conflictAdvertiser, db.tenantId],
    );
    const body = (expectedVersion: number | null) => ({
      advertiserId: conflictAdvertiser,
      expectedVersion,
      profile: profile("  Randlos  "),
    });

    const created = await putBrandProfile(
      new NextRequest("http://localhost/api/brand-profile", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body(null)),
      }),
    );
    expect(created.status).toBe(200);
    // The response echoes what was stored, not what was sent.
    await expect(created.json()).resolves.toMatchObject({
      version: 1,
      profile: { business: "Randlos" },
    });

    const stale = await putBrandProfile(
      new NextRequest("http://localhost/api/brand-profile", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body(null)),
      }),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: "brand_profile_version_conflict",
    });
  });

  it("refuses to read a stored profile that no longer matches the schema", async () => {
    const brokenAdvertiser = uuidv7();
    await db.pool.query(
      `INSERT INTO advertiser (id, tenant_id, name, content_locale)
       VALUES ($1, $2, 'Kaputt AG', 'de-DE')`,
      [brokenAdvertiser, db.tenantId],
    );
    await db.pool.query(
      `INSERT INTO advertiser_brand_profile (id, tenant_id, advertiser_id, version, profile)
       VALUES ($1, $2, $3, 1, '{"business":"nur die Hälfte"}'::jsonb)`,
      [uuidv7(), db.tenantId, brokenAdvertiser],
    );
    await expect(
      loadLatestBrandProfile(db.pool, db.tenantId, brokenAdvertiser),
    ).rejects.toBeInstanceOf(BrandProfileError);
  });

  it("puts the profile into the context packet even before an ad account exists", async () => {
    // The path taken by a tenant that has done nothing but fill in the brand:
    // no ad account, no sync, and therefore an early return out of the packet
    // assembly. That early return is where the brand is easiest to lose.
    const freshTenant = uuidv7();
    const freshAdvertiser = uuidv7();
    await db.pool.query(`INSERT INTO tenant (id, name) VALUES ($1, 'fresh')`, [freshTenant]);
    await db.pool.query(
      `INSERT INTO advertiser (id, tenant_id, name, content_locale)
       VALUES ($1, $2, 'Frisch GmbH', 'de-DE')`,
      [freshAdvertiser, freshTenant],
    );
    await saveBrandProfile(db.pool, {
      tenantId: freshTenant,
      advertiserId: freshAdvertiser,
      profile: {
        ...emptyBrandProfile(),
        business: "Wir rösten Kaffee in Stuttgart.",
        claims: { supported: ["Seit 1994"], unsupported: ["Bester Kaffee der Stadt"] },
        vocabulary: { preferred: ["Röstung"], banned: ["Kaffeeerlebnis"] },
      },
      createdBy: userId,
      expectedVersion: null,
    });

    const { packet } = await assembleContextPacket(db.pool, {
      tenantId: freshTenant,
      agentLocale: "de",
      contentLocale: "de-DE",
      windowStart: "2026-07-01",
      windowEnd: "2026-07-30",
    });

    expect(packet).toContain("no_ad_account_selected");
    expect(packet).toContain("Wir rösten Kaffee in Stuttgart.");
    expect(packet).toContain("Seit 1994");
    expect(packet).toContain("Terms never to use: Kaffeeerlebnis");
    const forbidden = packet.indexOf("### Claims you must not state as fact");
    expect(packet.indexOf("Bester Kaffee der Stadt")).toBeGreaterThan(forbidden);
  });

  it("says the brand is unknown for a tenant that has no advertiser at all", async () => {
    const bareTenant = uuidv7();
    await db.pool.query(`INSERT INTO tenant (id, name) VALUES ($1, 'bare')`, [bareTenant]);
    const { packet } = await assembleContextPacket(db.pool, {
      tenantId: bareTenant,
      agentLocale: "de",
      contentLocale: "de-DE",
      windowStart: "2026-07-01",
      windowEnd: "2026-07-30",
    });
    expect(packet).toContain("No brand profile is on file");
  });
});
