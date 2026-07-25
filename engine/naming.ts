// Naming convention for Meta objects (build + parse). Underscore is the
// delimiter, so every segment value is sanitized to [A-Z0-9-]. Store IDs
// (ang_x, ast_y) become ANG-X / AST-Y inside names and are restored on parse.
// Names are the human fallback only — attribution runs exclusively over the
// persisted ad_id -> Asset -> Angle mapping.

const PREFIX = "ADLOOP";

function segment(value: string): string {
  return value
    .trim()
    .replace(/_/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "")
    .toUpperCase();
}

function brandSegment(brandSlug: string): string {
  return `${PREFIX}-${segment(brandSlug)}`;
}

// ANG-ABC123 -> ang_abc123 (store id form).
export function nameSegmentToId(seg: string): string {
  const idx = seg.indexOf("-");
  if (idx < 0) return seg.toLowerCase();
  return `${seg.slice(0, idx).toLowerCase()}_${seg.slice(idx + 1).toLowerCase()}`;
}

export function idToNameSegment(id: string): string {
  return segment(id.replace(/_/g, "-"));
}

// Campaign: {BRAND}_{ROLE}_{OBJECTIVE}_{BUDGETLEVEL}_{BIDSTRATEGY}_{YYYYMMDD}
// e.g. ADLOOP-LOYFT_CORE_LEADS_CBO_HV_20260725 (HV = highest volume,
// i.e. LOWEST_COST_WITHOUT_CAP).
export function buildCampaignName(args: {
  brandSlug: string;
  role?: string;
  objective?: string;
  budgetLevel?: string;
  bidStrategy?: string;
  date?: Date;
}): string {
  const d = args.date ?? new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  return [
    brandSegment(args.brandSlug),
    segment(args.role ?? "CORE"),
    segment(args.objective ?? "LEADS"),
    segment(args.budgetLevel ?? "CBO"),
    segment(args.bidStrategy ?? "HV"),
    ymd,
  ].join("_");
}

// AdSet: {BRAND}_{AUDIENCE}_{GEO}_{ANGLEID}. The single-CBO-broad playbook
// carries all angles in one broad ad set -> angle segment "ALL".
export function buildAdSetName(args: {
  brandSlug: string;
  audience?: string;
  geo: string;
  angleId?: string;
}): string {
  return [
    brandSegment(args.brandSlug),
    segment(args.audience ?? "BROAD"),
    segment(args.geo),
    args.angleId ? idToNameSegment(args.angleId) : "ALL",
  ].join("_");
}

// Ad: {BRAND}_{ANGLEID}_{ASSETID}_{FORMAT}_{VERSION}
export function buildAdName(args: {
  brandSlug: string;
  angleId: string;
  assetId: string;
  format?: string;
  version?: number;
}): string {
  return [
    brandSegment(args.brandSlug),
    idToNameSegment(args.angleId),
    idToNameSegment(args.assetId),
    segment(args.format ?? "4X5"),
    `V${args.version ?? 1}`,
  ].join("_");
}

export interface ParsedAdName {
  brandSlug: string;
  angleId: string;
  assetId: string;
  format: string;
  version: number;
}

// Parses an ad name built by buildAdName; returns undefined for foreign names.
export function parseAdName(name: string): ParsedAdName | undefined {
  const parts = name.split("_");
  if (parts.length !== 5) return undefined;
  const [brand, angle, asset, format, version] = parts;
  if (!brand.startsWith(`${PREFIX}-`)) return undefined;
  const v = /^V(\d+)$/.exec(version);
  if (!v) return undefined;
  return {
    brandSlug: brand.slice(PREFIX.length + 1).toLowerCase(),
    angleId: nameSegmentToId(angle),
    assetId: nameSegmentToId(asset),
    format,
    version: Number(v[1]),
  };
}
