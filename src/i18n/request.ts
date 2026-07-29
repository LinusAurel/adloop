import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, defaultLocale, isLocale } from "./config";

export default getRequestConfig(async ({ requestLocale }) => {
  // Reihenfolge: die Wahl des Menschen schlägt alles. Erst wenn kein Cookie
  // gesetzt ist, zählt das, was der Router mitbringt, und zuletzt der Standard.
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  const requested = await requestLocale;
  const locale = isLocale(chosen) ? chosen : isLocale(requested) ? requested : defaultLocale;

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
