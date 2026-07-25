"use client";

// Wirtschaftlichkeit: one campaign card on top (goal on campaign level,
// measured value large, trend, status badge), winners/losers as compact rows,
// learnings below. Fixture results stay labelled „Demo-Daten“ (SPEC §3).
// Job pattern (#7): POST /optimize answers 202 + runId, the result arrives
// as run.result via the existing 5s /state polling.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisResult, ClassifiedAdRow } from "@/engine/agents/analyst";
import type { BrandState } from "@/engine/types";
import {
  ActionButton,
  Card,
  ErrorNote,
  GroupHeading,
  actionError,
  postAction,
  type ActionResult,
} from "@/components/bits";
import { euro } from "@/lib/format";

// Defensive extensions the engine stream delivers step by step: a campaign
// level goal `target: {metric, value}`, an optional trend series and a
// campaign status. Missing fields fall back gracefully.
interface EconomicsExtras {
  target?: { metric?: string; value?: number };
  trend?: number[];
  campaignId?: string;
  campaignName?: string;
  campaignStatus?: "ACTIVE" | "PAUSED";
}

function Sparkline({ points }: { points: number[] }) {
  const w = 120;
  const h = 32;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-8 w-[120px] text-ink-faint"
      aria-hidden
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function RowLine({ row }: { row: ClassifiedAdRow }) {
  const dot =
    row.classification === "winner"
      ? "bg-positive"
      : row.classification === "loser"
        ? "bg-negative"
        : "bg-ink-faint";
  return (
    <div className="surface px-5 py-3.5">
      <div className="flex items-start gap-3">
        <span className="pt-[0.45rem]">
          <span className={`block size-[7px] shrink-0 rounded-full ${dot}`} />
        </span>
        <p className="min-w-0 flex-1 text-[0.9375rem] leading-relaxed">
          <span className="font-semibold text-ink">
            {row.adName || row.adId}
          </span>
          <span className="text-ink-soft"> {row.reason}</span>
        </p>
        <span className="shrink-0 pt-1 tnum text-[0.8125rem] text-ink-soft">
          {row.leads} Leads · {euro(row.cpl)}
        </span>
      </div>
    </div>
  );
}

export function EconomicsView({
  state,
  brandSlug,
}: {
  state: BrandState | null;
  brandSlug: string;
}) {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ranOnce = useRef(false);

  // Campaign toggle is bound defensively: the route comes from the engine
  // stream; a 404/405/501 hides the toggle for the session.
  const [toggleHidden, setToggleHidden] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState<"ACTIVE" | "PAUSED" | null>(
    null,
  );

  const run = useCallback(
    async (mode: "auto" | "live" | "fixture") => {
      setError(null);
      const result: ActionResult = await postAction(
        `/api/brands/${brandSlug}/optimize`,
        { mode },
      ).catch((e: unknown) => ({
        ok: false,
        status: 0,
        body: { error: e instanceof Error ? e.message : "Netzwerkfehler" },
      }));
      if (!result.ok) {
        setError(actionError(result));
        return;
      }
      const runId = result.body.runId;
      if (typeof runId === "string") setPendingRunId(runId);
    },
    [brandSlug],
  );

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    run("auto");
  }, [run]);

  // Resolve the pending run from the polled state prop.
  useEffect(() => {
    if (!pendingRunId) return;
    const pending = state?.runs.find((r) => r.id === pendingRunId);
    if (!pending || !pending.finishedAt) return;
    if (pending.status === "failed") {
      setError(pending.error ?? "Analyse fehlgeschlagen");
    } else if (pending.result) {
      setAnalysis(pending.result as AnalysisResult);
    }
    setPendingRunId(null);
  }, [pendingRunId, state]);

  const loading = pendingRunId !== null;
  const extras = (analysis ?? {}) as AnalysisResult & EconomicsExtras;
  const stateExtras = (state ?? {}) as unknown as {
    economics?: EconomicsExtras;
  };

  const rows = analysis?.rows ?? [];
  const winners = rows.filter((r) => r.classification === "winner");
  const losers = rows.filter((r) => r.classification === "loser");
  const rest = rows.filter((r) => r.classification === "insufficient_data");
  const learnings = state?.learnings ?? [];

  const cpl = analysis?.totals.cpl ?? null;

  // Campaign-level goal from the engine, fallback: brand targetCpa.
  const target =
    stateExtras.economics?.target ??
    extras.target ??
    (state?.brand.targetCpa != null
      ? { metric: "CPL", value: state.brand.targetCpa }
      : undefined);
  const underTarget =
    cpl !== null && target?.value !== undefined && cpl <= target.value;

  const trend = stateExtras.economics?.trend ?? extras.trend;
  const campaignId =
    stateExtras.economics?.campaignId ??
    extras.campaignId ??
    state?.brand.meta.campaignId;
  const campaignName =
    stateExtras.economics?.campaignName ??
    extras.campaignName ??
    (state ? `Kampagne ${state.brand.name}` : "Kampagne");
  const campaignStatus =
    localStatus ??
    stateExtras.economics?.campaignStatus ??
    extras.campaignStatus ??
    "PAUSED";

  const toggleStatus = async () => {
    if (!campaignId) return;
    const next = campaignStatus === "ACTIVE" ? "PAUSED" : "ACTIVE";
    setToggleBusy(true);
    const result = await postAction(`/api/campaigns/${campaignId}/status`, {
      status: next,
    }).catch(() => ({ ok: false, status: 0, body: {} }));
    setToggleBusy(false);
    // Route not there yet -> hide the toggle instead of showing dead UI.
    if ([0, 404, 405, 501].includes(result.status) && !result.ok) {
      setToggleHidden(true);
      return;
    }
    if (result.ok) setLocalStatus(next);
    else setError(actionError(result));
  };

  return (
    <>
      <header className="mb-10 flex items-start justify-between gap-8">
        <div className="min-w-0">
          <h1 className="text-[1.875rem] font-semibold tracking-[-0.025em]">
            Wirtschaftlichkeit
          </h1>
          <p className="mt-2 max-w-[56ch] text-[0.9375rem] leading-relaxed text-ink-soft">
            Was ein Lead gerade kostet, gemessen am Ziel der Kampagne.
          </p>
        </div>
        <div className="shrink-0 pt-1">
          <ActionButton
            tone="quiet"
            label={loading ? "analysiert …" : "Neu analysieren"}
            disabled={loading}
            onClick={() => run("auto")}
          />
        </div>
      </header>

      {error ? (
        <div className="mb-6">
          <ErrorNote text={`Analyse-Fehler: ${error}`} />
        </div>
      ) : null}

      {/* Campaign card: the one strong element of this view. */}
      <Card className="mb-10 px-8 py-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-[1.0625rem] font-semibold tracking-[-0.015em]">
              {campaignName}
            </p>
            <p className="mt-1 text-[0.8125rem] text-ink-faint">
              Ziel: {target?.metric ?? "CPL"} ≤{" "}
              <span className="tnum">
                {target?.value !== undefined ? euro(target.value) : "—"}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {cpl !== null && target?.value !== undefined ? (
              <span
                className={`rounded-full px-3 py-1 text-[0.75rem] font-medium ${
                  underTarget
                    ? "bg-positive/10 text-positive"
                    : "bg-warn/12 text-warn"
                }`}
              >
                {underTarget ? "unter Ziel" : "über Ziel"}
              </span>
            ) : null}
            {analysis?.source === "fixture" ? (
              <span className="rounded-full bg-warn/12 px-3 py-1 text-[0.75rem] font-medium text-warn">
                Demo-Daten
              </span>
            ) : null}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-[0.8125rem] text-ink-soft">Preis pro Lead</p>
            {cpl === null ? (
              <p className="mt-1 text-[1.375rem] font-semibold tracking-[-0.02em] text-ink-soft">
                noch nicht gemessen
              </p>
            ) : (
              <p
                className={`mt-1 text-[3.25rem] font-semibold leading-none tracking-[-0.04em] tnum ${
                  underTarget ? "text-positive" : "text-ink"
                }`}
              >
                {euro(cpl)}
              </p>
            )}
          </div>
          {trend && trend.length >= 2 ? <Sparkline points={trend} /> : null}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-2 text-[0.875rem]">
          <span className="text-ink-soft">
            Ausgegeben{" "}
            <span className="tnum text-ink">
              {euro(analysis?.totals.spend ?? null)}
            </span>
          </span>
          <span className="text-ink-soft">
            Leads{" "}
            <span className="tnum text-ink">
              {analysis ? analysis.totals.leads : "—"}
            </span>
          </span>
          {analysis?.source === "live" && rows.length === 0 ? (
            <span className="text-[0.8125rem] text-ink-faint">
              Live · Konnektivität in Ordnung, noch keine Daten
            </span>
          ) : null}

          {campaignId && !toggleHidden ? (
            <button
              type="button"
              onClick={toggleStatus}
              disabled={toggleBusy}
              className="ml-auto inline-flex h-8 items-center gap-2 rounded-full border border-rule px-3.5 text-[0.8125rem] font-medium text-ink transition-colors hover:bg-sink disabled:opacity-40"
            >
              <span
                className={`size-1.5 rounded-full ${
                  campaignStatus === "ACTIVE" ? "bg-positive" : "bg-ink-faint"
                }`}
              />
              {campaignStatus === "ACTIVE" ? "Aktiv" : "Pausiert"}
              <span className="text-ink-faint">
                · {campaignStatus === "ACTIVE" ? "pausieren" : "aktivieren"}
              </span>
            </button>
          ) : null}
        </div>
        {analysis?.note ? (
          <p className="mt-4 text-[0.8125rem] text-ink-faint">
            {analysis.note}
          </p>
        ) : null}
      </Card>

      <section className="mb-10">
        <GroupHeading
          label="Gewinner und Verlierer"
          count={winners.length + losers.length}
        />
        {rows.length === 0 ? (
          <p className="surface px-5 py-4 text-[0.875rem] leading-relaxed text-ink-soft">
            Keine Ad-Daten. Frisch angelegte pausierte Ads liefern physikalisch
            keine Insights.
          </p>
        ) : (
          <div className="space-y-2">
            {[...winners, ...losers, ...rest].map((row) => (
              <RowLine key={row.adId} row={row} />
            ))}
          </div>
        )}
        {analysis?.recommendation ? (
          <p className="mt-4 px-1 text-[0.9375rem] leading-relaxed text-ink">
            {analysis.recommendation}
          </p>
        ) : null}
      </section>

      <section>
        <GroupHeading label="Gelernt" count={learnings.length} />
        {learnings.length === 0 ? (
          <p className="surface px-5 py-4 text-[0.875rem] leading-relaxed text-ink-soft">
            Noch keine Learnings. Der Analyst schreibt sie nach jedem
            Mining-Lauf.
          </p>
        ) : (
          <div className="space-y-2">
            {learnings.map((l) => (
              <div key={l.id} className="surface px-5 py-4">
                <p className="text-[0.9375rem] leading-relaxed text-ink-soft">
                  {l.pattern}
                </p>
                <p className="mt-2 text-[0.75rem] text-ink-faint">
                  {l.source === "meta_insights"
                    ? "aus Meta-Insights"
                    : "aus menschlicher Prüfung"}
                  {l.appliedToSkill ? ` · wirkt auf ${l.appliedToSkill}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
