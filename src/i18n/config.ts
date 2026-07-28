export const locales = ["de", "en"] as const;
export type AppLocale = (typeof locales)[number];
export const defaultLocale: AppLocale = "de";
