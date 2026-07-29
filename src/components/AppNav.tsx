"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "./ThemeProvider";

const ROUTES = [
  ["/chat", "chat"],
  ["/strategist", "strategist"],
  ["/workshop", "workshop"],
  ["/launch", "launch"],
  ["/settings", "settings"],
  ["/connectors", "connectors"],
  ["/metrics", "metrics"],
  ["/playbooks", "playbooks"],
  ["/queue", "queueSmoke"],
] as const;

export function AppNav() {
  const t = useTranslations("app");
  const { mode, setMode } = useTheme();
  const pathname = usePathname();

  return (
    <div className="bar">
      {/* Die Wortmarke trägt den Akzent auf der zweiten Silbe — der einzige
          Ort, an dem die Akzentfarbe ohne Handlungsbezug auftaucht. */}
      <Link href="/chat" className="mark">
        ad<span>loop</span>
      </Link>
      <nav>
        {ROUTES.map(([href, key]) => (
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
        {(["system", "light", "dark"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="chip"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {value === "system" ? t("themeSystem") : value === "light" ? t("themeLight") : t("themeDark")}
          </button>
        ))}
      </span>
    </div>
  );
}
