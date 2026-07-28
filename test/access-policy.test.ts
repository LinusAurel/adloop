import { describe, expect, it } from "vitest";
import { evaluateAccessPolicy } from "@/access/policy";

describe("evaluateAccessPolicy", () => {
  it("grants the owner role every surface and action", () => {
    const policy = evaluateAccessPolicy("owner");
    expect(policy.surfaces).toEqual({ chat: true, images: true, strategist: true, launch: true });
    expect(policy.actions).toEqual({ publish: true, manageTeam: true, editPlaybooks: true });
  });

  it("is a real tree lookup, not a single-case stub — member gets a different, narrower tree", () => {
    const policy = evaluateAccessPolicy("member");
    expect(policy.surfaces.launch).toBe(false);
    expect(policy.actions.publish).toBe(false);
    expect(policy).not.toEqual(evaluateAccessPolicy("owner"));
  });

  it("denies everything for an unrecognized role instead of throwing", () => {
    const policy = evaluateAccessPolicy("not-a-real-role");
    expect(policy.surfaces).toEqual({ chat: false, images: false, strategist: false, launch: false });
    expect(policy.actions).toEqual({ publish: false, manageTeam: false, editPlaybooks: false });
  });

  it("is pure: calling it twice with the same role returns equal trees", () => {
    expect(evaluateAccessPolicy("owner")).toEqual(evaluateAccessPolicy("owner"));
  });
});
