"use client";

// Mission Control (SPEC §6): one page, 4 tabs, polling on /state.
// Skeleton only — visual polish happens in a separate design stream.

import { useCallback, useEffect, useState } from "react";
import type {
  Angle,
  AngleStatus,
  Asset,
  BrandState,
  Run,
  RunLogEntry,
} from "@/engine/types";
import type { CopyVariant } from "@/engine/schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EconomicsTab } from "@/components/economics-tab";

const MINT = "#00FF7F";
const DEFAULT_BRAND_SLUG = "loyft";
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

// Mutations answer 202 + runId (#7); progress comes from /state polling.
// The age cap keeps buttons usable if a server crash orphans a running run.
const RUN_ACTIVE_MAX_AGE_MS = 15 * 60 * 1000;

function isRunActive(run: Run): boolean {
  if (run.finishedAt) return false;
  return Date.now() - new Date(run.startedAt).getTime() < RUN_ACTIVE_MAX_AGE_MS;
}

function AngleCard({
  angle,
  pipelineRunning,
  onChanged,
}: {
  angle: Angle;
  // True while a run of stage "assets" for this angle is active in the store —
  // survives reloads, cleared by /state polling once the run finishes (#7).
  pipelineRunning: boolean;
  onChanged: () => void;
}) {
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
      // Route answers 202 immediately (#7); onChanged picks up the new run.
      await fetch(`/api/angles/${angle.id}/assets/generate`, { method: "POST" });
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const assetsBusy = busy === "assets" || pipelineRunning;

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
              disabled={busy !== null || pipelineRunning}
              style={{ backgroundColor: MINT, color: "#002429" }}
              onClick={generateAssets}
            >
              {assetsBusy ? (
                <span className="animate-pulse">Pipeline läuft …</span>
              ) : (
                "Assets generieren"
              )}
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
        <CardTitle className="flex items-center justify-between gap-2 text-sm text-zinc-100">
          <span>{angle.name}</span>
          <span className="flex items-center gap-2">
            {/* LP-Demo (Message-Match): Ad und Landingpage nebeneinander zeigbar. */}
            <a
              href={`/lp/${angle.id}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-normal text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
            >
              LP ansehen
            </a>
            <Badge variant="outline" className="border-zinc-700 text-zinc-400">
              {status}
            </Badge>
          </span>
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
  // Brand switcher: every brand in the store is selectable, loyft is default.
  const [brandSlug, setBrandSlug] = useState(DEFAULT_BRAND_SLUG);
  const [brands, setBrands] = useState<{ slug: string; name: string }[]>([]);
  const [state, setState] = useState<BrandState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  // Onboarding: URL in, Scout runs async (202 + runId, #7), the UI switches
  // to the new brand and follows progress via /state polling.
  const [onboardUrl, setOnboardUrl] = useState("");
  const [onboarding, setOnboarding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [stateRes, brandsRes] = await Promise.all([
        fetch(`/api/brands/${brandSlug}/state`, { cache: "no-store" }),
        fetch(`/api/brands`, { cache: "no-store" }),
      ]);
      if (brandsRes.ok) {
        const data = (await brandsRes.json()) as {
          brands?: { slug: string; name: string }[];
        };
        setBrands(data.brands ?? []);
      }
      if (!stateRes.ok) throw new Error(`state ${stateRes.status}`);
      setState((await stateRes.json()) as BrandState);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unbekannter Fehler");
    }
  }, [brandSlug]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const switchBrand = (slug: string) => {
    if (slug === brandSlug) return;
    setState(null);
    setBrandSlug(slug);
  };

  const onboard = async () => {
    const url = onboardUrl.trim();
    if (!url) return;
    setOnboarding(true);
    try {
      const res = await fetch("/api/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await res.json()) as { slug?: string; error?: string };
      // 202 (neu) und 409 brand_exists liefern beide den Slug — hinschalten.
      if (data.slug) {
        setOnboardUrl("");
        switchBrand(data.slug);
      } else {
        setError(data.error ?? `onboard ${res.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "unbekannter Fehler");
    } finally {
      setOnboarding(false);
    }
  };

  const generateAngles = async () => {
    setGenerating(true);
    try {
      // Route answers 202 immediately (#7); load() picks up the running run,
      // the 5s polling shows progress until it finishes.
      await fetch(`/api/brands/${brandSlug}/angles/generate`, { method: "POST" });
      await load();
    } finally {
      setGenerating(false);
    }
  };

  const runs = state?.runs ?? [];
  const scoutRunning = runs.some((r) => r.stage === "scout" && isRunActive(r));
  const strategistRunning = runs.some(
    (r) => r.stage === "strategist" && isRunActive(r),
  );
  // Angles with an active assets run — drives the per-card busy state.
  const runningAssetAngleIds = new Set(
    runs
      .filter((r) => r.stage === "assets" && isRunActive(r))
      .map((r) => r.angleId),
  );
  // Subtle failure hint: only for the most recently started run, so the hint
  // disappears as soon as a newer run starts or succeeds.
  const latestRun = [...runs].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  )[0];
  const failedRun = latestRun?.status === "failed" ? latestRun : undefined;

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
            {scoutRunning ? " · Scout recherchiert …" : ""}
            {error ? ` · Fehler: ${error}` : ""}
          </p>
          {failedRun ? (
            <p className="text-xs text-red-400">
              Letzter Lauf ({failedRun.stage}) fehlgeschlagen:{" "}
              {failedRun.error ?? "unbekannter Fehler"} — Details im Ticker
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          {/* Onboarding: jede Firma per URL anschließen (Scout, Stufe 1). */}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onboard();
            }}
          >
            <input
              type="text"
              value={onboardUrl}
              onChange={(e) => setOnboardUrl(e.target.value)}
              placeholder="https://neue-brand.de"
              disabled={onboarding}
              className="h-8 w-48 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-200 placeholder:text-zinc-600"
            />
            <Button
              size="sm"
              type="submit"
              variant="outline"
              className="border-zinc-700 text-zinc-300"
              disabled={onboarding || onboardUrl.trim() === ""}
            >
              {onboarding ? (
                <span className="animate-pulse">Scout startet …</span>
              ) : (
                "Brand hinzufügen"
              )}
            </Button>
          </form>
          {/* Brand-Switcher: alle Brands im Store, Default loyft. */}
          <select
            value={brandSlug}
            onChange={(e) => switchBrand(e.target.value)}
            className="h-8 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-200"
          >
            {(brands.some((b) => b.slug === brandSlug)
              ? brands
              : [...brands, { slug: brandSlug, name: brandSlug }]
            ).map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.name}
              </option>
            ))}
          </select>
          <Badge variant="outline" className="border-zinc-700 text-zinc-400">
            Ziel-CPA ≤ {state?.brand.targetCpa ?? "—"} €
          </Badge>
        </div>
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
              disabled={generating || strategistRunning}
              style={{ backgroundColor: MINT, color: "#002429" }}
              onClick={generateAngles}
            >
              {generating || strategistRunning ? (
                <span className="animate-pulse">Strategist läuft …</span>
              ) : (
                "Angles generieren"
              )}
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
                      <AngleCard
                        key={a.id}
                        angle={a}
                        pipelineRunning={runningAssetAngleIds.has(a.id)}
                        onChanged={load}
                      />
                    ))
                  )}
                </section>
              );
            })}
          </div>
          {(state?.angles ?? []).length === 0 && (
            <p className="mt-6 text-sm text-zinc-500">
              Noch keine Angles. „Angles generieren“ startet den Strategist mit
              dem Brand-Kontext (Seed oder Scout-Research).
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
                  <span style={{ color: MINT }}>{line.agent}</span>{" "}
                  <span className={line.level === "error" ? "text-red-400" : undefined}>
                    {line.message}
                  </span>
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
