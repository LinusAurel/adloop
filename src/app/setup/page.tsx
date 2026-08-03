"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AppNav } from "@/components/AppNav";
import type { SetupStep, SetupStepId, SetupStepStatus } from "@/setup/steps";

interface SetupState {
  steps: SetupStep[];
  completed: number;
  total: number;
}

/**
 * Wohin ein Schritt führt. Zwei Schritte haben kein Ziel in der Oberfläche:
 * Meta-Zugangsdaten und Bildanbieter stehen in der Umgebung des Servers. Dort
 * einen Knopf hinzustellen wäre ein Versprechen, das die Seite nicht hält.
 */
const DESTINATION: Partial<Record<SetupStepId, { href: string; label: string }>> = {
  meta_connection: { href: "/connectors", label: "connectors" },
  insight_sync: { href: "/connectors", label: "connectors" },
  conversion_metric: { href: "/metrics", label: "metrics" },
  advertiser_defaults: { href: "/settings", label: "settings" },
};

/** Dieselben drei Rollen wie überall: erledigt, fehlt, nicht bewertbar. */
function statusColor(status: SetupStepStatus): string {
  if (status === "done") return "var(--good)";
  if (status === "todo") return "var(--warn)";
  return "var(--none)";
}

export default function SetupPage() {
  const t = useTranslations();
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/setup", { cache: "no-store" });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "unknown_error");
      return;
    }
    setState((await response.json()) as SetupState);
    setError(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <AppNav />
      <main className="page" style={{ maxWidth: 780 }}>
        <h1>{t("setup.title")}</h1>
        <p>{t("setup.lead")}</p>

        {error && (
          <div className="msgbox err" role="alert">
            {t("setup.loadFailed", { code: error })}
          </div>
        )}

        {!state && !error && <p style={{ color: "var(--dim)" }}>{t("setup.loading")}</p>}

        {state && (
          <>
            {/* Fünf Schritte sind keine Prozentzahl. Es steht da, wie viele
                von wie vielen — mehr Genauigkeit gibt es nicht zu haben. */}
            <div
              className="data"
              style={{
                fontSize: "var(--fs-label)",
                color: "var(--dim)",
                margin: "0 0 14px",
              }}
            >
              {t("setup.progress", { done: state.completed, total: state.total })}
            </div>

            {state.completed === state.total && (
              <div className="msgbox ok">{t("setup.allDone")}</div>
            )}

            {state.steps.map((step) => {
              const destination = DESTINATION[step.id];
              return (
                <div className="panel" key={step.id}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <i
                      className={`stripe${step.status === "blocked" ? " none" : ""}`}
                      style={{ background: statusColor(step.status) }}
                    />
                    <h2 style={{ margin: 0, flex: 1, minWidth: "18ch" }}>
                      {t(`setup.step.${step.id}.title` as never)}
                    </h2>
                    <span
                      className="band"
                      style={{ color: statusColor(step.status) }}
                    >
                      {t(`setup.status.${step.status}` as never)}
                    </span>
                    {step.essential && (
                      <span className="nogate">{t("setup.essential")}</span>
                    )}
                  </div>

                  <p
                    style={{
                      color: "var(--dim)",
                      fontSize: "var(--fs-small)",
                      margin: "8px 0 0",
                    }}
                  >
                    {t(`setup.step.${step.id}.why` as never)}
                  </p>

                  {/* Der Grund steht in der Farbe des Zustands, nicht in
                      Festbreitenschrift: Es ist ein Satz, keine Kennung. */}
                  {step.reason && (
                    <p
                      style={{
                        color: statusColor(step.status),
                        fontSize: "var(--fs-small)",
                        margin: "8px 0 0",
                      }}
                    >
                      {t(`setup.reason.${step.reason}` as never)}
                    </p>
                  )}

                  {step.pendingAccounts.length > 0 && (
                    <div className="hint">
                      {t("setup.pending", { accounts: step.pendingAccounts.join(", ") })}
                    </div>
                  )}

                  {destination && step.status !== "done" && (
                    <div className="acts" style={{ marginTop: 10 }}>
                      <Link className="btn" href={destination.href}>
                        {t(`setup.goto.${destination.label}` as never)}
                      </Link>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </main>
    </div>
  );
}
