"use client";

// Economics: one campaign card on top (goal on campaign level, measured value
// large, trend, status badge), winners/losers as compact rows, learnings
// below. Fixture results stay labelled "Demo data" (SPEC §3). Job pattern
// (#7): POST /optimize answers 202 + runId, the result arrives as run.result
// via the existing 5s /state polling.

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
      className="h-8 w-[120px] text-text-faint"
      aria-hidden
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function RowLine({ row }: { row: ClassifiedAdRow }) {
  const dot =
    row.classification === "winner"
      ? "bg-mint"
      : row.classification === "loser"
        ? "bg-signal-red"
        : "bg-text-faint";
  return (
    <div className="rounded-2xl bg-ink-800 px-5 py-3.5">
      <div className="flex items-start gap-3">
        <span className="pt-[0.45rem]">
          <span className={`block size-[7px] shrink-0 rounded-full ${dot}`} />
        </span>
        <p className="min-w-0 flex-1 text-[0.9375rem] leading-relaxed">
          <span className="font-semibold text-foreground">
            {row.adName || row.adId}
          </span>
          <span className="text-text-soft"> {row.reason}</span>
        </p>
        <span className="shrink-0 pt-1 tnum text-[0.8125rem] text-text-soft">
          {row.leads} leads · {euro(row.cpl)}
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
        body: { error: e instanceof Error ? e.message : "network error" },
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
      setError(pending.error ?? "analysis failed");
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
    (state ? `${state.brand.name} campaign` : "Campaign");
  const campaignStatus =
    localStatus ??
    stateExtras.economics?.campaignStatus ??
    extras.campaignStatus ??
    "PAUSED";

  const toggleStatus = async () => {
    if (!campaignId) return;
    const next = campaignStatus === "ACTIVE" ? "PAUSED" : "ACTIVE";
    setToggleBusy(true);
    const result: ActionResult = await postAction(
      `/api/campaigns/${campaignId}/status`,
      { status: next },
    ).catch(() => ({ ok: false, status: 0, body: {} }));
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
          <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em]">
            Economics
          </h1>
          <p className="mt-2 max-w-[52ch] text-[0.9375rem] leading-relaxed text-text-soft">
            What a lead currently costs, measured against the campaign goal.
          </p>
        </div>
        <div className="shrink-0 pt-1">
          <ActionButton
            tone="quiet"
            label={loading ? "analyzing…" : "Re-analyze"}
            disabled={loading}
            onClick={() => run("auto")}
          />
        </div>
      </header>

      {error ? (
        <div className="mb-6">
          <ErrorNote text={`Analysis failed: ${error}`} />
        </div>
      ) : null}

      {/* Campaign card: the one strong element of this view. */}
      <Card className="mb-10 rounded-3xl px-8 py-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-[1.0625rem] font-semibold tracking-[-0.015em]">
              {campaignName}
            </p>
            <p className="mt-1 text-[0.8125rem] text-text-faint">
              Goal: {target?.metric ?? "CPL"} ≤{" "}
              <span className="tnum">
                {target?.value !== undefined ? euro(target.value) : "—"}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {cpl !== null && target?.value !== undefined ? (
              <span
                className={`rounded-lg px-2.5 py-1 text-[0.75rem] font-medium ${
                  underTarget
                    ? "bg-mint/10 text-mint"
                    : "bg-signal-amber/12 text-signal-amber"
                }`}
              >
                {underTarget ? "on target" : "above target"}
              </span>
            ) : null}
            {analysis?.source === "fixture" ? (
              <span className="rounded-lg bg-signal-amber/12 px-2.5 py-1 text-[0.75rem] font-medium text-signal-amber">
                Demo data
              </span>
            ) : null}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-[0.8125rem] text-text-soft">Cost per lead</p>
            {cpl === null ? (
              <p className="mt-1 text-[1.5rem] font-semibold tracking-[-0.03em] text-text-soft">
                not measured yet
              </p>
            ) : (
              <p
                className={`mt-1 text-[3.5rem] font-semibold leading-none tracking-[-0.04em] tnum ${
                  underTarget ? "text-mint" : "text-foreground"
                }`}
              >
                {euro(cpl)}
              </p>
            )}
          </div>
          {trend && trend.length >= 2 ? <Sparkline points={trend} /> : null}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-2 text-[0.875rem]">
          <span className="text-text-soft">
            Spent{" "}
            <span className="tnum text-foreground">
              {euro(analysis?.totals.spend ?? null)}
            </span>
          </span>
          <span className="text-text-soft">
            Leads{" "}
            <span className="tnum text-foreground">
              {analysis ? analysis.totals.leads : "—"}
            </span>
          </span>
          {analysis?.source === "live" && rows.length === 0 ? (
            <span className="text-[0.8125rem] text-text-faint">
              Live · connectivity fine, no data yet
            </span>
          ) : null}

          {campaignId && !toggleHidden ? (
            <button
              type="button"
              onClick={toggleStatus}
              disabled={toggleBusy}
              className="ml-auto inline-flex h-8 items-center gap-2 rounded-xl bg-ink-750 px-3.5 text-[0.8125rem] font-medium text-foreground transition-colors hover:bg-rule disabled:opacity-40"
            >
              <span
                className={`size-1.5 rounded-full ${
                  campaignStatus === "ACTIVE" ? "bg-mint" : "bg-text-faint"
                }`}
              />
              {campaignStatus === "ACTIVE" ? "Active" : "Paused"}
              <span className="text-text-faint">
                · {campaignStatus === "ACTIVE" ? "pause" : "activate"}
              </span>
            </button>
          ) : null}
        </div>
        {analysis?.note ? (
          <p className="mt-4 text-[0.8125rem] text-text-faint">
            {analysis.note}
          </p>
        ) : null}
      </Card>

      <section className="mb-10">
        <GroupHeading
          label="Winners and losers"
          count={winners.length + losers.length}
        />
        {rows.length === 0 ? (
          <p className="rounded-2xl bg-ink-800 px-5 py-4 text-[0.875rem] leading-relaxed text-text-soft">
            No ad data. Freshly created paused ads physically deliver no
            insights.
          </p>
        ) : (
          <div className="space-y-2">
            {[...winners, ...losers, ...rest].map((row) => (
              <RowLine key={row.adId} row={row} />
            ))}
          </div>
        )}
        {analysis?.recommendation ? (
          <p className="mt-4 px-1 text-[0.9375rem] leading-relaxed text-foreground">
            {analysis.recommendation}
          </p>
        ) : null}
      </section>

      <section>
        <GroupHeading label="Learnings" count={learnings.length} />
        {learnings.length === 0 ? (
          <p className="rounded-2xl bg-ink-800 px-5 py-4 text-[0.875rem] leading-relaxed text-text-soft">
            No learnings yet. The analyst writes them after every mining run.
          </p>
        ) : (
          <div className="space-y-2">
            {learnings.map((l) => (
              <div key={l.id} className="rounded-2xl bg-ink-800 px-5 py-4">
                <p className="text-[0.9375rem] leading-relaxed text-text-soft">
                  {l.pattern}
                </p>
                <p className="mt-2 text-[0.75rem] text-text-faint">
                  {l.source === "meta_insights"
                    ? "from Meta insights"
                    : "from human review"}
                  {l.appliedToSkill ? ` · applies to ${l.appliedToSkill}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
