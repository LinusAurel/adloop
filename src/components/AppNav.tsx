"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useTheme } from "./ThemeProvider";

const navStyle: React.CSSProperties = {
  display: "flex",
  gap: "1rem",
  alignItems: "center",
  padding: "0.75rem 1rem",
  borderBottom: "1px solid var(--line)",
  background: "var(--surface)",
};

const linkStyle: React.CSSProperties = {
  color: "var(--fg)",
  textDecoration: "none",
  fontSize: "0.95rem",
};

export function AppNav() {
  const t = useTranslations("app");
  const { mode, setMode } = useTheme();

  return (
    <nav style={navStyle}>
      <strong style={{ color: "var(--accent)", marginRight: "0.5rem" }}>{t("title")}</strong>
      <Link href="/chat" style={linkStyle}>
        {t("chat")}
      </Link>
      <Link href="/strategist" style={linkStyle}>
        {t("strategist")}
      </Link>
      <Link href="/workshop" style={linkStyle}>
        {t("workshop")}
      </Link>
      <Link href="/connectors" style={linkStyle}>
        {t("connectors")}
      </Link>
      <Link href="/metrics" style={linkStyle}>
        {t("metrics")}
      </Link>
      <Link href="/playbooks" style={linkStyle}>
        {t("playbooks")}
      </Link>
      <Link href="/queue" style={linkStyle}>
        {t("queueSmoke")}
      </Link>
      <span style={{ marginLeft: "auto", display: "flex", gap: "0.35rem" }}>
        {(["system", "light", "dark"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            style={{
              background: mode === value ? "var(--accent)" : "var(--raised)",
              color: mode === value ? "var(--on-accent)" : "var(--fg)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius)",
              padding: "0.25rem 0.5rem",
              cursor: "pointer",
            }}
          >
            {value === "system" ? t("themeSystem") : value === "light" ? t("themeLight") : t("themeDark")}
          </button>
        ))}
      </span>
    </nav>
  );
}
