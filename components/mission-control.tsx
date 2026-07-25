"use client";

// Mission Control (SPEC §6): one page, 4 tabs, polling on /state.
// Skeleton only — visual polish happens in a separate design stream.

import { useCallback, useEffect, useState } from "react";
import type { Angle, AngleStatus, BrandState, RunLogEntry } from "@/engine/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const MINT = "#00FF7F";
const BRAND_SLUG = "loyft";
const POLL_MS = 5000;

const BOARD_COLUMNS: { status: AngleStatus; label: string }[] = [
  { status: "draft", label: "Entwurf" },
  { status: "approved", label: "Freigegeben" },
  { status: "testing", label: "Im Test" },
  { status: "validated", label: "Validiert" },
  { status: "killed", label: "Verworfen" },
];

function formatCpl(value?: number): string {
  return value === undefined || value === null ? "—" : `${value} €`;
}

function AngleCard({ angle }: { angle: Angle }) {
  const act = async (action: "approve" | "kill") => {
    // Stub routes today; wired for real in the Strategist work package.
    await fetch(`/api/angles/${angle.id}/${action}`, { method: "POST" });
  };
  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-zinc-100">{angle.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs text-zinc-400">
        <p>Segment: {angle.segment}</p>
        <p>Hook-Richtung: {angle.hookDirection}</p>
        <p>
          CPL erwartet {formatCpl(angle.expectedCpl)} · gemessen{" "}
          {formatCpl(angle.measuredCpl)}
        </p>
        {angle.status === "draft" && (
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              style={{ backgroundColor: MINT, color: "#002429" }}
              onClick={() => act("approve")}
            >
              Freigeben
            </Button>
            <Button size="sm" variant="destructive" onClick={() => act("kill")}>
              Verwerfen
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
      {text}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-widest text-zinc-500">{label}</p>
        <p className="mt-2 text-3xl font-bold tabular-nums" style={{ color: MINT }}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

export function MissionControl() {
  const [state, setState] = useState<BrandState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/brands/${BRAND_SLUG}/state`, { cache: "no-store" });
      if (!res.ok) throw new Error(`state ${res.status}`);
      setState((await res.json()) as BrandState);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unbekannter Fehler");
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const tickerLines: (RunLogEntry & { runId: string })[] = (state?.runs ?? [])
    .flatMap((run) => run.log.map((entry) => ({ ...entry, runId: run.id })))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 100);

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-8 text-zinc-100">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            adloop <span style={{ color: MINT }}>Mission Control</span>
          </h1>
          <p className="text-sm text-zinc-500">
            {state ? `Brand: ${state.brand.name}` : "lädt …"}
            {error ? ` · Fehler: ${error}` : ""}
          </p>
        </div>
        <Badge variant="outline" className="border-zinc-700 text-zinc-400">
          Ziel-CPA ≤ {state?.brand.targetCpa ?? "—"} €
        </Badge>
      </header>

      <Tabs defaultValue="board">
        <TabsList className="bg-zinc-900">
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="studio">Studio</TabsTrigger>
          <TabsTrigger value="ticker">Ticker</TabsTrigger>
          <TabsTrigger value="economics">Economics</TabsTrigger>
        </TabsList>

        <TabsContent value="board" className="mt-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
            {BOARD_COLUMNS.map((col) => {
              const angles = (state?.angles ?? []).filter((a) => a.status === col.status);
              return (
                <section key={col.status} className="space-y-3">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
                    {col.label}{" "}
                    <span className="text-zinc-600">({angles.length})</span>
                  </h2>
                  {angles.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-600">
                      leer
                    </div>
                  ) : (
                    angles.map((a) => <AngleCard key={a.id} angle={a} />)
                  )}
                </section>
              );
            })}
          </div>
          {(state?.angles ?? []).length === 0 && (
            <p className="mt-6 text-sm text-zinc-500">
              Noch keine Angles. Der Strategist erzeugt sie über „Angles
              generieren“, sobald die Pipeline-Stufe 2 angeschlossen ist.
            </p>
          )}
        </TabsContent>

        <TabsContent value="studio" className="mt-6">
          {(state?.assets ?? []).length === 0 ? (
            <EmptyState text="Noch keine Assets. Copywriter, Critic und Designer folgen als nächste Pipeline-Stufen." />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {state?.assets.map((asset) => (
                <Card key={asset.id} className="bg-zinc-900 border-zinc-800">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">
                      {asset.kind} · {asset.status}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-zinc-400">
                    Critic-Score: {asset.criticScore ?? "—"}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="ticker" className="mt-6">
          {tickerLines.length === 0 ? (
            <EmptyState text="Noch keine Runs. Hier erscheint der Live-Ticker der Agenten, sobald die erste Pipeline läuft." />
          ) : (
            <ul className="space-y-1 font-mono text-xs text-zinc-400">
              {tickerLines.map((line, i) => (
                <li key={`${line.runId}-${i}`}>
                  <span className="text-zinc-600">{line.ts}</span>{" "}
                  <span style={{ color: MINT }}>{line.agent}</span> {line.message}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="economics" className="mt-6 space-y-6">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatTile label="Spend" value="—" />
            <StatTile label="Leads" value="—" />
            <StatTile label="CPL" value="—" />
            <StatTile
              label="CPA-Grenze"
              value={state ? `${state.brand.targetCpa} €` : "—"}
            />
          </div>
          <EmptyState text="Winner/Loser-Liste und Learnings-Feed erscheinen hier, sobald der Analyst Insights liest." />
        </TabsContent>
      </Tabs>
    </main>
  );
}
