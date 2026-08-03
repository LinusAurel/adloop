import { z } from "zod";

/**
 * The brand and product profile of one advertiser.
 *
 * Shape follows what a copywriter asks before writing a line, not what a
 * database would like to normalise. Prose fields instead of columns: a
 * paragraph someone actually writes beats twelve fields nobody fills in, and
 * everything here ends up as prose in the context packet anyway.
 *
 * Every field may be empty. A profile is filled in over weeks, and a form that
 * refuses to save until it is complete is a form that stays empty — the packet
 * names each gap instead (see brandProfileMarkdown).
 */

const PARAGRAPH_MAX = 1200;
const LINE_MAX = 200;
const TERM_MAX = 80;

/** Bounded on purpose: this text goes into every model request verbatim. */
const paragraph = z.string().max(PARAGRAPH_MAX);
const line = z.string().max(LINE_MAX);
const term = z.string().max(TERM_MAX);

export const OfferingSchema = z.object({
  name: z.string().max(120),
  /** What the buyer gets out of it — the benefit, not the feature list. */
  promise: z.string().max(400),
  /** Free text ("from 49 EUR / month", "quote only"): price shape varies more than a number allows. */
  price: z.string().max(80),
});

export const BrandProfileSchema = z.object({
  /** What the company does, in one paragraph. */
  business: paragraph,
  offerings: z.array(OfferingSchema).max(12),
  audience: z.object({
    who: paragraph,
    problem: paragraph,
  }),
  voice: z.object({
    /** How this brand speaks. */
    how: paragraph,
    /** And how it must not — the half that gets left out and then gets written. */
    avoid: paragraph,
  }),
  claims: z.object({
    /**
     * Provable statements: figures, awards, guarantees. The only ones the agent
     * may write as fact.
     */
    supported: z.array(line).max(30),
    /**
     * Statements the advertiser has not backed up. Kept — not deleted — so the
     * packet can forbid them by name; an unnamed claim gets invented instead.
     */
    unsupported: z.array(line).max(30),
  }),
  vocabulary: z.object({
    preferred: z.array(term).max(60),
    banned: z.array(term).max(60),
  }),
});

export type BrandProfile = z.infer<typeof BrandProfileSchema>;
export type Offering = z.infer<typeof OfferingSchema>;

export function emptyBrandProfile(): BrandProfile {
  return {
    business: "",
    offerings: [],
    audience: { who: "", problem: "" },
    voice: { how: "", avoid: "" },
    claims: { supported: [], unsupported: [] },
    vocabulary: { preferred: [], banned: [] },
  };
}

/** Trims, drops blank list entries, drops offerings with nothing in them. */
export function normalizeBrandProfile(profile: BrandProfile): BrandProfile {
  const lines = (values: string[]) =>
    values.map((value) => value.trim()).filter((value) => value.length > 0);
  return {
    business: profile.business.trim(),
    offerings: profile.offerings
      .map((offering) => ({
        name: offering.name.trim(),
        promise: offering.promise.trim(),
        price: offering.price.trim(),
      }))
      .filter(
        (offering) =>
          offering.name.length > 0 ||
          offering.promise.length > 0 ||
          offering.price.length > 0,
      ),
    audience: {
      who: profile.audience.who.trim(),
      problem: profile.audience.problem.trim(),
    },
    voice: { how: profile.voice.how.trim(), avoid: profile.voice.avoid.trim() },
    claims: {
      supported: lines(profile.claims.supported),
      unsupported: lines(profile.claims.unsupported),
    },
    vocabulary: {
      preferred: lines(profile.vocabulary.preferred),
      banned: lines(profile.vocabulary.banned),
    },
  };
}

/**
 * A saved-but-untouched profile tells the agent as little as no profile at all.
 * Treating the two alike keeps one honest wording for one situation.
 */
export function isBlankBrandProfile(profile: BrandProfile): boolean {
  const normalized = normalizeBrandProfile(profile);
  return (
    normalized.business === "" &&
    normalized.offerings.length === 0 &&
    normalized.audience.who === "" &&
    normalized.audience.problem === "" &&
    normalized.voice.how === "" &&
    normalized.voice.avoid === "" &&
    normalized.claims.supported.length === 0 &&
    normalized.claims.unsupported.length === 0 &&
    normalized.vocabulary.preferred.length === 0 &&
    normalized.vocabulary.banned.length === 0
  );
}

const ABSENT = [
  `## Brand`,
  ``,
  `No brand profile is on file for this advertiser.`,
  ``,
  `You therefore do not know this advertiser's business, products, audience,`,
  `tone or provable claims. Do not infer them from the ad copy, the account`,
  `name or the metrics, and do not invent them. Write nothing that states a`,
  `price, a guarantee, a figure, a certification or a delivery time as fact,`,
  `and list the brand facts you would have needed as open questions for the`,
  `advertiser.`,
].join("\n");

const NOT_SPECIFIED = "Not specified — do not fill this gap with an assumption.";

/**
 * The brand half of the context packet (SPEC §6.6 form: markdown, plain
 * statements). Silence is the failure mode this guards against: a packet that
 * simply omits the brand reads to the model like a brand with nothing to say,
 * and the model writes one from scratch. Absence is therefore stated, and so is
 * every empty section inside a profile that does exist.
 */
export function brandProfileMarkdown(profile: BrandProfile | null): string {
  if (profile === null || isBlankBrandProfile(profile)) return ABSENT;
  const p = normalizeBrandProfile(profile);
  const lines: string[] = [`## Brand`, ``, `### What the business does`, ``];

  lines.push(p.business || NOT_SPECIFIED, ``, `### Products and services`, ``);
  if (p.offerings.length === 0) {
    lines.push(NOT_SPECIFIED);
  } else {
    for (const offering of p.offerings) {
      const parts = [offering.name || "(unnamed)"];
      if (offering.promise) parts.push(offering.promise);
      if (offering.price) parts.push(`price: ${offering.price}`);
      lines.push(`- ${parts.join(" — ")}`);
    }
  }

  lines.push(
    ``,
    `### Audience`,
    ``,
    `- Who it speaks to: ${p.audience.who || NOT_SPECIFIED}`,
    `- Problem it solves: ${p.audience.problem || NOT_SPECIFIED}`,
    ``,
    `### Voice`,
    ``,
    `- How this brand speaks: ${p.voice.how || NOT_SPECIFIED}`,
    `- How it must not speak: ${p.voice.avoid || NOT_SPECIFIED}`,
    ``,
    `### Claims you may state as fact`,
    ``,
  );
  if (p.claims.supported.length === 0) {
    lines.push(
      `None on file. State no figure, award, guarantee or certification as fact.`,
    );
  } else {
    for (const claim of p.claims.supported) lines.push(`- ${claim}`);
  }

  lines.push(``, `### Claims you must not state as fact`, ``);
  if (p.claims.unsupported.length === 0) {
    lines.push(`None recorded.`);
  } else {
    lines.push(
      `The advertiser has not backed these up. Never write them as fact. If one`,
      `would strengthen the ad, name it as something the advertiser must confirm.`,
      ``,
    );
    for (const claim of p.claims.unsupported) lines.push(`- ${claim}`);
  }

  lines.push(
    ``,
    `### Vocabulary`,
    ``,
    `- Terms to use: ${p.vocabulary.preferred.length ? p.vocabulary.preferred.join(", ") : "none specified"}`,
    `- Terms never to use: ${p.vocabulary.banned.length ? p.vocabulary.banned.join(", ") : "none specified"}`,
  );

  return lines.join("\n");
}
