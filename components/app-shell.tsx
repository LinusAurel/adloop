"use client";

// App shell: a quiet, agentic marketing platform. Chat first, few clear
// areas, brand as context (a subtle accent shifts with the brand). State
// comes from GET /state polled every 5s; long mutations answer 202 + runId
// (#7) and progress is read from the polled runs.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BrandState, Run } from "@/engine/types";
import { Sidebar } from "@/components/sidebar";
import { CommandPalette } from "@/components/command-palette";
import { BoardView } from "@/components/board-view";
import { StudioView } from "@/components/studio-view";
import { EconomicsView } from "@/components/economics-view";
import { TickerView } from "@/components/ticker-view";
import { BrandProfileView } from "@/components/brand-profile-view";
import { ConnectionsView } from "@/components/connections-view";
import { ErrorNote } from "@/components/bits";
import { accentForBrand } from "@/lib/brand-accent";
// Chat lands as components/chat-panel.tsx from a parallel stream — swap this
// import to "@/components/chat-panel" once the file exists.
import { ChatPanel } from "@/components/chat-panel";

const DEFAULT_BRAND_SLUG = "loyft";
const POLL_MS = 5000;

// The age cap keeps buttons usable if a server crash orphans a running run.
const RUN_ACTIVE_MAX_AGE_MS = 15 * 60 * 1000;

export type ViewKey =
  | "chat"
  | "board"
  | "studio"
  | "economics"
  | "ticker"
  | "brand"
  | "connections";

function isRunActive(run: Run): boolean {
  if (run.finishedAt) return false;
  return Date.now() - new Date(run.startedAt).getTime() < RUN_ACTIVE_MAX_AGE_MS;
}

