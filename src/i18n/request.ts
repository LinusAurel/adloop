import { getRequestConfig } from "next-intl/server";
import { defaultLocale, locales, type AppLocale } from "./config";

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  if (!locale || !locales.includes(locale as AppLocale)) {
    locale = defaultLocale;
  }
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    // No silent English fallback for missing German keys (SPEC §8.4).
    onError() {
      /* surface missing keys as the key name */
    },
    getMessageFallback({ key }) {
      return key;
    },
  };
});
