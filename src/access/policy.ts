import { z } from "zod";

/**
 * A pure function: role in, capability tree out. The frontend renders these
 * booleans directly instead of re-implementing role checks — see
 * SPEC.md §4.1. No authentication in Etappe 1; this is tested in isolation.
 */

export const RoleSchema = z.enum(["owner", "member"]);
export type Role = z.infer<typeof RoleSchema>;

export const AccessPolicySchema = z.object({
  surfaces: z.object({
    chat: z.boolean(),
    images: z.boolean(),
    strategist: z.boolean(),
    launch: z.boolean(),
  }),
  actions: z.object({
    publish: z.boolean(),
    manageTeam: z.boolean(),
    editPlaybooks: z.boolean(),
  }),
});
export type AccessPolicy = z.infer<typeof AccessPolicySchema>;

/**
 * Second review: `evaluateAccessPolicy` used to return the SAME mutable
 * object on every call for a given role — a caller mutating its copy (e.g.
 * `policy.actions.publish = true`) would corrupt every future call's
 * result too, and a test asserting `evaluateAccessPolicy("owner")` is
 * "pure" by checking two calls are `.toEqual()` wouldn't catch that, since
 * it would trivially hold even for the same shared, broken object. Freezing
 * (both levels — `surfaces` and `actions` are nested objects) makes any
 * such mutation throw in strict mode instead of silently succeeding.
 */
function deepFreezePolicy(policy: AccessPolicy): Readonly<AccessPolicy> {
  Object.freeze(policy.surfaces);
  Object.freeze(policy.actions);
  return Object.freeze(policy);
}

const OWNER_POLICY: AccessPolicy = deepFreezePolicy({
  surfaces: { chat: true, images: true, strategist: true, launch: true },
  actions: { publish: true, manageTeam: true, editPlaybooks: true },
});

// Not seeded or used anywhere in Etappe 1 — included so evaluateAccessPolicy
// is a real tree lookup instead of a single-case stub. See DECISIONS.md.
const MEMBER_POLICY: AccessPolicy = deepFreezePolicy({
  surfaces: { chat: true, images: true, strategist: true, launch: false },
  actions: { publish: false, manageTeam: false, editPlaybooks: false },
});

const DENY_ALL_POLICY: AccessPolicy = deepFreezePolicy({
  surfaces: { chat: false, images: false, strategist: false, launch: false },
  actions: { publish: false, manageTeam: false, editPlaybooks: false },
});

export function evaluateAccessPolicy(role: string): AccessPolicy {
  const parsedRole = RoleSchema.safeParse(role);
  if (!parsedRole.success) {
    return DENY_ALL_POLICY;
  }
  switch (parsedRole.data) {
    case "owner":
      return OWNER_POLICY;
    case "member":
      return MEMBER_POLICY;
  }
}
