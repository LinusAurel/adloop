"use client";

/*
  Mission Control — direction contract. DESIGN.md holds the full rule set;
  this header is the short version that must survive every edit here.

  - Shell: a quiet sidebar left, one centered content column right. The column
    is capped far below the viewport width — the empty space is the design.
  - One strong element per view (the mint action). Everything else recedes.
  - Structure comes from soft, strongly rounded surfaces separated by space,
    not from rules, boxes-in-boxes or uppercase stamps.
  - A list row reads as one sentence: bold subject, grey continuation, figures
    right. Uppercase appears only in group headings.
  - Mint is signal, never decoration: at most three occurrences per view.
  - Nothing is shown that no route backs. The flow view is rendered purely
    from runs delivered by /state.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  ChevronsUpDown,
  GitBranch,
  Image as ImageIcon,
  Layers,
  Search,
  TrendingUp,
} from "lucide-react";
import type {
  Angle,
  AngleStatus,
  Asset,
  BrandState,
  Run,
  RunLogEntry,
} from "@/engine/types";
import type { CopyVariant } from "@/engine/schemas";
import { EconomicsTab } from "@/components/economics-tab";

const DEFAULT_BRAND_SLUG = "loyft";
const POLL_MS = 5000;

// Mutations answer 202 + runId (#7); progress comes from /state polling.
// The age cap keeps buttons usable if a server crash orphans a running run.
const RUN_ACTIVE_MAX_AGE_MS = 15 * 60 * 1000;

type ViewKey = "board" | "studio" | "flow" | "ticker" | "economics";

// Payload shapes written by the asset pipeline (engine/agents/pipeline.ts).
interface CopyAssetPayload {
  outline?: string;
  variants?: CopyVariant[];
  chosenIndex?: number;
}

interface StaticAssetPayload {
  imageUrl?: string;
}

const NAV_MAIN = [
  { key: "board", label: "Board", Icon: Layers },
  { key: "studio", label: "Studio", Icon: ImageIcon },
] as const;

const NAV_WATCH = [
  { key: "flow", label: "Ablauf", Icon: GitBranch },
  { key: "ticker", label: "Ticker", Icon: Activity },
  { key: "economics", label: "Economics", Icon: TrendingUp },
] as const;

const VIEW_TITLE: Record<ViewKey, string> = {
  board: "Board",
  studio: "Studio",
  flow: "Ablauf",
  ticker: "Ticker",
  economics: "Economics",
};

const ANGLE_BAYS: { status: AngleStatus; label: string }[] = [
  { status: "draft", label: "Entwurf" },
  { status: "approved", label: "Freigegeben" },
  { status: "testing", label: "Im Test" },
  { status: "validated", label: "Validiert" },
  { status: "killed", label: "Verworfen" },
];

// Mint stays reserved for the win and the primary action.
const ASSET_DOT: Record<string, string> = {
  draft: "bg-text-faint",
  approved: "bg-foreground",
  published: "bg-mint",
  rejected: "bg-signal-red",
};

// The seven agents of SPEC §3. Stage keys are matched loosely because the
// asset pipeline writes one run for the copy/critic/design triplet.
const FLOW_STAGES: {
  key: string;
  label: string;
  role: string;
  stages: string[];
}[] = [
  { key: "scout", label: "Scout", role: "liest die Marke und sammelt Belege", stages: ["scout", "research", "onboard"] },
  { key: "strategist", label: "Strategist", role: "formt testbare Hypothesen mit Erwartungswert", stages: ["strategist", "angles"] },
  { key: "copywriter", label: "Copywriter", role: "schreibt Outline und Copy-Varianten", stages: ["copywriter", "copy", "assets"] },
  { key: "critic", label: "Critic", role: "bewertet und schickt zum Neuschreiben zurück", stages: ["critic", "assets"] },
  { key: "designer", label: "Designer", role: "erzeugt das Motiv im Format 4:5", stages: ["designer", "static", "assets"] },
  { key: "publisher", label: "Publisher", role: "legt Ads im Konto an, immer pausiert", stages: ["publisher", "publish"] },
  { key: "analyst", label: "Analyst", role: "liest Insights und zieht Muster", stages: ["analyst", "optimize"] },
];

// Product truth (KONZEPT §4): three decisions belong to a human, always.
const GATE_AFTER: Record<string, string> = {
  strategist: "Du gibst die Hypothese frei",
  designer: "Du gibst das Material frei",
  publisher: "Du aktivierst die Ad im Ads Manager",
};

function euro(value?: number | null): string {
  if (value === undefined || value === null) return "—";
  return `${value.toFixed(2).replace(".", ",")} €`;
}

function ago(iso?: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const min = Math.round(ms / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  return `vor ${Math.round(hours / 24)} Tg.`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "--:--:--"
    : d.toLocaleTimeString("de-DE", { hour12: false });
}

function matches(query: string, ...fields: (string | undefined | null)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f?.toLowerCase().includes(q));
}

function isRunActive(run: Run): boolean {
  if (run.finishedAt) return false;
  return Date.now() - new Date(run.startedAt).getTime() < RUN_ACTIVE_MAX_AGE_MS;
}

// Every click either changes something visible or names why it did not.
async function postAction(url: string): Promise<void> {
  const res = await fetch(url, { method: "POST" });
  if (res.ok) return;
  let detail = `Status ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body?.error === "string") detail = body.error;
  } catch {
    /* keep the status code */
  }
  throw new Error(detail);
}