export function AppShell() {
  const [brandSlug, setBrandSlug] = useState(DEFAULT_BRAND_SLUG);
  const [brands, setBrands] = useState<{ slug: string; name: string }[]>([]);
  const [state, setState] = useState<BrandState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>("chat");
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Remount key for the chat panel: "New" starts a fresh conversation.
  const [chatKey, setChatKey] = useState(0);
  const [onboarding, setOnboarding] = useState(false);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  // Cross-view navigation targets: the open board drawer and the angle the
  // Studio should focus (set via adloop:open-angle / adloop:open-asset).
  const [openAngleId, setOpenAngleId] = useState<string | null>(null);
  const [studioFocusAngleId, setStudioFocusAngleId] = useState<string | null>(
    null,
  );

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
      setError(e instanceof Error ? e.message : "unknown error");
    }
  }, [brandSlug]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // ⌘K opens the palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const switchBrand = useCallback((slug: string) => {
    setBrandSlug((current) => {
      if (slug === current) return current;
      setState(null);
      setOpenAngleId(null);
      setStudioFocusAngleId(null);
      return slug;
    });
  }, []);

  // Cross-view events: anything in the app (⌘K palette, angle drawer, chat)
  // can deep-link to an angle on the board or an asset in the Studio.
  //   adloop:open-angle {detail:{angleId}} → board + detail drawer
  //   adloop:open-asset {detail:{assetId}} → studio + that asset's angle
  useEffect(() => {
    const onOpenAngle = (e: Event) => {
      const angleId = (e as CustomEvent<{ angleId?: string }>).detail?.angleId;
      if (!angleId) return;
      setView("board");
      setOpenAngleId(angleId);
    };
    const onOpenAsset = (e: Event) => {
      const assetId = (e as CustomEvent<{ assetId?: string }>).detail?.assetId;
      if (!assetId) return;
      const asset = state?.assets.find((a) => a.id === assetId);
      setOpenAngleId(null);
      setView("studio");
      if (asset) setStudioFocusAngleId(asset.angleId);
    };
    window.addEventListener("adloop:open-angle", onOpenAngle);
    window.addEventListener("adloop:open-asset", onOpenAsset);
    return () => {
      window.removeEventListener("adloop:open-angle", onOpenAngle);
      window.removeEventListener("adloop:open-asset", onOpenAsset);
    };
  }, [state]);

  // Onboarding: URL in, Scout runs async (202 + runId, #7); the UI switches
  // to the new brand and follows progress via /state polling.
  const onboard = useCallback(
    async (url: string) => {
      setOnboarding(true);
      setOnboardError(null);
      try {
        const res = await fetch("/api/onboard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const data = (await res.json()) as { slug?: string; error?: string };
        // 202 (new) and 409 brand_exists both deliver the slug — switch over.
        if (data.slug) {
          switchBrand(data.slug);
        } else {
          setOnboardError(data.error ?? `onboard ${res.status}`);
        }
      } catch (e) {
        setOnboardError(e instanceof Error ? e.message : "unknown error");
      } finally {
        setOnboarding(false);
      }
    },
    [switchBrand],
  );

  const runs = useMemo(() => state?.runs ?? [], [state]);

  const scoutRunning = runs.some((r) => r.stage === "scout" && isRunActive(r));
  const strategistRunning = runs.some(
    (r) => r.stage === "strategist" && isRunActive(r),
  );
  const publishRunning = runs.some(
    (r) => r.stage === "publish" && isRunActive(r),
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

  const tickerLines = useMemo(
    () =>
      runs
        .flatMap((run) => run.log.map((entry) => ({ ...entry, runId: run.id })))
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, 100),
    [runs],
  );

  // Brand as context: the accent shifts with the brand.
  const accent = useMemo(
    () => accentForBrand(brandSlug, state?.brand.designTokens),
    [brandSlug, state],
  );

  const wide = view === "board" || view === "studio";

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar
        view={view}
        onView={setView}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
        onNewChat={() => {
          setChatKey((k) => k + 1);
          setView("chat");
        }}
        onOpenPalette={() => setPaletteOpen(true)}
        brands={brands}
        brandSlug={brandSlug}
        brandName={state?.brand.name}
        accent={accent}
        onBrand={switchBrand}
        onboarding={onboarding}
        onboardError={onboardError}
        onOnboard={onboard}
      />

      <main className="flex min-h-screen min-w-0 flex-1 flex-col">
        {scoutRunning ? (
          <p className="animate-pulse px-8 pt-4 text-[0.8125rem] text-text-soft">
            Scout is reading the brand…
          </p>
        ) : null}

        <div
          className={`mx-auto flex min-h-0 w-full flex-1 flex-col px-8 pb-16 pt-10 ${
            wide ? "max-w-[1280px]" : "max-w-[840px]"
          }`}
        >
          {error ? (
            <div className="mb-4">
              <ErrorNote text={`State unreachable: ${error}`} />
            </div>
          ) : null}
          {failedRun ? (
            <div className="mb-4">
              <ErrorNote
                text={`Last run (${failedRun.stage}) failed: ${
                  failedRun.error ?? "unknown error"
                } — details in the ticker.`}
              />
            </div>
          ) : null}

          {view === "chat" ? (
            <ChatPanel
              key={`${brandSlug}-${chatKey}`}
              brandSlug={brandSlug}
              onStateChanged={load}
            />
          ) : null}
          {view === "board" ? (
            <BoardView
              state={state}
              brandSlug={brandSlug}
              strategistRunning={strategistRunning}
              runningAssetAngleIds={runningAssetAngleIds}
              onChanged={load}
              openAngleId={openAngleId}
              onOpenAngle={setOpenAngleId}
            />
          ) : null}
          {view === "studio" ? (
            <StudioView
              state={state}
              brandSlug={brandSlug}
              runningAssetAngleIds={runningAssetAngleIds}
              publishRunning={publishRunning}
              onChanged={load}
              focusAngleId={studioFocusAngleId}
            />
          ) : null}
          {view === "economics" ? (
            // Key remounts the view on brand switch so analysis state resets.
            <EconomicsView key={brandSlug} state={state} brandSlug={brandSlug} />
          ) : null}
          {view === "ticker" ? <TickerView lines={tickerLines} /> : null}
          {view === "brand" ? (
            <BrandProfileView
              key={brandSlug}
              state={state}
              brandSlug={brandSlug}
              onSaved={load}
            />
          ) : null}
          {view === "connections" ? <ConnectionsView /> : null}
        </div>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        state={state}
        brands={brands}
        onView={setView}
        onBrand={switchBrand}
      />
    </div>
  );
}
