"use client";

// Economics (SPEC §6, view 4): the Analyst result, winner/loser list and the
// learnings feed. Fixture results are ALWAYS labelled „Demo-Daten“ — never
// sold as live optimisation (SPEC §3, Stufe 7). Form follows DESIGN.md.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisResult, ClassifiedAdRow } from "@/engine/agents/analyst";
import type { BrandState } from "@/engine/types";

function euro(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2).replace(".", ",")} €`;
}

function QuietAction({
  label,
  onClick,
  disabled,
  tone = "solid",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "solid" | "ghost";
}) {
  const skin =
    tone === "solid"
      ? "bg-ink-750 text-foreground hover:bg-rule"
      : "text-text-soft hover:bg-ink-750 hover:text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-9 items-center rounded-xl px-4 text-[0.8125rem] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${skin}`}
    >
      {label}
    </button>
  );
}

// Audio briefing (Should scope): one button, fires POST /briefing and plays
// the returned mp3 via a hidden HTML5 audio element.
function BriefingButton({ brandSlug }: { brandSlug: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const play = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/brands/${brandSlug}/briefing`, {
        method: "POST",
      });
      const json = (await res.json()) as
        | { ok: true; url: string }
        | { ok: false; error: string };
      if (!json.ok) throw new Error(json.error);
      if (audioRef.current) {
        audioRef.current.src = json.url;
        await audioRef.current.play();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "unbekannter Fehler");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <QuietAction
        tone="ghost"
        label={busy ? "Briefing entsteht …" : "Audio-Briefing"}
        disabled={busy}
        onClick={play}
      />
      <audio ref={audioRef} className="hidden" />
      {error ? (
        <span className="text-[0.8125rem] text-signal-red">
          Briefing-Fehler: {error}
        </span>
      ) : null}
    </>
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
    <div className="rounded-2xl bg-ink-800 px-5 py-4">
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
          {row.leads} Leads · {euro(row.cpl)}
        </span>
      </div>
    </div>
  );
}

export function EconomicsTab({
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

  // Job-Muster (#7): die Route antwortet sofort mit 202 + runId, das
  // Ergebnis kommt als run.result über das bestehende /state-Polling.
  const run = useCallback(async (mode: "auto" | "live" | "fixture") => {
    setError(null);
    try {
      const res = await fetch(`/api/brands/${brandSlug}/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const json = (await res.json()) as
        | { ok: true; runId: string }
        | { ok: false; error: string };
      if (!json.ok) throw new Error(json.error);
      setPendingRunId(json.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unbekannter Fehler");
    }
  }, [brandSlug]);

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    run("auto");
  }, [run]);

  // Resolve the pending run from the polled state prop (MissionControl polls
  // /state every 5s): finished -> result, failed -> error text.
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

  const rows = analysis?.rows ?? [];
  const winners = rows.filter((r) => r.classification === "winner");
  const losers = rows.filter((r) => r.classification === "loser");
  const rest = rows.filter((r) => r.classification === "insufficient_data");
  const learnings = state?.learnings ?? [];

  const cpl = analysis?.totals.cpl ?? null;
  // Onboarded brands may carry targetCpa: null — treat like "no limit set".
  const target = state?.brand.targetCpa ?? undefined;
  const underTarget = cpl !== null && target !== undefined && cpl <= target;

  return (
    <>
      <header className="mb-12 flex items-start justify-between gap-8">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em]">
            Wirtschaftlichkeit
          </h1>
          <p className="mt-2 max-w-[52ch] text-[0.9375rem] leading-relaxed text-text-soft">
            Was ein Lead gerade kostet, gemessen an der Grenze, die sich{" "}
            {state?.brand.name ?? "die Marke"} leisten kann.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <BriefingButton brandSlug={brandSlug} />
          <QuietAction
            label={loading ? "analysiert …" : "Neu analysieren"}
            disabled={loading}
            onClick={() => run("auto")}
          />
        </div>
      </header>

      {error ? (
        <p className="mb-6 rounded-xl bg-signal-red/10 px-4 py-2.5 text-[0.8125rem] text-signal-red">
          Analyse-Fehler: {error}
        </p>
      ) : null}

      {/* The one strong element of this view: the measured price per lead. */}
      <section className="mb-12 rounded-3xl bg-ink-800 px-8 py-9">
        <p className="text-[0.8125rem] text-text-soft">Preis pro Lead</p>
        {cpl === null ? (
          <p className="mt-2 text-[1.5rem] font-semibold tracking-[-0.03em] text-text-soft">
            noch nicht gemessen
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
        <div className="mt-6 flex flex-wrap items-baseline gap-x-8 gap-y-2 text-[0.875rem]">
          <span className="text-text-soft">
            Ausgegeben{" "}
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
          <span className="text-text-soft">
            Grenze{" "}
            <span className="tnum text-foreground">
              {target === undefined ? "—" : `${target} €`}
            </span>
          </span>
          {analysis?.source === "fixture" ? (
            <span className="rounded-lg bg-signal-amber/12 px-2.5 py-1 text-[0.75rem] font-medium text-signal-amber">
              Demo-Daten
            </span>
          ) : null}
          {analysis?.source === "live" && rows.length === 0 ? (
            <span className="text-[0.8125rem] text-text-faint">
              Live · Konnektivität in Ordnung, noch keine Daten
            </span>
          ) : null}
        </div>
        {analysis?.note ? (
          <p className="mt-4 text-[0.8125rem] text-text-faint">{analysis.note}</p>
        ) : null}
      </section>

      <section className="mb-12">
        <p className="group-heading mb-3 px-1">
          Gewinner und Verlierer
          <span className="ml-1.5 tnum text-text-faint/70">
            {winners.length} / {losers.length}
          </span>
        </p>
        {rows.length === 0 ? (
          <p className="rounded-2xl bg-ink-800 px-5 py-4 text-[0.875rem] leading-relaxed text-text-soft">
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
          <p className="mt-4 px-1 text-[0.9375rem] leading-relaxed text-foreground">
            {analysis.recommendation}
          </p>
        ) : null}
      </section>

      <section>
        <p className="group-heading mb-3 px-1">
          Gelernt
          <span className="ml-1.5 tnum text-text-faint/70">
            {learnings.length}
          </span>
        </p>
        {learnings.length === 0 ? (
          <p className="rounded-2xl bg-ink-800 px-5 py-4 text-[0.875rem] leading-relaxed text-text-soft">
            Noch keine Learnings. Der Analyst schreibt sie nach jedem
            Mining-Lauf.
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
