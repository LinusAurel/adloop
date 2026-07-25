"use client";

// Board: a real kanban over the five angle statuses from the data model.
// Cards carry name, one-line hypothesis and the expected/measured figures;
// decisions are coloured (approve green filled, kill red outline).

import { useState } from "react";
import type { Angle, AngleStatus, BrandState } from "@/engine/types";
import {
  ActionButton,
  ErrorNote,
  Hero,
  PillButton,
  actionError,
  postAction,
  useSettle,
} from "@/components/bits";
import { euro } from "@/lib/format";

// The five real statuses (engine/types.ts), in pipeline order.
const COLUMNS: { status: AngleStatus; label: string }[] = [
  { status: "draft", label: "Vorschlag" },
  { status: "approved", label: "Freigegeben" },
  { status: "testing", label: "Im Test" },
  { status: "validated", label: "Validiert" },
  { status: "killed", label: "Verworfen" },
];

function AngleCard({
  angle,
  pipelineRunning,
  onChanged,
}: {
  angle: Angle;
  pipelineRunning: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const settling = useSettle(angle.status);

  const fire = async (url: string) => {
    setBusy(true);
    setFailed(null);
    const result = await postAction(url).catch((e: unknown) => ({
      ok: false,
      status: 0,
      body: { error: e instanceof Error ? e.message : "Netzwerkfehler" },
    }));
    setBusy(false);
    if (!result.ok) {
      setFailed(actionError(result));
      return;
    }
    onChanged();
  };

  return (
    <article className={`surface p-4 ${settling ? "settle" : ""}`}>
      <p className="text-[0.9375rem] font-semibold leading-snug tracking-[-0.01em]">
        {angle.name}
      </p>
      <p className="mt-1.5 line-clamp-2 text-[0.8125rem] leading-relaxed text-ink-soft">
        {angle.pain || angle.hookDirection}
      </p>

      {angle.expectedCpl !== undefined || angle.measuredCpl !== undefined ? (
        <p className="mt-3 text-[0.75rem] text-ink-faint">
          erwartet{" "}
          <span className="tnum font-medium text-ink">
            {euro(angle.expectedCpl)}
          </span>
          {angle.measuredCpl !== undefined ? (
            <>
              {" "}
              · gemessen{" "}
              <span className="tnum font-medium text-ink">
                {euro(angle.measuredCpl)}
              </span>
            </>
          ) : null}
        </p>
      ) : null}

      {angle.status === "draft" ? (
        <div className="mt-3.5 flex items-center gap-2">
          <ActionButton
            small
            tone="approve"
            label="Freigeben"
            disabled={busy}
            onClick={() => fire(`/api/angles/${angle.id}/approve`)}
          />
          <ActionButton
            small
            tone="reject"
            label="Verwerfen"
            disabled={busy}
            onClick={() => fire(`/api/angles/${angle.id}/kill`)}
          />
        </div>
      ) : null}

      {angle.status === "approved" ? (
        <div className="mt-3.5">
          <ActionButton
            small
            tone="quiet"
            label={
              busy || pipelineRunning
                ? "Material entsteht …"
                : "Material erzeugen"
            }
            disabled={busy || pipelineRunning}
            onClick={() => fire(`/api/angles/${angle.id}/assets/generate`)}
          />
        </div>
      ) : null}

      {failed ? <ErrorNote text={failed} /> : null}
    </article>
  );
}

export function BoardView({
  state,
  brandSlug,
  strategistRunning,
  runningAssetAngleIds,
  onChanged,
}: {
  state: BrandState | null;
  brandSlug: string;
  strategistRunning: boolean;
  runningAssetAngleIds: Set<string | undefined>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setFailed(null);
    // Route answers 202 immediately (#7); polling shows the progress.
    const result = await postAction(
      `/api/brands/${brandSlug}/angles/generate`,
    ).catch((e: unknown) => ({
      ok: false,
      status: 0,
      body: { error: e instanceof Error ? e.message : "Netzwerkfehler" },
    }));
    setBusy(false);
    if (!result.ok) {
      setFailed(actionError(result));
      return;
    }
    onChanged();
  };

  const angles = state?.angles ?? [];
  const action = (
    <PillButton
      label="Neue Angles generieren"
      busyLabel="Strategist arbeitet …"
      busy={busy || strategistRunning}
      onClick={generate}
    />
  );

  if (angles.length === 0) {
    return (
      <>
        <Hero
          title="Noch keine Angles"
          lead="Der Strategist liest den Markenkontext und schlägt testbare Angles vor, jeder mit seinem erwarteten Preis pro Lead. Freigeben oder verwerfen entscheidest Du."
          action={action}
        />
        {failed ? <ErrorNote text={`Start fehlgeschlagen: ${failed}`} /> : null}
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="mb-8 flex items-start justify-between gap-8">
        <div>
          <h1 className="text-[1.875rem] font-semibold tracking-[-0.025em]">
            Board
          </h1>
          <p className="mt-2 text-[0.9375rem] text-ink-soft">
            Jeder Angle wandert von Vorschlag bis Validiert — oder wird
            verworfen.
          </p>
        </div>
        <div className="shrink-0 pt-1">{action}</div>
      </header>
      {failed ? (
        <div className="mb-4">
          <ErrorNote text={`Start fehlgeschlagen: ${failed}`} />
        </div>
      ) : null}

      <div className="-mx-2 flex min-h-0 flex-1 gap-4 overflow-x-auto px-2 pb-6">
        {COLUMNS.map((col) => {
          const cards = angles.filter((a) => a.status === col.status);
          return (
            <section
              key={col.status}
              className="flex w-[264px] shrink-0 flex-col"
            >
              <p className="group-heading mb-3 px-1">
                {col.label}
                <span className="ml-1.5 tnum text-ink-faint/70">
                  {cards.length}
                </span>
              </p>
              <div className="space-y-2.5">
                {cards.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-rule px-4 py-6 text-center text-[0.8125rem] text-ink-faint">
                    leer
                  </p>
                ) : (
                  cards.map((a) => (
                    <AngleCard
                      key={a.id}
                      angle={a}
                      pipelineRunning={runningAssetAngleIds.has(a.id)}
                      onChanged={onChanged}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
