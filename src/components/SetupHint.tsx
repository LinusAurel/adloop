"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { openEssentialSteps, type SetupStep, type SetupStepId } from "@/setup/steps";

const STORAGE_KEY = "adloop-setup-dismissed";

/**
 * Was schon weggeklickt wurde. Im lokalen Speicher, nicht im Zustand: Ein
 * Hinweis, der bei jedem Seitenwechsel zurückkommt, ist kein Hinweis mehr,
 * sondern eine Sperre, die man nur nicht anfassen kann.
 */
function readDismissed(): SetupStepId[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed.filter((v) => typeof v === "string") as SetupStepId[]) : [];
  } catch {
    return [];
  }
}

/**
 * Der knappe Hinweis auf den Arbeitsseiten. Er erscheint nur, solange ein
 * wesentlicher Schritt fehlt, und nur für Schritte, die noch niemand
 * weggeklickt hat.
 *
 * Die Regel beim Wegklicken ist bewusst nachsichtig: Wer „drei Schritte
 * fehlen" wegklickt, hat auch „zwei davon fehlen noch" weggeklickt — sonst
 * käme der Hinweis nach jedem Fortschritt zurück und bestrafte gerade den,
 * der etwas erledigt hat. Kommt dagegen ein Schritt neu dazu, etwa weil eine
 * Verbindung abgelaufen ist, ist das eine neue Nachricht und sie erscheint.
 */
export function SetupHint({ style }: { style?: CSSProperties }) {
  const t = useTranslations();
  const [open, setOpen] = useState<SetupStepId[] | null>(null);
  const [dismissed, setDismissed] = useState<SetupStepId[]>([]);

  useEffect(() => {
    let cancelled = false;
    setDismissed(readDismissed());
    void (async () => {
      const response = await fetch("/api/setup", { cache: "no-store" });
      if (!response.ok || cancelled) return;
      const data = (await response.json()) as { steps: SetupStep[] };
      if (!cancelled) setOpen(openEssentialSteps(data.steps));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (open === null || open.length === 0) return null;
  if (open.every((id) => dismissed.includes(id))) return null;

  function hide() {
    const next = [...new Set([...dismissed, ...(open ?? [])])];
    setDismissed(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ohne lokalen Speicher bleibt der Hinweis für diese Sitzung weg. Das
      // ist besser, als den Klick wirkungslos zu lassen.
    }
  }

  return (
    <div
      className="msgbox warn"
      role="status"
      style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", ...style }}
    >
      <strong style={{ fontWeight: 640 }}>{t("setup.hintTitle")}</strong>
      <span>{t("setup.hintOpen", { count: open.length })}</span>
      <Link href="/setup" style={{ marginLeft: "auto" }}>
        {t("setup.hintLink")}
      </Link>
      <button type="button" className="chip" onClick={hide}>
        {t("setup.hintDismiss")}
      </button>
    </div>
  );
}
