"use client";

// Studio: the campaign from A to Z. Master list of angles with material on
// the left, on the right the feed-style ad preview, the critic verdict and
// the human decisions (approve green, reject red, regenerate with a curated
// image-model picker). Publishing creates PAUSED ads only (Hard Stop 2).

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
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
}

const ASSET_STATUS_LABEL: Record<string, string> = {
  draft: "wartet auf Freigabe",
  approved: "freigegeben",
  rejected: "abgelehnt",
  published: "veröffentlicht",
};

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
    <div className="w-[300px] shrink-0 overflow-hidden rounded-2xl border border-rule bg-card">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sink text-[0.6875rem] font-semibold text-ink">
          {brandName.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-semibold">
            {brandName}
          </span>
          <span className="block text-[0.6875rem] text-ink-faint">
            Gesponsert
          </span>
        </span>
      </div>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={`Motiv für ${entry.angle.name}`}
          className="aspect-[4/5] w-full object-cover"
        />
      ) : (
        <div className="grid aspect-[4/5] place-items-center bg-sink text-[0.8125rem] text-ink-faint">
          noch kein Motiv
        </div>
      )}
      <div className="space-y-1.5 px-4 py-3.5">
        <p className="text-[0.9375rem] font-semibold leading-snug">
          {variant?.headline ?? "—"}
        </p>
        <p className="line-clamp-4 whitespace-pre-line text-[0.8125rem] leading-relaxed text-ink-soft">
          {variant?.primary ?? ""}
        </p>
        {variant?.cta ? (
          <span className="mt-1 block truncate rounded-lg bg-sink px-3 py-2 text-center text-[0.75rem] font-medium">
            {variant.cta}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Detail({
  entry,
  brandSlug,
  brandName,
  pipelineRunning,
  publishRunning,
  onChanged,
}: {
  entry: Entry;
  brandSlug: string;
  brandName: string;
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

  const fire = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setFailed(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "unbekannter Fehler");
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
        throw new Error(
          typeof hint === "string" ? hint : actionError(result),
        );
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
          <p className="mt-1.5 text-[0.875rem] leading-relaxed text-ink-soft">
            {entry.angle.hookDirection}
          </p>

          <p className="mt-4 text-[0.8125rem] text-ink-faint">
            Status: {ASSET_STATUS_LABEL[status] ?? status}
          </p>

          {/* Critic verdict with reasoning. */}
          <div className="surface mt-5 p-5">
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-[0.8125rem] font-medium text-ink-soft">
                Critic-Bewertung
              </p>
              <p className="tnum text-[1.5rem] font-semibold tracking-[-0.02em]">
                {critic?.criticScore ?? "—"}
                <span className="text-[0.875rem] font-normal text-ink-faint">
                  {" "}
                  / 100
                </span>
              </p>
            </div>
            <p className="mt-2 text-[0.875rem] leading-relaxed text-ink-soft">
              {critic?.criticNotes ?? "Noch keine Begründung vorhanden."}
            </p>
          </div>

          {status === "draft" ? (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <ActionButton
                tone="approve"
                label="Freigeben"
                disabled={busy !== null}
                onClick={() => decide("approve")}
              />
              <ActionButton
                tone="reject"
                label="Ablehnen"
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
                    ? "Publisher arbeitet …"
                    : "Als pausierte Ad anlegen"
                }
                disabled={busy !== null || publishRunning}
                onClick={publish}
              />
              <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-faint">
                Ads entstehen immer pausiert; aktiviert wird von Hand im Ads
                Manager.
              </p>
            </div>
          ) : null}

          {/* Regenerate with curated image models. */}
          <div className="mt-6 border-t border-rule pt-5">
            <p className="group-heading mb-2.5">Bild-Modell</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="relative inline-flex">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  aria-label="Bild-Modell wählen"
                  className="h-9 appearance-none rounded-full border border-rule bg-card pl-4 pr-9 text-[0.8125rem] font-medium text-ink focus:outline-none focus:ring-1 focus:ring-ink/30"
                >
                  {FAL_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.hint}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint"
                  strokeWidth={1.75}
                />
              </span>
              <ActionButton
                tone="quiet"
                label={
                  busy === "regenerate" || pipelineRunning
                    ? "Material entsteht …"
                    : "Neu generieren"
                }
                disabled={busy !== null || pipelineRunning}
                onClick={regenerate}
              />
            </div>
          </div>

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
}: {
  state: BrandState | null;
  brandSlug: string;
  runningAssetAngleIds: Set<string | undefined>;
  publishRunning: boolean;
  onChanged: () => void;
}) {
  const brandName = state?.brand.name ?? brandSlug;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // One entry per angle that has material.
  const entries = useMemo<Entry[]>(
    () =>
      (state?.angles ?? [])
        .map((angle) => {
          const assets = (state?.assets ?? []).filter(
            (a) => a.angleId === angle.id,
          );
          return {
            angle,
            copyAsset: assets.findLast((a) => a.kind === "ad_copy"),
            staticAsset: assets.findLast((a) => a.kind === "static"),
          };
        })
        .filter((p) => p.copyAsset || p.staticAsset),
    [state],
  );

  const selected =
    entries.find((e) => e.angle.id === selectedId) ?? entries[0];

  if (entries.length === 0) {
    return (
      <Hero
        title="Noch kein Material"
        lead="Sobald Du im Board einen Angle freigibst und Material erzeugen lässt, stehen Motiv und Copy hier als Ad-Vorschau — so, wie sie im Feed erscheinen."
      />
    );
  }

  return (
    <>
      <header className="mb-8">
        <h1 className="text-[1.875rem] font-semibold tracking-[-0.025em]">
          Studio
        </h1>
        <p className="mt-2 text-[0.9375rem] text-ink-soft">
          Motiv und Copy als Paar, vom Critic bewertet, von Dir freigegeben.
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
                  active ? "bg-sink" : "hover:bg-sink/50"
                }`}
              >
                <span className="block truncate text-[0.875rem] font-medium text-ink">
                  {entry.angle.name}
                </span>
                <span className="mt-0.5 block text-[0.75rem] text-ink-faint">
                  {ASSET_STATUS_LABEL[status] ?? status}
                  {entry.copyAsset?.criticScore !== undefined
                    ? ` · Critic ${entry.copyAsset.criticScore}`
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
