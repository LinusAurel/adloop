// Data model per SPEC.md §1. Company-specific values live in brands/<slug>/,
// never in code.

export type ConversionGoal = "website_lead";

// Deterministic copy rules per brand (Critic stage). Patterns are plain
// RegExp sources so they can live in brand.json (data, not code).
export interface ForbiddenPattern {
  pattern: string;
  flags?: string;
  reason: string;
}

export interface CopyRules {
  forbiddenPatterns: ForbiddenPattern[];
}

export interface BrandMeta {
  adAccountId: string;
  pageId: string;
  pixelId: string;
  leadEventName: string;
  geoCountries: string[];
  optimizationGoal: string;
  billingEvent: string;
  specialAdCategories: string[];
  // EU DSA: who is promoted / who pays (required for EU-targeted ad sets).
  // Falls back to the brand name when unset.
  dsaBeneficiary?: string;
  dsaPayor?: string;
  // Set by a human upfront; code treats this as immutable (Hard Stop 4).
  fixedDailyBudgetCents: number | null;
  campaignId?: string;
  adsetId?: string;
}

export interface Brand {
  slug: string;
  name: string;
  url: string;
  // Optional wa.me placeholder for the landing page CTA; falls back to url.
  whatsappUrl?: string;
  product: string;
  conversionGoal: ConversionGoal;
  // null for freshly onboarded brands (Scout) until a human sets a goal.
  targetCpa: number | null;
  guardrails: string[];
  copyRules?: CopyRules;
  designTokens: Record<string, string>;
  meta: BrandMeta;
}

export type EvidenceTag = "real" | "external" | "hypothesis";

export interface Evidence {
  id: string;
  brandSlug: string;
  tag: EvidenceTag;
  source: string;
  text: string;
  createdBy: string;
}

export type AngleStatus = "draft" | "approved" | "testing" | "validated" | "killed";

export interface Angle {
  id: string;
  brandSlug: string;
  name: string;
  segment: string;
  pain: string;
  mechanism: string;
  hookDirection: string;
  status: AngleStatus;
  expectedCpl?: number;
  measuredCpl?: number;
  rationale: string;
}

export type AssetKind = "ad_copy" | "static" | "lp";
export type AssetStatus = "draft" | "approved" | "rejected" | "published";

export interface Asset {
  id: string;
  angleId: string;
  kind: AssetKind;
  payload: unknown;
  criticScore?: number;
  criticNotes?: string;
  status: AssetStatus;
  metaIds?: { creativeId?: string; adId?: string };
}

export interface RunLogEntry {
  ts: string;
  agent: string;
  message: string;
  level?: "info" | "warn" | "error";
}

// Long mutation routes answer 202 + runId immediately (#7); the UI derives
// progress from these fields via /state polling.
export type RunStatus = "running" | "finished" | "failed";

export interface Run {
  id: string;
  brandSlug: string;
  stage: string;
  // Angle the run works on (assets pipeline) — enables per-angle UI state.
  angleId?: string;
  log: RunLogEntry[];
  startedAt: string;
  finishedAt: string | null;
  // Missing on runs written before the async-job pattern; treat as legacy.
  status?: RunStatus;
  error?: string;
  // Stage result for consumers that used to read the HTTP response body
  // (currently only the Analyst writes one).
  result?: unknown;
}

export type LearningSource = "meta_insights" | "human_review";

export interface Learning {
  id: string;
  brandSlug: string;
  source: LearningSource;
  pattern: string;
  evidenceRefs: string[];
  appliedToSkill?: string;
}

export interface BrandState {
  brand: Brand;
  evidence: Evidence[];
  angles: Angle[];
  assets: Asset[];
  runs: Run[];
  learnings: Learning[];
}
