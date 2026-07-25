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
  // Set by a human upfront; code treats this as immutable (Hard Stop 4).
  fixedDailyBudgetCents: number | null;
  campaignId?: string;
  adsetId?: string;
}

export interface Brand {
  slug: string;
  name: string;
  url: string;
  product: string;
  conversionGoal: ConversionGoal;
  targetCpa: number;
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

export interface Run {
  id: string;
  brandSlug: string;
  stage: string;
  log: RunLogEntry[];
  startedAt: string;
  finishedAt: string | null;
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
