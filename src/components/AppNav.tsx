"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { locales } from "@/i18n/config";
import { useTheme } from "./ThemeProvider";

/**
 * Arbeit und Verwaltung sind zwei verschiedene Dinge, und nur eines davon tut
 * man täglich. Die vier Arbeitsbereiche stehen deshalb offen; alles, was man
 * einmal einrichtet und dann selten anfasst, liegt hinter einem Menü.
 *
 * Die Leiste bleibt oben: Eine Seitenspalte kostet dauerhaft Breite, und die
 * braucht diese Oberfläche für Tabellen mit zehn Spalten.
 */
const WORK = [
  ["/chat", "chat"],
  ["/strategist", "strategist"],
  ["/workshop", "workshop"],
  ["/launch", "launch"],
] as const;

const ADMIN = [
  // Zuerst, weil es die Seite ist, die man am Anfang braucht und danach nie
  // wieder — sie soll auffindbar sein, ohne die tägliche Arbeit zu belegen.
  ["/setup", "setup"],
  ["/settings", "settings"],
  ["/brand", "brand"],
  ["/connectors", "connectors"],
  ["/playbooks", "playbooks"],
  ["/metrics", "metrics"],
  ["/queue", "queueSmoke"],
] as const;

export function AppNav() {
  const t = useTranslations("app");
  const { mode, setMode } = useTheme();
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const [openMenu, setOpenMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Ein Menü, das sich nur über seinen eigenen Knopf schließen lässt, fühlt
  // sich wie ein Fehler an: Klick daneben und Escape schließen es auch.
  useEffect(() => {
    if (!openMenu) return;
    function onPointer(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpenMenu(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenu(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  const inAdmin = ADMIN.some(([href]) => pathname?.startsWith(href));

  async function chooseLocale(next: string) {
    if (next === locale) return;
    await fetch("/api/ui/locale", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: next }),
    });
    // Die Kataloge kommen vom Server, deshalb reicht kein Zustandswechsel.
    router.refresh();
  }

  return (
    <div className="bar">
      {/* Die Wortmarke trägt den Akzent auf der zweiten Silbe — der einzige
          Ort, an dem die Akzentfarbe ohne Handlungsbezug auftaucht. */}
      <Link href="/chat" className="mark">
        ad<span>loop</span>
      </Link>

      {/* Auf breiten Schirmen stehen die Arbeitsbereiche offen; auf schmalen
          wandern sie in dasselbe Menü wie alles andere, statt die Leiste
          umbrechen zu lassen. */}
      <nav className="work">
        {WORK.map(([href, key]) => (
          <Link
            key={href}
            href={href}
            aria-current={pathname?.startsWith(href) ? "page" : undefined}
          >
            {t(key)}
          </Link>
        ))}
      </nav>

      <span className="right">
        <div className="menu" ref={menuRef}>
          <button
            type="button"
            className="menu-trigger"
            aria-expanded={openMenu}
            aria-haspopup="true"
            aria-label={t("menu")}
            data-active={inAdmin ? "true" : undefined}
            onClick={() => setOpenMenu((open) => !open)}
          >
            <span className="wide-only">{t("manage")}</span>
            <span className="narrow-only" aria-hidden="true">
              ☰
            </span>
            <span className="chev wide-only" aria-hidden="true">
              ▾
            </span>
          </button>
          {openMenu && (
            <div className="menu-list" role="menu">
              <div className="narrow-only">
                {WORK.map(([href, key]) => (
                  <Link
                    key={href}
                    href={href}
                    role="menuitem"
                    aria-current={pathname?.startsWith(href) ? "page" : undefined}
                    onClick={() => setOpenMenu(false)}
                  >
                    {t(key)}
                  </Link>
                ))}
                <hr />
              </div>

              {ADMIN.map(([href, key]) => (
                <Link
                  key={href}
                  href={href}
                  role="menuitem"
                  aria-current={pathname?.startsWith(href) ? "page" : undefined}
                  onClick={() => setOpenMenu(false)}
                >
                  {t(key)}
                </Link>
              ))}

              <div className="narrow-only">
                <hr />
                <div className="menu-row">
                  <div className="seg" role="group" aria-label={t("language")}>
                    {locales.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={locale === value}
                        onClick={() => void chooseLocale(value)}
                      >
                        {value.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="menu-row">
                  <div className="seg" role="group" aria-label={t("brightness")}>
                    {(["system", "light", "dark"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={mode === value}
                        onClick={() => setMode(value)}
                      >
                        {value === "system"
                          ? t("themeSystem")
                          : value === "light"
                            ? t("themeLight")
                            : t("themeDark")}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Zwei getrennte Gruppen, nicht sechs Knöpfe in einer Reihe: Sprache
            und Helligkeit sind verschiedene Einstellungen und dürfen nicht
            aussehen wie eine einzige Auswahl mit sechs Möglichkeiten. */}
        <span className="wide-only switch-groups">
          <div className="seg" role="group" aria-label={t("language")}>
            {locales.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={locale === value}
                onClick={() => void chooseLocale(value)}
                title={t(value === "de" ? "localeDe" : "localeEn")}
              >
                {value.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="seg" role="group" aria-label={t("brightness")}>
            {(["system", "light", "dark"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {value === "system" ? t("themeSystem") : value === "light" ? t("themeLight") : t("themeDark")}
              </button>
            ))}
          </div>
        </span>
      </span>
    </div>
  );
}
