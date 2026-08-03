"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { locales } from "@/i18n/config";

/**
 * Sprachwahl als eigenes Bauteil, weil sie auch dort gebraucht wird, wo es
 * keine Navigationsleiste gibt: Wer die Anmeldeseite nicht lesen kann, kommt
 * nie an den Umschalter dahinter.
 */
export function LocaleSwitch() {
  const t = useTranslations("app");
  const router = useRouter();
  const locale = useLocale();

  async function choose(next: string) {
    if (next === locale) return;
    await fetch("/api/ui/locale", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: next }),
    });
    // Vollständiges Neuladen statt router.refresh().
    //
    // Die Kataloge hängen am NextIntlClientProvider im Wurzel-Layout. Ein
    // refresh() erneuert die Server-Komponenten des aktuellen Zweigs, lässt den
    // Provider darüber aber stehen — auf der Anmeldeseite, die vollständig
    // Client-Komponente ist, änderte sich deshalb erst nach einem manuellen
    // Neuladen etwas. Ein Sprachwechsel passiert ein- oder zweimal, ein
    // Neuladen ist dafür der richtige Preis.
    window.location.reload();
  }

  return (
    <>
      {locales.map((value) => (
        <button
          key={value}
          type="button"
          className="chip"
          aria-pressed={locale === value}
          onClick={() => void choose(value)}
          title={t(value === "de" ? "localeDe" : "localeEn")}
        >
          {value.toUpperCase()}
        </button>
      ))}
    </>
  );
}
