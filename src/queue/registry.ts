import type { AnyJobFamilyDefinition, JobFamilyDefinition } from "./types";

/**
 * ============================================================================
 * AT-LEAST-ONCE, NOT EXACTLY-ONCE.
 *
 * A job can be claimed, run to completion, and re-claimed by another worker
 * before its terminal write lands (crash, lost lease, slow network). Every
 * handler registered here WILL run more than once for the same logical unit
 * of work under those conditions. If a handler causes an external effect
 * (an API call, a charge, a publish), it MUST be idempotent — carry its own
 * idempotency key and check before acting, not just before writing.
 *
 * This is not a theoretical concern starting in a later stage: it is true
 * today, for every family below. See SPEC.md §3.2 and §3.5.
 * ============================================================================
 */

const registry = new Map<string, AnyJobFamilyDefinition>();

export function registerFamily<TInput, TResult>(
  family: JobFamilyDefinition<TInput, TResult>,
): void {
  if (registry.has(family.name)) {
    throw new Error(`job family already registered: ${family.name}`);
  }
  registry.set(family.name, family as unknown as AnyJobFamilyDefinition);
}

export function getFamily(name: string): AnyJobFamilyDefinition | undefined {
  return registry.get(name);
}

export function isFamilyRegistered(name: string): boolean {
  return registry.has(name);
}

/** Test-only: reset between test files that register different family sets. */
export function clearRegistry(): void {
  registry.clear();
}
