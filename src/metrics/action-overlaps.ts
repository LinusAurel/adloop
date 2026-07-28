/**
 * Known Meta action-type overlaps. `omni_*` aggregates the listed sources;
 * summing them with `sum_disjoint` double-counts the same conversion.
 *
 * Incomplete by nature — Meta adds aliases. Configuration rejects only pairs
 * present here; unknown pairs are allowed through with sum_disjoint.
 */
const OVERLAP_GROUPS: readonly (readonly string[])[] = [
  [
    "omni_purchase",
    "purchase",
    "offsite_conversion.fb_pixel_purchase",
    "web_in_store_purchase",
    "onsite_conversion.purchase",
  ],
  [
    "omni_lead",
    "lead",
    "offsite_conversion.fb_pixel_lead",
    "onsite_conversion.lead_grouped",
    "onsite_conversion.lead",
  ],
  [
    "omni_complete_registration",
    "complete_registration",
    "offsite_conversion.fb_pixel_complete_registration",
  ],
  [
    "omni_add_to_cart",
    "add_to_cart",
    "offsite_conversion.fb_pixel_add_to_cart",
  ],
  [
    "omni_initiated_checkout",
    "initiate_checkout",
    "offsite_conversion.fb_pixel_initiate_checkout",
  ],
  [
    "omni_view_content",
    "view_content",
    "offsite_conversion.fb_pixel_view_content",
  ],
  [
    "omni_search",
    "search",
    "offsite_conversion.fb_pixel_search",
  ],
  [
    "omni_add_payment_info",
    "add_payment_info",
    "offsite_conversion.fb_pixel_add_payment_info",
  ],
];

function overlapKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

const OVERLAP_PAIRS = new Set<string>();
for (const group of OVERLAP_GROUPS) {
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      OVERLAP_PAIRS.add(overlapKey(group[i]!, group[j]!));
    }
  }
}

export function actionTypesOverlap(a: string, b: string): boolean {
  return a !== b && OVERLAP_PAIRS.has(overlapKey(a, b));
}

export function findOverlappingActionTypes(
  actionTypes: readonly string[],
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < actionTypes.length; i += 1) {
    for (let j = i + 1; j < actionTypes.length; j += 1) {
      const left = actionTypes[i]!;
      const right = actionTypes[j]!;
      if (actionTypesOverlap(left, right)) {
        pairs.push([left, right]);
      }
    }
  }
  return pairs;
}

export function assertSumDisjointAllowed(
  actionTypes: readonly string[],
): void {
  const overlaps = findOverlappingActionTypes(actionTypes);
  if (overlaps.length > 0) {
    const detail = overlaps.map(([a, b]) => `${a}∩${b}`).join(", ");
    throw new MetricConfigError(
      "overlapping_action_types",
      `sum_disjoint rejects known-overlapping action types: ${detail}`,
    );
  }
}

export class MetricConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MetricConfigError";
    this.code = code;
  }
}
