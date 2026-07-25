"use client";

// Studio: the campaign from A to Z. Master list of angles with assets on the
// left, on the right the feed-style ad preview, the critic verdict and the
// human decisions (approve mint filled, reject red outline, regenerate with
// a curated image-model picker). Publishing creates PAUSED ads only (Hard
// Stop 2).

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AnalysisResult, ClassifiedAdRow } from "@/engine/agents/analyst";
import type { Angle, Asset, BrandState } from "@/engine/types";
import type { CopyVariant } from "@/engine/schemas";
import {
  ActionButton,
  ErrorNote,
  Hero,
  actionError,
  postAction,
  useSettle,
} from "@/components/bits";
import { euro } from "@/lib/format";
import { FAL_MODELS } from "@/lib/fal-models";

// Payload shapes written by the asset pipeline (engine/agents/pipeline.ts).
interface CopyAssetPayload {
  outline?: string;
  variants?: CopyVariant[];
  chosenIndex?: number;
}

interface StaticAssetPayload {
  imageUrl?: string;
}

interface Entry {
  angle: Angle;
  copyAsset?: Asset;
  staticAsset?: Asset;
  // All static versions of the angle, newest first (#16): regenerating
  // appends a new version instead of replacing the image, so earlier
  // visuals stay reviewable as a small history.
  staticHistory: Asset[];
}

const ASSET_STATUS_LABEL: Record<string, string> = {
  draft: "awaiting approval",
  approved: "approved",
  rejected: "rejected",
  published: "published",
};

// Cost label per campaign target metric — mirrors the Economics view so the
// architecture carries different optimization goals (#16).
const METRIC_LABELS: Record<string, string> = {
  CPL: "Cost per lead",
  CPA: "Cost per acquisition",
  CPP: "Cost per purchase",
  CPC: "Cost per click",
  CPE: "Cost per engagement",
};

// Version-aware ordering: explicit version wins, store order (append =
// chronological) breaks ties for rows written before versioning.
function byVersion(assets: Asset[]): Asset[] {
  return assets
    .map((asset, index) => ({ asset, index }))
    .sort(
      (a, b) =>
        (a.asset.version ?? 1) - (b.asset.version ?? 1) || a.index - b.index,
    )
    .map((x) => x.asset);
}