// The one authored moment: an entry settles when its status really changed,
// not on every mount and not on every poll.
function useSettle(status: string): boolean {
  const previous = useRef(status);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (previous.current === status) return;
    previous.current = status;
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), 700);
    return () => clearTimeout(timer);
  }, [status]);
  return settling;
}

/* ---------------------------------------------------------------- atoms -- */

function Dot({ tone }: { tone: string }) {
  return <span className={`size-[7px] shrink-0 rounded-full ${tone}`} />;
}

function PrimaryAction({
  label,
  busyLabel,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  busyLabel: string;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="inline-flex h-11 items-center rounded-2xl bg-mint px-6 text-[0.9375rem] font-semibold text-[#04120a] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
    >
      {busy ? <span className="animate-pulse">{busyLabel}</span> : label}
    </button>
  );
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

function GroupHeading({ label, count }: { label: string; count?: number }) {
  return (
    <p className="group-heading mb-3 px-1">
      {label}
      {count === undefined ? null : (
        <span className="ml-1.5 tnum text-text-faint/70">{count}</span>
      )}
    </p>
  );
}

function ViewHeader({
  title,
  lead,
  action,
}: {
  title: string;
  lead: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-12 flex items-start justify-between gap-8">
      <div className="min-w-0">
        <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em]">
          {title}
        </h1>
        <p className="mt-2 max-w-[52ch] text-[0.9375rem] leading-relaxed text-text-soft">
          {lead}
        </p>
      </div>
      {action ? <div className="shrink-0 pt-1">{action}</div> : null}
    </header>
  );
}

// The empty state carries the reference's centred hero: one line, one
// sentence, one action. It is the normal state before the first run.
function Hero({
  title,
  lead,
  action,
}: {
  title: string;
  lead: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-24 text-center">
      <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em]">
        {title}
      </h1>
      <p className="mt-3 max-w-[46ch] text-[0.9375rem] leading-relaxed text-text-soft">
        {lead}
      </p>
      {action ? <div className="mt-8">{action}</div> : null}
    </div>
  );
}

