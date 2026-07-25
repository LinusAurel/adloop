"use client";

// Board: a real kanban over the five angle statuses from the data model.
// Cards carry name, one-line hypothesis and the expected/measured figures;
// decisions are coloured (approve mint filled, discard red outline).

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
  { status: "draft", label: "Proposed" },
  { status: "approved", label: "Approved" },
  { status: "testing", label: "Testing" },
  { status: "validated", label: "Validated" },
  { status: "killed", label: "Discarded" },
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
    <article
      className={`rounded-2xl bg-ink-800 p-4 ${settling ? "settle" : ""}`}
    >
      <p className="text-[0.9375rem] font-semibold leading-snug tracking-[-0.01em]">
        {angle.name}
      </p>
      <p className="mt-1.5 line-clamp-2 text-[0.8125rem] leading-relaxed text-text-soft">
        {angle.pain || angle.hookDirection}
      </p>

      {angle.expectedCpl !== undefined || angle.measuredCpl !== undefined ? (
        <p className="mt-3 text-[0.75rem] text-text-faint">
          expected{" "}
          <span className="tnum font-medium text-foreground">
            {euro(angle.expectedCpl)}
          </span>
          {angle.measuredCpl !== undefined ? (
            <>
              {" "}
              · measured{" "}
              <span className="tnum font-medium text-foreground">
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
            label="Approve"
            disabled={busy}
            onClick={() => fire(`/api/angles/${angle.id}/approve`)}
          />
          <ActionButton
            small
            tone="reject"
            label="Discard"
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
              busy || pipelineRunning ? "Generating assets…" : "Generate assets"
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
      body: { error: e instanceof Error ? e.message : "network error" },
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
      label="Generate new angles"
      busyLabel="Strategist working…"
      busy={busy || strategistRunning}
      onClick={generate}
    />
  );

  if (angles.length === 0) {
    return (
      <>
        <Hero
          title="No angles yet"
          lead="The strategist reads the brand context and proposes testable angles, each with its expected cost per lead. Approving or discarding stays your call."
          action={action}
        />
        {failed ? <ErrorNote text={`Could not start: ${failed}`} /> : null}
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="mb-8 flex items-start justify-between gap-8">
        <div>
          <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em]">
            Board
          </h1>
          <p className="mt-2 text-[0.9375rem] text-text-soft">
            Every angle moves from proposed to validated, or gets discarded.
          </p>
        </div>
        <div className="shrink-0 pt-1">{action}</div>
      </header>
      {failed ? (
        <div className="mb-4">
          <ErrorNote text={`Could not start: ${failed}`} />
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
                <span className="ml-1.5 tnum text-text-faint/70">
                  {cards.length}
                </span>
              </p>
              <div className="space-y-2.5">
                {cards.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-rule px-4 py-6 text-center text-[0.8125rem] text-text-faint">
                    empty
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
