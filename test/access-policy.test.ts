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

  // Test-audit correction: two calls being `.toEqual()` proves nothing
  // about purity if the implementation returns the SAME shared, mutable
  // object both times — a caller mutating its copy would silently corrupt
  // every future call's result, and the two-calls-equal assertion would
  // keep passing right up until the moment a test actually mutates one. The
  // implementation now returns frozen objects (both the outer tree and the
  // nested surfaces/actions objects); this asserts that directly instead of
  // inferring purity from equality.
  it("returns frozen objects that cannot be mutated by a caller", () => {
    const policy = evaluateAccessPolicy("owner");

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.surfaces)).toBe(true);
    expect(Object.isFrozen(policy.actions)).toBe(true);

    expect(() => {
      // Type-valid (AccessPolicy's fields aren't marked readonly at the
      // type level), but Object.freeze makes this throw at runtime — ES
      // modules are strict-mode by default, so a frozen-object assignment
      // throws instead of silently no-op'ing.
      policy.actions.publish = false;
    }).toThrow(TypeError);

    // And the mutation attempt, having thrown, did not corrupt a later call.
    expect(evaluateAccessPolicy("owner").actions.publish).toBe(true);
  });
});