function Surface({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl bg-ink-750 px-6 py-5 ${className}`}>
      {children}
    </div>
  );
}

/*
  The product's core statement, and therefore the largest type in the row:
  the engine writes down what it expects before money flows, and the measured
  value stands next to it. Both slots are always shown — an em dash says „not
  measured yet“, which is itself the point.
*/
function CplPair({
  expected,
  measured,
}: {
  expected?: number;
  measured?: number;
}) {
  const delta =
    expected !== undefined && measured !== undefined && expected > 0
      ? Math.round(((measured - expected) / expected) * 100)
      : undefined;
  const tone =
    measured === undefined
      ? "text-text-faint"
      : delta !== undefined && delta < 0
        ? "text-mint"
        : "text-signal-amber";

  return (
    <div className="flex shrink-0 items-start gap-8">
      <div className="text-right">
        <p className="text-[0.75rem] text-text-faint">erwartet</p>
        <p className="mt-1.5 text-[1.5rem] font-semibold leading-none tracking-[-0.02em] tnum text-text-soft">
          {euro(expected)}
        </p>
      </div>
      <div className="w-[104px] text-right">
        <p className="text-[0.75rem] text-text-faint">gemessen</p>
        <p
          className={`mt-1.5 text-[1.5rem] font-semibold leading-none tracking-[-0.02em] tnum ${tone}`}
        >
          {measured === undefined ? "—" : euro(measured)}
        </p>
        {delta === undefined ? null : (
          <p className={`mt-1.5 text-[0.8125rem] font-medium tnum ${tone}`}>
            {delta > 0 ? "+" : ""}
            {delta} %
          </p>
        )}
      </div>
    </div>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <p className="mt-3 rounded-xl bg-signal-red/10 px-4 py-2.5 text-[0.8125rem] text-signal-red">
      {text}
    </p>
  );
}

/* -------------------------------------------------------------- sidebar -- */

function Sidebar({
  view,
  onView,
  query,
  onQuery,
  brandName,
  targetCpa,
  brands,
  brandSlug,
  onBrand,
  onboarding,
  onboardError,
  onOnboard,
}: {
  view: ViewKey;
  onView: (v: ViewKey) => void;
  query: string;
  onQuery: (q: string) => void;
  brandName?: string;
  targetCpa?: number | null;
  brands: { slug: string; name: string }[];
  brandSlug: string;
  onBrand: (slug: string) => void;
  onboarding: boolean;
  onboardError: string | null;
  onOnboard: (url: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [onboardUrl, setOnboardUrl] = useState("");

  // Every brand in the store is selectable; an unknown slug (fresh onboard)
  // still renders so the select never jumps back to another brand.
  const options = brands.some((b) => b.slug === brandSlug)
    ? brands
    : [...brands, { slug: brandSlug, name: brandName ?? brandSlug }];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const item = (
    entry: { key: string; label: string; Icon: typeof Layers },
  ) => {
    const active = view === entry.key;
    return (
      <button
        key={entry.key}
        type="button"
        onClick={() => onView(entry.key as ViewKey)}
        className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[0.875rem] transition-colors ${
          active
            ? "bg-ink-800 font-medium text-foreground"
            : "text-text-soft hover:bg-ink-850 hover:text-foreground"
        }`}
      >
        <entry.Icon className="size-[15px] shrink-0" strokeWidth={1.75} />
        {entry.label}
      </button>
    );
  };

  return (
    // Sticky so the brand foot stays at the bottom of the screen, not at the
    // bottom of a long board.
    <aside className="sticky top-0 flex h-screen w-[240px] shrink-0 flex-col bg-ink-900 px-3 py-4">
      <p className="mb-5 px-3 pt-1 text-[0.9375rem] font-semibold tracking-[-0.02em]">
        adloop
      </p>

      <div className="relative mb-6">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-[14px] -translate-y-1/2 text-text-faint"
          strokeWidth={1.75}
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Suchen"
          aria-label="Einträge filtern"
          className="h-9 w-full rounded-xl bg-ink-850 pl-9 pr-12 text-[0.875rem] text-foreground placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-rule-2"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md bg-ink-800 px-1.5 py-0.5 text-[0.625rem] font-medium text-text-faint">
          ⌘K
        </kbd>
      </div>

      <nav className="space-y-0.5">{NAV_MAIN.map(item)}</nav>

      <p className="group-heading mb-1.5 mt-7 px-3">Beobachten</p>
      <nav className="space-y-0.5">{NAV_WATCH.map(item)}</nav>

      <div className="mt-auto space-y-2">
        {/* Onboarding: jede Marke per URL anschließen (Scout, Stufe 1). */}
        <form
          className="space-y-1.5 px-1"
          onSubmit={(e) => {
            e.preventDefault();
            const url = onboardUrl.trim();
            if (!url) return;
            onOnboard(url);
            setOnboardUrl("");
          }}
        >
          <input
            type="text"
            value={onboardUrl}
            onChange={(e) => setOnboardUrl(e.target.value)}
            placeholder="https://neue-brand.de"
            aria-label="Website der neuen Brand"
            disabled={onboarding}
            className="h-9 w-full rounded-xl bg-ink-850 px-3 text-[0.8125rem] text-foreground placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-rule-2 disabled:opacity-40"
          />
          <button
            type="submit"
            disabled={onboarding || onboardUrl.trim() === ""}
            className="inline-flex h-9 w-full items-center justify-center rounded-xl bg-ink-750 text-[0.8125rem] font-medium text-text-soft transition-colors hover:bg-rule hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {onboarding ? (
              <span className="animate-pulse">Scout startet …</span>
            ) : (
              "Brand hinzufügen"
            )}
          </button>
          {onboardError ? (
            <p className="px-1 text-[0.75rem] leading-snug text-signal-red">
              {onboardError}
            </p>
          ) : null}
        </form>

        {/* Brand-Switcher: der Fuß der Sidebar ist das Auswahlfeld. */}
        <div className="relative flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-ink-850">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ink-750 text-[0.6875rem] font-semibold text-text-soft">
            {(brandName ?? "··").slice(0, 2).toLowerCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.8125rem] text-foreground">
              {brandName ?? "lädt …"}
            </span>
            <span className="block truncate text-[0.6875rem] tnum text-text-faint">
              Ziel-CPA ≤ {targetCpa ?? "—"} €
            </span>
          </span>
          <ChevronsUpDown
            className="size-3.5 shrink-0 text-text-faint"
            strokeWidth={1.75}
          />
          <select
            value={brandSlug}
            onChange={(e) => onBrand(e.target.value)}
            aria-label="Brand wechseln"
            className="absolute inset-0 w-full cursor-pointer opacity-0"
          >
            {options.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------------- board -- */

function AngleRow({
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
  const [failed, setFailed] = useState<string | null>(null);
  const settling = useSettle(angle.status);

  const fire = async (key: string, url: string) => {
    setBusy(key);
    setFailed(null);
    try {
      await postAction(url);
      onChanged();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "unbekannter Fehler");
    } finally {
      setBusy(null);
    }
  };

  const showGate = angle.status === "draft";
  const showBuild = angle.status === "approved";

  return (
    <Surface className={settling ? "settle" : ""}>
      {/* No status dot here: the group heading above already names the status,
          and the row's job is to carry the two figures. */}
      <div className="flex items-start gap-5">
        <ArrowUpRight
          className="mt-1 size-4 shrink-0 text-text-faint"
          strokeWidth={1.75}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[1.0625rem] leading-relaxed">
            <span className="font-semibold text-foreground">{angle.name}</span>
            <span className="text-text-soft"> {angle.segment}</span>
          </p>

          {showGate || showBuild ? (
            <div className="mt-3 flex items-center gap-2">
              {showGate ? (
                <>
                  <QuietAction
                    label="Freigeben"
                    disabled={busy !== null}
                    onClick={() =>
                      fire("approve", `/api/angles/${angle.id}/approve`)
                    }
                  />
                  <QuietAction
                    tone="ghost"
                    label="Verwerfen"
                    disabled={busy !== null}
                    onClick={() => fire("kill", `/api/angles/${angle.id}/kill`)}
                  />
                </>
              ) : (
                <QuietAction
                  label={
                    busy === "assets" || pipelineRunning
                      ? "Material entsteht …"
                      : "Material erzeugen"
                  }
                  disabled={busy !== null || pipelineRunning}
                  onClick={() =>
                    fire("assets", `/api/angles/${angle.id}/assets/generate`)
                  }
                />
              )}
            </div>
          ) : null}
        </div>

        <CplPair expected={angle.expectedCpl} measured={angle.measuredCpl} />
      </div>

      {failed ? <ErrorNote text={`Konnte nicht gespeichert werden: ${failed}`} /> : null}
    </Surface>
  );
}

function BoardView({
  state,
  brandSlug,
  query,
  strategistRunning,
  runningAssetAngleIds,
  onChanged,
}: {
  state: BrandState | null;
  brandSlug: string;
  query: string;
  strategistRunning: boolean;
  runningAssetAngleIds: Set<string | undefined>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setFailed(null);
    try {
      // Route answers 202 immediately (#7); polling shows the progress.
      await postAction(`/api/brands/${brandSlug}/angles/generate`);
      onChanged();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "unbekannter Fehler");
    } finally {
      setBusy(false);
    }
  };

  const all = state?.angles ?? [];
  const visible = all.filter((a) =>
    matches(query, a.name, a.segment, a.pain, a.hookDirection),
  );

  const action = (
    <PrimaryAction
      label="Hypothesen anmelden"
      busyLabel="Strategist arbeitet …"
      busy={busy || strategistRunning}
      onClick={generate}
    />
  );

  if (all.length === 0) {
    return (
      <>
        <Hero
          title="Noch keine Hypothesen"
          lead="Der Strategist liest den Markenkontext — Seed oder Scout-Research — und meldet testbare Hypothesen an, jede mit ihrem erwarteten Preis pro Lead. Freigeben oder verwerfen entscheidest Du."
          action={action}
        />
        {failed ? <ErrorNote text={`Start fehlgeschlagen: ${failed}`} /> : null}
      </>
    );
  }

  return (
    <>
      <ViewHeader
        title="Hypothesen"
        lead="Der erwartete Preis pro Lead steht fest, bevor Budget fließt. Der gemessene stellt sich daneben."
        action={action}
      />
      {failed ? <ErrorNote text={`Start fehlgeschlagen: ${failed}`} /> : null}

      <div className="space-y-10">
        {ANGLE_BAYS.map((bay) => {
          const rows = visible.filter((a) => a.status === bay.status);
          if (rows.length === 0) return null;
          return (
            <section key={bay.status}>
              <GroupHeading label={bay.label} count={rows.length} />
              <div className="space-y-2">
                {rows.map((a) => (
                  <AngleRow
                    key={a.id}
                    angle={a}
                    pipelineRunning={runningAssetAngleIds.has(a.id)}
                    onChanged={onChanged}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {visible.length === 0 ? (
          <p className="py-8 text-center text-[0.875rem] text-text-faint">
            Keine Hypothese passt zu „{query}“.
          </p>
        ) : null}
      </div>
    </>
  );
}

/* --------------------------------------------------------------- studio -- */

function FeedFrame({
  imageUrl,
  brandName,
  headline,
  cta,
  angleName,
}: {
  imageUrl?: string;
  brandName: string;
  headline?: string;
  cta?: string;
  angleName: string;
}) {
  return (
    <div className="w-[188px] shrink-0 overflow-hidden rounded-xl bg-ink-750">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink-800 text-[0.5625rem] font-semibold text-text-soft">
          {brandName.slice(0, 2).toLowerCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.6875rem] font-medium">
            {brandName}
          </span>
          <span className="block text-[0.625rem] text-text-faint">
            Gesponsert
          </span>
        </span>
      </div>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={`Motiv für ${angleName}`}
          className="aspect-[4/5] w-full object-cover"
        />
      ) : (
        <div className="grid aspect-[4/5] place-items-center bg-ink-800 text-[0.6875rem] text-text-faint">
          kein Motiv
        </div>
      )}
      <div className="px-3 py-2.5">
        <p className="line-clamp-2 text-[0.6875rem] leading-snug text-text-soft">
          {headline ?? "—"}
        </p>
        {cta ? (
          <span className="mt-2 block truncate rounded-md bg-ink-800 px-2 py-1.5 text-center text-[0.625rem] font-medium">
            {cta}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AssetPair({
  angle,
  copyAsset,
  staticAsset,
  brandName,
  onChanged,
}: {
  angle: Angle;
  copyAsset?: Asset;
  staticAsset?: Asset;
  brandName: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const payload = (copyAsset?.payload ?? {}) as CopyAssetPayload;
  const variant = payload.variants?.[payload.chosenIndex ?? 0];
  const imageUrl = ((staticAsset?.payload ?? {}) as StaticAssetPayload).imageUrl;
  const status = copyAsset?.status ?? staticAsset?.status ?? "draft";
  const settling = useSettle(status);

  const act = async (action: "approve" | "reject") => {
    setBusy(true);
    setFailed(null);
    try {
      for (const asset of [copyAsset, staticAsset]) {
        if (!asset) continue;
        await postAction(`/api/assets/${asset.id}/${action}`);
      }
      onChanged();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "unbekannter Fehler");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface className={settling ? "settle" : ""}>
      <div className="flex gap-5">
        <FeedFrame
          imageUrl={imageUrl}
          brandName={brandName}
          headline={variant?.headline}
          cta={variant?.cta}
          angleName={angle.name}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <p className="min-w-0 flex-1 text-[0.9375rem] leading-relaxed">
              <span className="font-semibold text-foreground">{angle.name}</span>
              <span className="text-text-soft"> {angle.hookDirection}</span>
            </p>
            <span className="flex shrink-0 items-center gap-3 pt-1">
              {copyAsset?.criticScore === undefined ? null : (
                <span className="tnum text-[0.8125rem] text-text-soft">
                  Critic {copyAsset.criticScore}
                </span>
              )}
              <Dot tone={ASSET_DOT[status] ?? "bg-text-faint"} />
            </span>
          </div>

          {variant ? (
            <div className="mt-3 space-y-1.5">
              <p className="text-[1.0625rem] font-semibold leading-snug tracking-[-0.015em]">
                {variant.hook}
              </p>
              <p className="line-clamp-3 whitespace-pre-line text-[0.875rem] leading-relaxed text-text-soft">
                {variant.primary}
              </p>
            </div>
          ) : null}

          {copyAsset?.criticNotes ? (
            <p className="mt-3 line-clamp-2 text-[0.8125rem] leading-relaxed text-text-faint">
              {copyAsset.criticNotes}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {status === "draft" ? (
              <>
                <QuietAction
                  label="Freigeben"
                  disabled={busy}
                  onClick={() => act("approve")}
                />
                <QuietAction
                  tone="ghost"
                  label="Ablehnen"
                  disabled={busy}
                  onClick={() => act("reject")}
                />
              </>
            ) : null}
            {/* LP-Demo (Message-Match): Ad und Landingpage nebeneinander. */}
            <a
              href={`/lp/${angle.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-xl px-4 text-[0.8125rem] text-text-soft transition-colors hover:bg-ink-750 hover:text-foreground"
            >
              Landingpage ansehen
            </a>
          </div>

          {failed ? (
            <ErrorNote text={`Konnte nicht gespeichert werden: ${failed}`} />
          ) : null}
        </div>
      </div>
    </Surface>
  );
}

function StudioView({
  state,
  brandSlug,
  query,
  onChanged,
}: {
  state: BrandState | null;
  brandSlug: string;
  query: string;
  onChanged: () => void;
}) {
  const brandName = state?.brand.name ?? brandSlug;

  // One entry per angle that has assets.
  const pairs = (state?.angles ?? [])
    .map((angle) => {
      const assets = (state?.assets ?? []).filter((a) => a.angleId === angle.id);
      return {
        angle,
        copyAsset: assets.findLast((a) => a.kind === "ad_copy"),
        staticAsset: assets.findLast((a) => a.kind === "static"),
      };
    })
    .filter((p) => p.copyAsset || p.staticAsset);

  if (pairs.length === 0) {
    return (
      <Hero
        title="Noch kein Material"
        lead="Sobald Du im Board eine Hypothese freigibst und Material erzeugen lässt, stehen Motiv und Copy hier als Paar — so, wie sie im Feed erscheinen."
      />
    );
  }

  const visible = pairs.filter((p) => {
    const payload = (p.copyAsset?.payload ?? {}) as CopyAssetPayload;
    const variant = payload.variants?.[payload.chosenIndex ?? 0];
    return matches(query, p.angle.name, variant?.hook, variant?.headline);
  });

  return (
    <>
      <ViewHeader
        title="Material"
        lead="Motiv und Copy gehören zusammen und werden zusammen freigegeben. Der Critic hat vorher bewertet."
      />
      <div className="space-y-3">
        {visible.map((p) => (
          <AssetPair
            key={p.angle.id}
            angle={p.angle}
            copyAsset={p.copyAsset}
            staticAsset={p.staticAsset}
            brandName={brandName}
            onChanged={onChanged}
          />
        ))}
        {visible.length === 0 ? (
          <p className="py-8 text-center text-[0.875rem] text-text-faint">
            Kein Material passt zu „{query}“.
          </p>
        ) : null}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- flow -- */

// Rendered purely from runs in /state: a stage without a run says so.
function FlowView({ runs, query }: { runs: Run[]; query: string }) {
  const stages = FLOW_STAGES.filter((s) => matches(query, s.label, s.role));

  return (
    <>
      <ViewHeader
        title="Ablauf"
        lead="Sieben Agenten, drei Stellen, an denen ein Mensch entscheidet. Was hier steht, kommt aus den Läufen selbst."
      />

      <div className="space-y-2">
        {stages.map((stage, i) => {
          const stageRuns = runs
            .filter((r) => stage.stages.includes(r.stage))
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
          const last = stageRuns[0];
          const active = last ? isRunActive(last) : false;
          const failed = last?.status === "failed";
          const lastLine = last?.log?.at(-1);

          const tone = !last
            ? "bg-text-faint/40"
            : failed
              ? "bg-signal-red"
              : active
                ? "bg-mint animate-pulse"
                : "bg-foreground";

          const gate = GATE_AFTER[stage.key];

          return (
            <div key={stage.key}>
              <Surface>
                <div className="flex items-start gap-3">
                  <span className="pt-[0.45rem]">
                    <Dot tone={tone} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.9375rem] leading-relaxed">
                      <span className="font-semibold text-foreground">
                        {stage.label}
                      </span>
                      <span className="text-text-soft"> {stage.role}</span>
                    </p>
                    {last && lastLine ? (
                      <p className="mt-1.5 truncate text-[0.8125rem] text-text-faint">
                        {lastLine.message}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 pt-1 text-right">
                    <span className="block tnum text-[0.8125rem] text-text-soft">
                      {!last
                        ? "nie gelaufen"
                        : active
                          ? "läuft"
                          : failed
                            ? "fehlgeschlagen"
                            : ago(last.finishedAt ?? last.startedAt)}
                    </span>
                    {stageRuns.length > 1 ? (
                      <span className="block tnum text-[0.6875rem] text-text-faint">
                        {stageRuns.length} Läufe
                      </span>
                    ) : null}
                  </span>
                </div>
              </Surface>

              {i === stages.length - 1 ? null : gate ? (
                // A human gate interrupts the rail — that interruption is the
                // product promise, so it stays visible without borrowing mint.
                <div className="flex items-center gap-3 pl-5">
                  <span className="flex w-[7px] shrink-0 flex-col items-center">
                    <span className="h-3.5 w-px bg-rule-2" />
                    <span className="my-1.5 size-[7px] rounded-full border border-text-soft" />
                    <span className="h-3.5 w-px bg-rule-2" />
                  </span>
                  <span className="text-[0.8125rem] text-text-soft">{gate}</span>
                </div>
              ) : (
                <div className="ml-[23px] h-5 w-px bg-rule-2" />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* --------------------------------------------------------------- ticker -- */

function TickerView({
  lines,
  query,
}: {
  lines: (RunLogEntry & { runId: string })[];
  query: string;
}) {
  if (lines.length === 0) {
    return (
      <Hero
        title="Noch keine Läufe"
        lead="Hier schreiben die Agenten mit, sobald die erste Pipeline startet: wer gerade was tut, in der Reihenfolge, in der es passiert."
      />
    );
  }

  const visible = lines.filter((l) => matches(query, l.agent, l.message));

  return (
    <>
      <ViewHeader
        title="Ticker"
        lead="Die letzten hundert Zeilen aus allen Läufen, neueste zuerst."
      />
      <div className="space-y-1">
        {visible.map((line, i) => (
          <div
            key={`${line.runId}-${i}`}
            className="flex items-baseline gap-4 rounded-xl px-4 py-2.5 transition-colors hover:bg-ink-800"
          >
            <span className="shrink-0 font-mono text-[0.75rem] tnum text-text-faint">
              {clock(line.ts)}
            </span>
            <span className="w-[92px] shrink-0 truncate text-[0.8125rem] font-medium text-foreground">
              {line.agent}
            </span>
            <span
              className={`min-w-0 flex-1 text-[0.875rem] leading-relaxed ${
                line.level === "error"
                  ? "text-signal-red"
                  : line.level === "warn"
                    ? "text-signal-amber"
                    : "text-text-soft"
              }`}
            >
              {line.message}
            </span>
          </div>
        ))}
        {visible.length === 0 ? (
          <p className="py-8 text-center text-[0.875rem] text-text-faint">
            Keine Zeile passt zu „{query}“.
          </p>
        ) : null}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- shell -- */

export function MissionControl() {
  // Brand switcher: every brand in the store is selectable, loyft is default.
  const [brandSlug, setBrandSlug] = useState(DEFAULT_BRAND_SLUG);
  const [brands, setBrands] = useState<{ slug: string; name: string }[]>([]);
  const [state, setState] = useState<BrandState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>("board");
  const [query, setQuery] = useState("");
  // Onboarding: URL in, Scout runs async (202 + runId, #7), the UI switches
  // to the new brand and follows progress via /state polling.
  const [onboarding, setOnboarding] = useState(false);
  const [onboardError, setOnboardError] = useState<string | null>(null);

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

  const switchBrand = useCallback(
    (slug: string) => {
      setBrandSlug((current) => {
        if (slug === current) return current;
        setState(null);
        return slug;
      });
    },
    [],
  );

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
        // 202 (neu) und 409 brand_exists liefern beide den Slug — hinschalten.
        if (data.slug) {
          switchBrand(data.slug);
        } else {
          setOnboardError(data.error ?? `onboard ${res.status}`);
        }
      } catch (e) {
        setOnboardError(e instanceof Error ? e.message : "unbekannter Fehler");
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
  // Angles with an active assets run — drives the per-row busy state.
  const runningAssetAngleIds = new Set(
    runs.filter((r) => r.stage === "assets" && isRunActive(r)).map((r) => r.angleId),
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

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar
        view={view}
        onView={setView}
        query={query}
        onQuery={setQuery}
        brandName={state?.brand.name}
        targetCpa={state?.brand.targetCpa}
        brands={brands}
        brandSlug={brandSlug}
        onBrand={switchBrand}
        onboarding={onboarding}
        onboardError={onboardError}
        onOnboard={onboard}
      />

      <div className="min-w-0 flex-1">
        <header className="flex h-14 items-center px-8">
          <span className="text-[0.9375rem] font-semibold">
            {VIEW_TITLE[view]}
          </span>
          {scoutRunning ? (
            <span className="ml-6 animate-pulse text-[0.8125rem] text-text-soft">
              Scout liest die Marke …
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-2 text-[0.8125rem] text-text-faint">
            <span
              className={`size-[6px] rounded-full ${
                error
                  ? "bg-signal-red"
                  : state
                    ? "bg-text-faint"
                    : "bg-text-faint/40"
              }`}
            />
            {error ? "getrennt" : state ? "verbunden" : "lädt …"}
          </span>
        </header>

        <div className="mx-auto max-w-[780px] px-8 pb-24 pt-10">
          {error ? <ErrorNote text={`Zustand nicht erreichbar: ${error}`} /> : null}
          {failedRun ? (
            <ErrorNote
              text={`Letzter Lauf (${failedRun.stage}) fehlgeschlagen: ${
                failedRun.error ?? "unbekannter Fehler"
              } — Details im Ticker.`}
            />
          ) : null}

          {view === "board" ? (
            <BoardView
              state={state}
              brandSlug={brandSlug}
              query={query}
              strategistRunning={strategistRunning}
              runningAssetAngleIds={runningAssetAngleIds}
              onChanged={load}
            />
          ) : null}
          {view === "studio" ? (
            <StudioView
              state={state}
              brandSlug={brandSlug}
              query={query}
              onChanged={load}
            />
          ) : null}
          {view === "flow" ? <FlowView runs={runs} query={query} /> : null}
          {view === "ticker" ? (
            <TickerView lines={tickerLines} query={query} />
          ) : null}
          {view === "economics" ? (
            // Key remounts the tab on brand switch so analysis state resets.
            <EconomicsTab key={brandSlug} state={state} brandSlug={brandSlug} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
