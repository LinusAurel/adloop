"use client";

// Mission Control (SPEC §6): one page, 4 tabs, polling on /state.
// Skeleton only — visual polish happens in a separate design stream.

import { useCallback, useEffect, useState } from "react";
import type {
  Angle,
  AngleStatus,
  Asset,
  BrandState,
  RunLogEntry,
} from "@/engine/types";
import type { CopyVariant } from "@/engine/schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EconomicsTab } from "@/components/economics-tab";

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

// Payload shapes written by the asset pipeline (engine/agents/pipeline.ts).
interface CopyAssetPayload {
  outline?: string;
  variants?: CopyVariant[];
  chosenIndex?: number;
}

interface StaticAssetPayload {
  imageUrl?: string;
}

function formatCpl(value?: number): string {
  return value === undefined || value === null ? "—" : `${value} €`;
}

function AngleCard({ angle, onChanged }: { angle: Angle; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (action: "approve" | "kill") => {
    setBusy(action);
    try {
      await fetch(`/api/angles/${angle.id}/${action}`, { method: "POST" });
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const generateAssets = async () => {
    setBusy("assets");
    try {
      await fetch(`/api/angles/${angle.id}/assets/generate`, { method: "POST" });
      onChanged();
    } finally {
      setBusy(null);
    }
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
              disabled={busy !== null}
              style={{ backgroundColor: MINT, color: "#002429" }}
              onClick={() => act("approve")}
            >
              Freigeben
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => act("kill")}
            >
              Verwerfen
            </Button>
          </div>
        )}
        {angle.status === "approved" && (
          <div className="pt-1">
            <Button
              size="sm"
              disabled={busy !== null}
              style={{ backgroundColor: MINT, color: "#002429" }}
              onClick={generateAssets}
            >
              {busy === "assets" ? "Pipeline läuft …" : "Assets generieren"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AssetPairCard({
  angle,
  copyAsset,
  staticAsset,
  onChanged,
}: {
  angle: Angle;
  copyAsset?: Asset;
  staticAsset?: Asset;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const payload = (copyAsset?.payload ?? {}) as CopyAssetPayload;
  const variant = payload.variants?.[payload.chosenIndex ?? 0];
  const imageUrl = ((staticAsset?.payload ?? {}) as StaticAssetPayload).imageUrl;
  const status = copyAsset?.status ?? staticAsset?.status ?? "draft";

  const act = async (action: "approve" | "reject") => {
    setBusy(true);
    try {
      for (const asset of [copyAsset, staticAsset]) {
        if (!asset) continue;
        await fetch(`/api/assets/${asset.id}/${action}`, { method: "POST" });
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm text-zinc-100">
          <span>{angle.name}</span>
          <Badge variant="outline" className="border-zinc-700 text-zinc-400">
            {status}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs text-zinc-400">
        {imageUrl ? (
          // Static preview in a Meta-feed-like 4:5 frame.
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt={`Static für ${angle.name}`}
              className="aspect-[4/5] w-full object-cover"
            />
          </div>
        ) : (
          <div className="flex aspect-[4/5] items-center justify-center rounded-lg border border-dashed border-zinc-800 text-zinc-600">
            kein Static
          </div>
        )}
        {variant && (
          <div className="space-y-1">
            <p className="font-semibold text-zinc-200">{variant.hook}</p>
            <p className="whitespace-pre-line">{variant.primary}</p>
            <p className="text-zinc-300">
              {variant.headline} · <span style={{ color: MINT }}>{variant.cta}</span>
            </p>
          </div>
        )}
        <p>
          Critic-Score:{" "}
          <span style={{ color: MINT }}>{copyAsset?.criticScore ?? "—"}</span>
          {copyAsset?.criticNotes ? (
            <span className="mt-1 block whitespace-pre-line text-zinc-500">
              {copyAsset.criticNotes}
            </span>
          ) : null}
        </p>
        {status === "draft" && (
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              disabled={busy}
              style={{ backgroundColor: MINT, color: "#002429" }}
              onClick={() => act("approve")}
            >
              Freigeben
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => act("reject")}
            >
              Ablehnen
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

export function MissionControl() {
  const [state, setState] = useState<BrandState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

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

  const generateAngles = async () => {
    setGenerating(true);
    try {
      await fetch(`/api/brands/${BRAND_SLUG}/angles/generate`, { method: "POST" });
      await load();
    } finally {
      setGenerating(false);
    }
  };

  const tickerLines: (RunLogEntry & { runId: string })[] = (state?.runs ?? [])
    .flatMap((run) => run.log.map((entry) => ({ ...entry, runId: run.id })))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 100);

  // AssetPairs for the Studio: one card per angle that has assets.
  const anglesById = new Map((state?.angles ?? []).map((a) => [a.id, a]));
  const pairs = [...anglesById.values()]
    .map((angle) => {
      const assets = (state?.assets ?? []).filter((a) => a.angleId === angle.id);
      return {
        angle,
        copyAsset: assets.findLast((a) => a.kind === "ad_copy"),
        staticAsset: assets.findLast((a) => a.kind === "static"),
      };
    })
    .filter((p) => p.copyAsset || p.staticAsset);

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
          <div className="mb-4 flex justify-end">
            <Button
              size="sm"
              disabled={generating}
              style={{ backgroundColor: MINT, color: "#002429" }}
              onClick={generateAngles}
            >
              {generating ? "Strategist läuft …" : "Angles generieren"}
            </Button>
          </div>
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
                    angles.map((a) => (
                      <AngleCard key={a.id} angle={a} onChanged={load} />
                    ))
                  )}
                </section>
              );
            })}
          </div>
          {(state?.angles ?? []).length === 0 && (
            <p className="mt-6 text-sm text-zinc-500">
              Noch keine Angles. „Angles generieren“ startet den Strategist mit
              dem loyft-Seed.
            </p>
          )}
        </TabsContent>

        <TabsContent value="studio" className="mt-6">
          {pairs.length === 0 ? (
            <EmptyState text="Noch keine Assets. Einen freigegebenen Angle im Board auswählen und „Assets generieren“ starten." />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {pairs.map((pair) => (
                <AssetPairCard
                  key={pair.angle.id}
                  angle={pair.angle}
                  copyAsset={pair.copyAsset}
                  staticAsset={pair.staticAsset}
                  onChanged={load}
                />
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

        <TabsContent value="economics" className="mt-6">
          <EconomicsTab state={state} />
        </TabsContent>
      </Tabs>
    </main>
  );
}
