import { describe, expect, it } from "vitest";
import {
  ContentLocaleSchema,
  DEFAULT_CONTENT_LOCALE,
} from "@/lib/content-locale";

describe("advertiser content locale", () => {
  it("keeps a dedicated BCP-47 default for generated ad copy", () => {
    expect(DEFAULT_CONTENT_LOCALE).toBe("de-DE");
    expect(ContentLocaleSchema.parse(DEFAULT_CONTENT_LOCALE)).toBe("de-DE");
  });

  it("canonicalizes valid tags and rejects UI-style locale identifiers", () => {
    expect(ContentLocaleSchema.parse("zh-hant-tw")).toBe("zh-Hant-TW");
    expect(ContentLocaleSchema.safeParse("de_DE").success).toBe(false);
    expect(ContentLocaleSchema.safeParse("not a locale!").success).toBe(false);
  });
});
