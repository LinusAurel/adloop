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

const OWNER_POLICY: AccessPolicy = {
  surfaces: { chat: true, images: true, strategist: true, launch: true },
  actions: { publish: true, manageTeam: true, editPlaybooks: true },
};

// Not seeded or used anywhere in Etappe 1 — included so evaluateAccessPolicy
// is a real tree lookup instead of a single-case stub. See DECISIONS.md.
const MEMBER_POLICY: AccessPolicy = {
  surfaces: { chat: true, images: true, strategist: true, launch: false },
  actions: { publish: false, manageTeam: false, editPlaybooks: false },
};

const DENY_ALL_POLICY: AccessPolicy = {
  surfaces: { chat: false, images: false, strategist: false, launch: false },
  actions: { publish: false, manageTeam: false, editPlaybooks: false },
};

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
