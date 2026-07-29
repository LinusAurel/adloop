export const locales = ["de", "en"] as const;
export type AppLocale = (typeof locales)[number];
export const defaultLocale: AppLocale = "de";

/**
 * Cookie carrying ui_locale (SPEC §8.1). A cookie rather than a path prefix:
 * the language of the interface is a property of the person, not of the
 * resource, and every link in the app would otherwise have to carry it.
 */
export const LOCALE_COOKIE = "adloop_locale";

export function isLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}