function FeedPreview({
  entry,
  brandName,
}: {
  entry: Entry;
  brandName: string;
}) {
  const payload = (entry.copyAsset?.payload ?? {}) as CopyAssetPayload;
  const variant = payload.variants?.[payload.chosenIndex ?? 0];
  const imageUrl = ((entry.staticAsset?.payload ?? {}) as StaticAssetPayload)
    .imageUrl;

  return (
    <div className="w-[300px] shrink-0 overflow-hidden rounded-2xl bg-ink-750">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-ink-800 text-[0.6875rem] font-semibold text-text-soft">
          {brandName.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-semibold">
            {brandName}
          </span>
          <span className="block text-[0.6875rem] text-text-faint">
            Sponsored
          </span>
        </span>
      </div>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={`Visual for ${entry.angle.name}`}
          className="aspect-[4/5] w-full object-cover"
        />
      ) : (
        <div className="grid aspect-[4/5] place-items-center bg-ink-800 text-[0.8125rem] text-text-faint">
          no visual yet
        </div>
      )}
      <div className="space-y-1.5 px-4 py-3.5">
        <p className="text-[0.9375rem] font-semibold leading-snug">
          {variant?.headline ?? "—"}
        </p>
        <p className="line-clamp-4 whitespace-pre-line text-[0.8125rem] leading-relaxed text-text-soft">
          {variant?.primary ?? ""}
        </p>
        {variant?.cta ? (
          <span className="mt-1 block truncate rounded-lg bg-ink-800 px-3 py-2 text-center text-[0.75rem] font-medium">
            {variant.cta}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// Performance rows from the latest analysis that belong to this entry's
// assets (any version). The ad name carries the asset id, the Analyst
// resolves it into row.assetId; rows whose asset id is not in the local
// store (e.g. seeded insight rows) still match via row.angleId, so the
// winner section never goes missing just because an id drifted.
function performanceRows(
  entry: Entry,
  analysis: AnalysisResult | null,
): ClassifiedAdRow[] {
  if (!analysis) return [];
  const ids = new Set(
    [entry.copyAsset, entry.staticAsset, ...entry.staticHistory]
      .filter((a): a is Asset => Boolean(a))
      .map((a) => a.id),
  );
  return analysis.rows.filter(
    (r) =>
      (r.assetId && ids.has(r.assetId)) ||
      (r.angleId && r.angleId === entry.angle.id),
  );
}

function PerformanceSection({
  rows,
  metric,
}: {
  rows: ClassifiedAdRow[];
  metric: string | undefined;
}) {
  const costLabel =
    (metric ? METRIC_LABELS[metric.toUpperCase()] : undefined) ??
    "Cost per result";
  return (
    <div className="mt-5 rounded-2xl bg-ink-800 p-5">
      <p className="text-[0.8125rem] font-medium text-text-soft">Performance</p>
      <div className="mt-3 space-y-3">
        {rows.map((row) => (
          <div key={row.adId} className="flex flex-wrap items-center gap-x-5 gap-y-1">
            {row.classification === "winner" ? (
              <span className="rounded-lg bg-emerald-600/15 px-2 py-0.5 text-[0.6875rem] font-medium text-emerald-500">
                Winner
              </span>
            ) : row.classification === "loser" ? (
              <span className="rounded-lg bg-signal-red/12 px-2 py-0.5 text-[0.6875rem] font-medium text-signal-red">
                Loser
              </span>
            ) : (
              <span className="rounded-lg bg-ink-750 px-2 py-0.5 text-[0.6875rem] font-medium text-text-faint">
                Testing
              </span>
            )}
            <span className="text-[0.8125rem] text-text-soft">
              Leads <span className="tnum text-foreground">{row.leads}</span>
            </span>
            <span className="text-[0.8125rem] text-text-soft">
              {costLabel}{" "}
              <span className="tnum text-foreground">{euro(row.cpl)}</span>
            </span>
            <span className="text-[0.8125rem] text-text-soft">
              Spend{" "}
              <span className="tnum text-foreground">{euro(row.spend)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Detail({
  entry,
  brandSlug,
  brandName,
  analysis,
  pipelineRunning,
  publishRunning,
  onChanged,
}: {
  entry: Entry;
  brandSlug: string;
  brandName: string;
  analysis: AnalysisResult | null;
  pipelineRunning: boolean;
  publishRunning: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [model, setModel] = useState(FAL_MODELS[0].id);

  const status =
    entry.copyAsset?.status ?? entry.staticAsset?.status ?? "draft";
  const settling = useSettle(status);
  const critic = entry.copyAsset;
  const perfRows = performanceRows(entry, analysis);

  const fire = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setFailed(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "unknown error");
    } finally {
      setBusy(null);
    }
  };

  const decide = (action: "approve" | "reject") =>
    fire(action, async () => {
      for (const asset of [entry.copyAsset, entry.staticAsset]) {
        if (!asset) continue;
        const result = await postAction(`/api/assets/${asset.id}/${action}`);
        if (!result.ok) throw new Error(actionError(result));
      }
    });

  // Regenerate = run the asset pipeline again for this angle; the selected
  // model travels along (route accepts it once the engine side landed —
  // sending it earlier is harmless).
  const regenerate = () =>
    fire("regenerate", async () => {
      const result = await postAction(
        `/api/angles/${entry.angle.id}/assets/generate`,
        { model },
      );
      if (!result.ok) throw new Error(actionError(result));
    });

  const publish = () =>
    fire("publish", async () => {
      const result = await postAction(`/api/brands/${brandSlug}/publish`);
      if (!result.ok) {
        const hint = result.body.hint;
        throw new Error(typeof hint === "string" ? hint : actionError(result));
      }
    });

  const bothApproved =
    entry.copyAsset?.status === "approved" &&
    entry.staticAsset?.status === "approved";

  return (
    <div className={settling ? "settle rounded-3xl" : ""}>
      <div className="flex flex-wrap gap-8">
        <FeedPreview entry={entry} brandName={brandName} />

        <div className="min-w-[280px] flex-1">
          <h2 className="text-[1.25rem] font-semibold tracking-[-0.02em]">
            {entry.angle.name}
          </h2>
          <p className="mt-1.5 text-[0.875rem] leading-relaxed text-text-soft">
            {entry.angle.hookDirection}
          </p>

          <p className="mt-4 text-[0.8125rem] text-text-faint">
            Status: {ASSET_STATUS_LABEL[status] ?? status}
          </p>

          {/* Critic verdict with reasoning. */}
          <div className="mt-5 rounded-2xl bg-ink-800 p-5">
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-[0.8125rem] font-medium text-text-soft">
                Critic score
              </p>
              <p className="tnum text-[1.5rem] font-semibold tracking-[-0.02em]">
                {critic?.criticScore ?? "—"}
              </p>
            </div>
            <p className="mt-2 text-[0.875rem] leading-relaxed text-text-soft">
              {critic?.criticNotes ?? "No reasoning yet."}
            </p>
          </div>

          {/* What this asset earned in the live campaign (#16); only shown
              when the analysis actually contains it. */}
          {perfRows.length > 0 ? (
            <PerformanceSection
              rows={perfRows}
              metric={analysis?.target?.metric}
            />
          ) : null}

          {status === "draft" ? (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <ActionButton
                tone="approve"
                label="Approve"
                disabled={busy !== null}
                onClick={() => decide("approve")}
              />
              <ActionButton
                tone="reject"
                label="Reject"
                disabled={busy !== null}
                onClick={() => decide("reject")}
              />
            </div>
          ) : null}

          {bothApproved ? (
            <div className="mt-5">
              <ActionButton
                tone="quiet"
                label={
                  busy === "publish" || publishRunning
                    ? "Publisher working…"
                    : "Create as paused ad"
                }
                disabled={busy !== null || publishRunning}
                onClick={publish}
              />
              <p className="mt-2 text-[0.75rem] leading-relaxed text-text-faint">
                Ads are always created paused; a human activates them in Ads
                Manager.
              </p>
            </div>
          ) : null}

          {/* Regenerate with curated image models. */}
          <div className="mt-6 border-t border-rule pt-5">
            <p className="group-heading mb-2.5">Image model</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="relative inline-flex">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  aria-label="Choose image model"
                  className="h-9 appearance-none rounded-xl bg-ink-750 pl-4 pr-9 text-[0.8125rem] font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-rule-2"
                >
                  {FAL_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.hint}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-text-faint"
                  strokeWidth={1.75}
                />
              </span>
              <ActionButton
                tone="quiet"
                label={
                  busy === "regenerate" || pipelineRunning
                    ? "Generating assets…"
                    : "Regenerate"
                }
                disabled={busy !== null || pipelineRunning}
                onClick={regenerate}
              />
            </div>
            <p className="mt-2 text-[0.75rem] leading-relaxed text-text-faint">
              Regenerating creates a new version; earlier versions are kept
              below.
            </p>
          </div>

          {/* Version history (#16): every regenerate appends a new static
              version, nothing gets overwritten. Newest first. */}
          {entry.staticHistory.length > 1 ? (
            <div className="mt-6 border-t border-rule pt-5">
              <p className="group-heading mb-2.5">
                Versions ({entry.staticHistory.length})
              </p>
              <div className="flex flex-wrap gap-3">
                {entry.staticHistory.map((asset, i) => {
                  const url = ((asset.payload ?? {}) as StaticAssetPayload)
                    .imageUrl;
                  const version =
                    asset.version ?? entry.staticHistory.length - i;
                  const current = i === 0;
                  return (
                    <figure key={asset.id} className="w-[92px]">
                      {url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={url}
                          alt={`Version ${version} for ${entry.angle.name}`}
                          className={`aspect-[4/5] w-full rounded-xl object-cover ${
                            current
                              ? "ring-1 ring-rule-2"
                              : "opacity-60"
                          }`}
                        />
                      ) : (
                        <span className="grid aspect-[4/5] w-full place-items-center rounded-xl bg-ink-800 text-[0.6875rem] text-text-faint">
                          no visual
                        </span>
                      )}
                      <figcaption className="mt-1.5 text-[0.6875rem] text-text-faint">
                        V{version}
                        {current ? " · current" : ""}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </div>
          ) : null}

          {failed ? <ErrorNote text={failed} /> : null}
        </div>
      </div>
    </div>
  );
}

export function StudioView({
  state,
  brandSlug,
  runningAssetAngleIds,
  publishRunning,
  onChanged,
  focusAngleId,
}: {
  state: BrandState | null;
  brandSlug: string;
  runningAssetAngleIds: Set<string | undefined>;
  publishRunning: boolean;
  onChanged: () => void;
  // Optional deep-link (additive, #16): app shell sets this when an
  // adloop:open-asset event asks the Studio to focus a specific angle.
  focusAngleId?: string | null;
}) {
  const brandName = state?.brand.name ?? brandSlug;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (focusAngleId) setSelectedId(focusAngleId);
  }, [focusAngleId]);

  // One entry per angle that has assets. Latest version per kind is shown;
  // earlier static versions stay available as history (#16).
  const entries = useMemo<Entry[]>(
    () =>
      (state?.angles ?? [])
        .map((angle) => {
          const assets = (state?.assets ?? []).filter(
            (a) => a.angleId === angle.id,
          );
          const statics = byVersion(assets.filter((a) => a.kind === "static"));
          const copies = byVersion(assets.filter((a) => a.kind === "ad_copy"));
          return {
            angle,
            copyAsset: copies.at(-1),
            staticAsset: statics.at(-1),
            staticHistory: [...statics].reverse(),
          };
        })
        .filter((p) => p.copyAsset || p.staticAsset),
    [state],
  );

  const selected = entries.find((e) => e.angle.id === selectedId) ?? entries[0];

  // Latest finished analysis (Economics run) — wires results to assets (#16).
  const analysis = useMemo<AnalysisResult | null>(() => {
    const run = (state?.runs ?? []).findLast(
      (r) => r.stage === "optimize" && r.finishedAt && r.result,
    );
    return run ? (run.result as AnalysisResult) : null;
  }, [state]);

  // Deep link from other views (e.g. Economics winner/loser rows): a
  // CustomEvent "adloop:open-asset" with {assetId} selects the angle that
  // owns the asset. Defensive: unknown ids are ignored.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const assetId = (event as CustomEvent<{ assetId?: string }>).detail
        ?.assetId;
      if (!assetId) return;
      const owner = (state?.assets ?? []).find((a) => a.id === assetId);
      if (owner) setSelectedId(owner.angleId);
    };
    window.addEventListener("adloop:open-asset", onOpen);
    return () => window.removeEventListener("adloop:open-asset", onOpen);
  }, [state]);

  if (entries.length === 0) {
    return (
      <Hero
        title="No assets yet"
        lead="Approve an angle on the board and generate assets — visual and copy appear here as a feed preview, the way they would run."
      />
    );
  }

  return (
    <>
      <header className="mb-8">
        <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em]">
          Studio
        </h1>
        <p className="mt-2 text-[0.9375rem] text-text-soft">
          Visual and copy as a pair, scored by the critic, approved by you.
        </p>
      </header>

      <div className="flex gap-8">
        {/* Master list */}
        <nav className="w-[236px] shrink-0 space-y-1">
          {entries.map((entry) => {
            const active = entry.angle.id === selected?.angle.id;
            const status =
              entry.copyAsset?.status ?? entry.staticAsset?.status ?? "draft";
            return (
              <button
                key={entry.angle.id}
                type="button"
                onClick={() => setSelectedId(entry.angle.id)}
                className={`w-full rounded-xl px-3.5 py-3 text-left transition-colors ${
                  active ? "bg-ink-800" : "hover:bg-ink-850"
                }`}
              >
                <span className="block truncate text-[0.875rem] font-medium text-foreground">
                  {entry.angle.name}
                </span>
                <span className="mt-0.5 block text-[0.75rem] text-text-faint">
                  {ASSET_STATUS_LABEL[status] ?? status}
                  {entry.copyAsset?.criticScore !== undefined
                    ? ` · critic ${entry.copyAsset.criticScore}`
                    : ""}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Detail */}
        <div className="min-w-0 flex-1">
          {selected ? (
            <Detail
              key={selected.angle.id}
              entry={selected}
              brandSlug={brandSlug}
              brandName={brandName}
              analysis={analysis}
              pipelineRunning={runningAssetAngleIds.has(selected.angle.id)}
              publishRunning={publishRunning}
              onChanged={onChanged}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
