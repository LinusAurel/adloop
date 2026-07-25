"use client";

// Economics tab (SPEC §6, view 4): tiles from the Analyst result, winner/
// loser list, learnings feed. Fixture results are ALWAYS labeled with the
// „Demo-Daten“ badge — never sold as live optimization (SPEC §3, Stufe 7).

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisResult, ClassifiedAdRow } from "@/engine/agents/analyst";
import type { BrandState } from "@/engine/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const MINT = "#00FF7F";

function euro(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2).replace(".", ",")} €`;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-widest text-zinc-500">{label}</p>
        <p className="mt-2 text-3xl font-bold tabular-nums" style={{ color: MINT }}>
          {value}
        </p>
        {sub ? <p className="mt-1 text-xs text-zinc-500">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

function RowLine({ row }: { row: ClassifiedAdRow }) {
  const tone =
    row.classification === "winner"
      ? "text-emerald-400"
      : row.classification === "loser"
        ? "text-red-400"
        : "text-zinc-500";
  const label =
    row.classification === "winner"
      ? "Winner"
      : row.classification === "loser"
        ? "Loser"
        : "zu wenig Daten";
  return (
    <li className="flex items-baseline justify-between gap-4 border-b border-zinc-800 py-2 text-xs">
      <div className="min-w-0">
        <p className="truncate font-mono text-zinc-300">{row.adName || row.adId}</p>
        <p className="text-zinc-500">{row.reason}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={`font-semibold ${tone}`}>{label}</p>
        <p className="text-zinc-500">
          {euro(row.spend)} · {row.leads} Leads · CPL {euro(row.cpl)}
        </p>
      </div>
    </li>
  );
}

export function EconomicsTab({ state }: { state: BrandState | null }) {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ranOnce = useRef(false);

  const run = useCallback(async (mode: "auto" | "live" | "fixture") => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/brands/loyft/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const json = (await res.json()) as ({ ok: true } & AnalysisResult) | { ok: false; error: string };
      if (!json.ok) throw new Error(json.error);
      setAnalysis(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unbekannter Fehler");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    run("auto");
  }, [run]);

  const rows = analysis?.rows ?? [];
  const winners = rows.filter((r) => r.classification === "winner");
  const losers = rows.filter((r) => r.classification === "loser");
  const rest = rows.filter((r) => r.classification === "insufficient_data");
  const learnings = state?.learnings ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        {analysis?.source === "fixture" ? (
          <Badge className="bg-amber-500/15 text-amber-400 border border-amber-500/40">
            Demo-Daten
          </Badge>
        ) : null}
        {analysis?.source === "live" && rows.length === 0 ? (
          <Badge variant="outline" className="border-zinc-700 text-zinc-400">
            Live · Konnektivität OK, noch keine Daten
          </Badge>
        ) : null}
        {analysis?.note ? <span className="text-xs text-zinc-500">{analysis.note}</span> : null}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto border-zinc-700 text-zinc-300"
          disabled={loading}
          onClick={() => run("auto")}
        >
          {loading ? "analysiert …" : "Neu analysieren"}
        </Button>
      </div>

      {error ? <p className="text-sm text-red-400">Analyse-Fehler: {error}</p> : null}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile label="Spend" value={euro(analysis?.totals.spend ?? null)} />
        <Tile label="Leads" value={analysis ? String(analysis.totals.leads) : "—"} />
        <Tile label="CPL" value={euro(analysis?.totals.cpl ?? null)} />
        <Tile
          label="Zielfunktion"
          value={state ? `≤ ${state.brand.targetCpa} €` : "—"}
          sub="CPA-Grenze aus Brand-Config"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="bg-zinc-900 border-zinc-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Winner / Loser{" "}
              <span className="text-zinc-500">
                ({winners.length} / {losers.length}, {rest.length}× zu wenig Daten)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <p className="text-xs text-zinc-500">
                Keine Ad-Daten. Pausierte frische Ads liefern physikalisch keine Insights.
              </p>
            ) : (
              <ul>
                {[...winners, ...losers, ...rest].map((row) => (
                  <RowLine key={row.adId} row={row} />
                ))}
              </ul>
            )}
            {analysis?.recommendation ? (
              <p className="mt-3 text-xs" style={{ color: MINT }}>
                {analysis.recommendation}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="bg-zinc-900 border-zinc-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Learnings-Feed <span className="text-zinc-500">({learnings.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {learnings.length === 0 ? (
              <p className="text-xs text-zinc-500">
                Noch keine Learnings. Der Analyst schreibt sie nach jedem Mining-Lauf.
              </p>
            ) : (
              <ul className="space-y-2 text-xs text-zinc-400">
                {learnings.map((l) => (
                  <li key={l.id} className="border-b border-zinc-800 pb-2">
                    {l.pattern}
                    <span className="ml-2 text-zinc-600">({l.source})</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
