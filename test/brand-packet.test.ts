import { describe, expect, it } from "vitest";
import { buildContextPacketMarkdown, DEFAULT_METRIC_DEFINITIONS } from "@/agent/context-packet";
import {
  brandProfileMarkdown,
  emptyBrandProfile,
  isBlankBrandProfile,
  normalizeBrandProfile,
  type BrandProfile,
} from "@/brand/profile";

function filled(): BrandProfile {
  return {
    business: "Wir bauen Lastenräder für Handwerksbetriebe.",
    offerings: [
      { name: "Kastenrad K3", promise: "Ersetzt den zweiten Transporter", price: "ab 4.900 EUR" },
      { name: "Wartungsvertrag", promise: "Zwei Termine im Jahr", price: "" },
    ],
    audience: {
      who: "Inhaber kleiner Handwerksbetriebe in Städten",
      problem: "Parkplatzsuche und Umweltzonen kosten Stunden pro Woche",
    },
    voice: {
      how: "Nüchtern, handwerklich, Zahlen statt Adjektive",
      avoid: "Keine Nachhaltigkeitsromantik, kein Du",
    },
    claims: {
      supported: ["500 kg Zuladung, TÜV-geprüft", "24 Monate Garantie"],
      unsupported: ["Marktführer in Süddeutschland"],
    },
    vocabulary: { preferred: ["Lastenrad", "Zuladung"], banned: ["E-Bike", "grün"] },
  };
}

function packetWith(brand: BrandProfile | null): string {
  return buildContextPacketMarkdown({
    agentLocale: "de",
    contentLocale: "de-DE",
    brand,
    windowStart: "2026-07-01",
    windowEnd: "2026-07-30",
    performance: {
      spend: null,
      impressions: null,
      clicks: null,
      reach: null,
      frequency: null,
      ctr: null,
      cpc: null,
      cpm: null,
      conversions: null,
      conversionValue: null,
      roas: null,
    },
    derived: {
      funnelPosition: "insufficient_data",
      funnelScore: null,
      dataGatePassed: false,
      dataGateReasons: [],
      creativeStrain: null,
      creativeStrainScore: null,
    },
    nextStep: { cta: null, destinationUrl: null },
    metricDefinitions: DEFAULT_METRIC_DEFINITIONS,
  });
}

describe("brand profile in the context packet", () => {
  it("states outright that no profile is on file instead of staying silent", () => {
    const packet = packetWith(null);
    expect(packet).toContain("## Brand");
    expect(packet).toContain("No brand profile is on file");
    expect(packet).toMatch(/do not invent them/i);
  });

  it("treats a saved but entirely empty profile the same as none", () => {
    expect(isBlankBrandProfile(emptyBrandProfile())).toBe(true);
    expect(packetWith(emptyBrandProfile())).toContain("No brand profile is on file");
  });

  it("carries business, offerings, audience, voice and vocabulary into the packet", () => {
    const packet = packetWith(filled());
    expect(packet).toContain("Wir bauen Lastenräder für Handwerksbetriebe.");
    expect(packet).toContain("Kastenrad K3 — Ersetzt den zweiten Transporter — price: ab 4.900 EUR");
    // No price recorded: the offering still appears, without an empty price tail.
    expect(packet).toContain("- Wartungsvertrag — Zwei Termine im Jahr");
    expect(packet).not.toContain("Wartungsvertrag — Zwei Termine im Jahr — price:");
    expect(packet).toContain("Inhaber kleiner Handwerksbetriebe in Städten");
    expect(packet).toContain("Nüchtern, handwerklich, Zahlen statt Adjektive");
    expect(packet).toContain("Keine Nachhaltigkeitsromantik, kein Du");
    expect(packet).toContain("Terms to use: Lastenrad, Zuladung");
    expect(packet).toContain("Terms never to use: E-Bike, grün");
  });

  it("keeps provable and unproven claims apart, and forbids the unproven ones", () => {
    const markdown = brandProfileMarkdown(filled());
    const usable = markdown.indexOf("### Claims you may state as fact");
    const forbidden = markdown.indexOf("### Claims you must not state as fact");
    expect(usable).toBeGreaterThan(-1);
    expect(forbidden).toBeGreaterThan(usable);

    const usableSection = markdown.slice(usable, forbidden);
    const forbiddenSection = markdown.slice(forbidden);
    expect(usableSection).toContain("500 kg Zuladung, TÜV-geprüft");
    expect(usableSection).not.toContain("Marktführer in Süddeutschland");
    expect(forbiddenSection).toContain("Marktführer in Süddeutschland");
    expect(forbiddenSection).toContain("Never write them as fact");
  });

  it("says which section is empty rather than dropping it", () => {
    const sparse: BrandProfile = { ...emptyBrandProfile(), business: "Wir verkaufen Kaffee." };
    const markdown = brandProfileMarkdown(sparse);
    expect(markdown).toContain("Wir verkaufen Kaffee.");
    expect(markdown).toContain("### Products and services");
    expect(markdown).toContain("Not specified");
    expect(markdown).toContain(
      "None on file. State no figure, award, guarantee or certification as fact.",
    );
  });

  it("puts the brand ahead of the numbers", () => {
    const packet = packetWith(filled());
    expect(packet.indexOf("## Brand")).toBeLessThan(packet.indexOf("## Performance"));
  });

  it("drops blank list entries and offerings with nothing in them", () => {
    const messy: BrandProfile = {
      ...emptyBrandProfile(),
      offerings: [
        { name: "  ", promise: "", price: "" },
        { name: " Kaffee ", promise: "", price: "" },
      ],
      claims: { supported: [" ", "belegt "], unsupported: [] },
    };
    const clean = normalizeBrandProfile(messy);
    expect(clean.offerings).toEqual([{ name: "Kaffee", promise: "", price: "" }]);
    expect(clean.claims.supported).toEqual(["belegt"]);
  });
});
