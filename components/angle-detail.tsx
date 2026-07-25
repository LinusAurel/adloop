"use client";

// Angle detail drawer: the full angle behind a board card — hypothesis,
// taxonomy, expected vs measured CPL (with the provenance line), linked
// assets and, if the analyst has run, the measured results per ad.
// Cross-navigation happens via CustomEvents on window:
//   adloop:open-asset {detail:{assetId}} → app shell opens the Studio.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Angle, Asset, BrandState, Run } from "@/engine/types";
import { ActionButton, ErrorNote, actionError, postAction } from "@/components/bits";
import { euro } from "@/lib/format";

// Muted approve/primary action (founder feedback: neon mint is too loud on
// the board). Local to board/detail — global tokens stay untouched.
export function EmeraldButton({
  label,
  busyLabel,
  busy,
  disabled,
  onClick,
  pill,
}: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  pill?: boolean;
}) {
  const size = pill
    ? "h-11 rounded-2xl px-6 text-[0.9375rem]"
    : "h-8 rounded-xl px-3.5 text-[0.8125rem]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className={`inline-flex shrink-0 items-center bg-emerald-600 font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-45 ${size}`}
    >
      {busy ? <span className="animate-pulse">{busyLabel ?? label}</span> : label}
    </button>
  );
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Proposed",
  approved: "Approved",
  testing: "Testing",
  validated: "Validated",
  killed: "Discarded",
};

const ASSET_KIND_LABEL: Record<string, string> = {
  ad_copy: "Ad copy",
  static: "Visual",
  lp: "Landing page",
};

interface StaticPayload {
  imageUrl?: string;
}

// Shape of the analyst rows inside run.result (engine/agents/analyst.ts);
// typed locally so the drawer stays decoupled from the engine module.
interface AnalysisRow {
  adName?: string;
  angleId?: string;
  assetId?: string;
  spend?: number;
  leads?: number;
  cpl?: number | null;
  classification?: string;
  reason?: string;
}

function analysisRowsFor(runs: Run[], angleId: string): AnalysisRow[] {
  const latest = [...runs]
    .filter((r) => r.stage === "optimize" && r.result)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const rows = (latest?.result as { rows?: AnalysisRow[] } | undefined)?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row.angleId === angleId);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-text-faint">
      {children}
    </p>
  );
}

function AssetRow({ asset }: { asset: Asset }) {
  const imageUrl =
    asset.kind === "static"
      ? ((asset.payload ?? {}) as StaticPayload).imageUrl
      : undefined;
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("adloop:open-asset", {
            detail: { assetId: asset.id },
          }),
        )
      }
      className="flex w-full items-center gap-3 rounded-xl bg-ink-750 px-3 py-2.5 text-left transition-colors hover:bg-rule"
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          className="size-10 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-ink-800 text-[0.6875rem] font-semibold text-text-faint">
          Aa
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-medium text-foreground">
          {ASSET_KIND_LABEL[asset.kind] ?? asset.kind}
        </span>
        <span className="block text-[0.75rem] text-text-faint">
          {asset.status}
          {asset.criticScore !== undefined ? ` · critic ${asset.criticScore}` : ""}
        </span>
      </span>
      <span className="shrink-0 text-[0.6875rem] uppercase tracking-wide text-text-faint/70">
        Open
      </span>
    </button>
  );
}

export function AngleDetail({
  angleId,
  state,
  pipelineRunning,
  onClose,
  onChanged,
}: {
  angleId: string;
  state: BrandState | null;
  pipelineRunning: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // Esc closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const angle: Angle | undefined = state?.angles.find((a) => a.id === angleId);
  if (!angle) return null;

  const assets = (state?.assets ?? []).filter((a) => a.angleId === angle.id);
  const results = analysisRowsFor(state?.runs ?? [], angle.id);

  const fire = async (url: string) => {
    setBusy(true);
    setFailed(null);
    const result = await postAction(url).catch((e: unknown) => ({
      ok: false,
      status: 0,
      body: { error: e instanceof Error ? e.message : "network error" },
    }));
    setBusy(false);
    if (!result.ok) {
      setFailed(actionError(result));
      return;
    }
    onChanged();
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="flex h-full w-full max-w-[480px] flex-col overflow-y-auto bg-ink-850 px-7 py-6 shadow-2xl">
        <header className="flex items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-ink-750 px-2.5 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wide text-text-soft">
                {STATUS_LABEL[angle.status] ?? angle.status}
              </span>
              {angle.category ? (
                <span className="rounded-full bg-ink-750 px-2.5 py-0.5 text-[0.6875rem] font-medium text-text-soft">
                  {angle.category}
                </span>
              ) : null}
              {angle.awarenessStage ? (
                <span className="rounded-full bg-ink-750 px-2.5 py-0.5 text-[0.6875rem] font-medium text-text-soft">
                  {angle.awarenessStage}
                </span>
              ) : null}
            </div>
            <h2 className="mt-3 text-[1.25rem] font-semibold leading-snug tracking-[-0.02em]">
              {angle.name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-text-faint transition-colors hover:bg-ink-750 hover:text-foreground"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </header>

        <div className="mt-6 space-y-6">
          <div>
            <SectionLabel>Hypothesis</SectionLabel>
            <p className="mt-1.5 text-[0.875rem] leading-relaxed text-foreground">
              {angle.hypothesis ?? angle.pain}
            </p>
            {angle.hypothesis && angle.pain ? (
              <p className="mt-2 text-[0.8125rem] leading-relaxed text-text-soft">
                {angle.pain}
              </p>
            ) : null}
          </div>

          {angle.mechanism ? (
            <div>
              <SectionLabel>Mechanism</SectionLabel>
              <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-text-soft">
                {angle.mechanism}
              </p>
            </div>
          ) : null}

          {angle.hookDirection ? (
            <div>
              <SectionLabel>Hook direction</SectionLabel>
              <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-text-soft">
                {angle.hookDirection}
              </p>
            </div>
          ) : null}

          <div>
            <SectionLabel>Segment</SectionLabel>
            <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-text-soft">
              {angle.segment}
            </p>
          </div>

          {angle.expectedCpl !== undefined || angle.measuredCpl !== undefined ? (
            <div>
              <SectionLabel>Cost per lead</SectionLabel>
              <p className="mt-1.5 text-[0.875rem]">
                expected{" "}
                <span className="tnum font-semibold">
                  {euro(angle.expectedCpl)}
                </span>
                {angle.measuredCpl !== undefined ? (
                  <>
                    {" "}
                    · measured{" "}
                    <span className="tnum font-semibold">
                      {euro(angle.measuredCpl)}
                    </span>
                  </>
                ) : null}
              </p>
              <p className="mt-1 text-[0.75rem] leading-relaxed text-text-faint">
                Strategist estimate from research — validated against measured
                CPL once the ad runs.
              </p>
            </div>
          ) : null}

          {angle.rationale ? (
            <div>
              <SectionLabel>Why this angle</SectionLabel>
              <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-text-soft">
                {angle.rationale}
              </p>
            </div>
          ) : null}

          <div>
            <SectionLabel>Assets</SectionLabel>
            {assets.length === 0 ? (
              <p className="mt-1.5 rounded-xl border border-dashed border-rule px-3 py-4 text-center text-[0.8125rem] text-text-faint">
                No assets yet
              </p>
            ) : (
              <div className="mt-2 space-y-1.5">
                {assets.map((a) => (
                  <AssetRow key={a.id} asset={a} />
                ))}
              </div>
            )}
          </div>

          {results.length > 0 ? (
            <div>
              <SectionLabel>Measured results</SectionLabel>
              <div className="mt-2 space-y-1.5">
                {results.map((row) => (
                  <div
                    key={row.adName ?? row.assetId}
                    className="rounded-xl bg-ink-750 px-3 py-2.5"
                  >
                    <p className="flex items-baseline justify-between gap-3 text-[0.8125rem]">
                      <span
                        className={`font-semibold ${
                          row.classification === "winner"
                            ? "text-emerald-500"
                            : row.classification === "loser"
                              ? "text-signal-red"
                              : "text-text-soft"
                        }`}
                      >
                        {row.classification === "winner"
                          ? "Winner"
                          : row.classification === "loser"
                            ? "Loser"
                            : "Not enough data"}
                      </span>
                      <span className="tnum text-text-soft">
                        {row.leads ?? 0} leads · {euro(row.cpl ?? undefined)} CPL
                        {row.spend !== undefined
                          ? ` · ${euro(row.spend)} spend`
                          : ""}
                      </span>
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <footer className="mt-8 border-t border-rule pt-5">
          <div className="flex items-center gap-2">
            {angle.status === "draft" ? (
              <>
                <EmeraldButton
                  label="Approve"
                  busy={busy}
                  onClick={() => fire(`/api/angles/${angle.id}/approve`)}
                />
                <ActionButton
                  small
                  tone="reject"
                  label="Discard"
                  disabled={busy}
                  onClick={() => fire(`/api/angles/${angle.id}/kill`)}
                />
              </>
            ) : null}
            {angle.status === "approved" ? (
              <EmeraldButton
                label={
                  busy || pipelineRunning ? "Generating assets…" : "Generate assets"
                }
                busy={busy || pipelineRunning}
                busyLabel="Generating assets…"
                onClick={() => fire(`/api/angles/${angle.id}/assets/generate`)}
              />
            ) : null}
            {angle.status !== "draft" && angle.status !== "approved" ? (
              <p className="text-[0.8125rem] text-text-faint">
                No actions in this stage.
              </p>
            ) : null}
          </div>
          {failed ? (
            <div className="mt-3">
              <ErrorNote text={failed} />
            </div>
          ) : null}
        </footer>
      </aside>
    </div>
  );
}
