"use client";

// Quiet sidebar: new chat + search on top, few clear areas, brand as context
// at the bottom. The brand switcher is a branded popover (wordmark + accent
// avatar), never a bare select; onboarding lives in a dialog behind
// "New brand…" — no permanent URL field.

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Image as ImageIcon,
  MessageSquare,
  PanelLeft,
  Plug,
  Plus,
  Search,
  SquareKanban,
  TrendingUp,
  User,
} from "lucide-react";
import type { ViewKey } from "@/components/app-shell";
import { onAccent } from "@/lib/brand-accent";

const NAV_MAIN: { key: ViewKey; label: string; Icon: typeof Activity }[] = [
  { key: "chat", label: "Chat", Icon: MessageSquare },
  { key: "board", label: "Board", Icon: SquareKanban },
  { key: "studio", label: "Studio", Icon: ImageIcon },
  { key: "economics", label: "Economics", Icon: TrendingUp },
  { key: "ticker", label: "Ticker", Icon: Activity },
];

const NAV_PERSONAL: { key: ViewKey; label: string; Icon: typeof Activity }[] = [
  { key: "brand", label: "Brand Profile", Icon: User },
  { key: "connections", label: "Connections", Icon: Plug },
];

export interface BrandListEntry {
  slug: string;
  name: string;
}

export function Sidebar({
  view,
  onView,
  collapsed,
  onToggleCollapsed,
  onNewChat,
  onOpenPalette,
  brands,
  brandSlug,
  brandName,
  accent,
  onBrand,
  onboarding,
  onboardError,
  onOnboard,
}: {
  view: ViewKey;
  onView: (v: ViewKey) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNewChat: () => void;
  onOpenPalette: () => void;
  brands: BrandListEntry[];
  brandSlug: string;
  brandName?: string;
  accent: string;
  onBrand: (slug: string) => void;
  onboarding: boolean;
  onboardError: string | null;
  onOnboard: (url: string) => void;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [url, setUrl] = useState("");
  const footRef = useRef<HTMLDivElement>(null);

  // Every brand in the store is selectable; an unknown slug (fresh onboard)
  // still renders so the switcher never jumps back to another brand.
  const options = brands.some((b) => b.slug === brandSlug)
    ? brands
    : [...brands, { slug: brandSlug, name: brandName ?? brandSlug }];

  useEffect(() => {
    if (!switcherOpen) return;
    const close = (e: MouseEvent) => {
      if (!footRef.current?.contains(e.target as Node)) setSwitcherOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSwitcherOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [switcherOpen]);

  const display = brandName ?? brandSlug;

  const navItem = (entry: {
    key: ViewKey;
    label: string;
    Icon: typeof Activity;
  }) => {
    const active = view === entry.key;
    return (
      <button
        key={entry.key}
        type="button"
        onClick={() => onView(entry.key)}
        title={collapsed ? entry.label : undefined}
        className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[0.875rem] transition-colors ${
          active
            ? "bg-ink-800 font-medium text-foreground"
            : "text-text-soft hover:bg-ink-850 hover:text-foreground"
        } ${collapsed ? "justify-center px-0" : ""}`}
      >
        <entry.Icon
          className="size-[15px] shrink-0"
          strokeWidth={1.75}
          style={active ? { color: accent } : undefined}
        />
        {collapsed ? null : entry.label}
      </button>
    );
  };

  return (
    <aside
      className={`sticky top-0 flex h-screen shrink-0 flex-col bg-ink-900 px-3 py-4 transition-[width] duration-200 ${
        collapsed ? "w-[64px]" : "w-[240px]"
      }`}
    >
      <div
        className={`mb-5 flex items-center px-3 pt-1 ${collapsed ? "justify-center px-0" : "justify-between"}`}
      >
        {collapsed ? null : (
          <p className="text-[0.9375rem] font-semibold tracking-[-0.02em]">
            adloop
          </p>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="rounded-lg p-1.5 text-text-faint transition-colors hover:bg-ink-850 hover:text-foreground"
        >
          <PanelLeft className="size-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="mb-6 space-y-0.5">
        <button
          type="button"
          onClick={onNewChat}
          title={collapsed ? "New" : undefined}
          className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[0.875rem] font-medium text-foreground transition-colors hover:bg-ink-850 ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <Plus className="size-[15px] shrink-0" strokeWidth={2} />
          {collapsed ? null : "New"}
        </button>
        <button
          type="button"
          onClick={onOpenPalette}
          title={collapsed ? "Search" : undefined}
          className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[0.875rem] text-text-soft transition-colors hover:bg-ink-850 hover:text-foreground ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <Search className="size-[15px] shrink-0" strokeWidth={1.75} />
          {collapsed ? null : (
            <>
              <span className="flex-1">Search</span>
              <kbd className="rounded-md bg-ink-800 px-1.5 py-0.5 text-[0.625rem] font-medium text-text-faint">
                ⌘K
              </kbd>
            </>
          )}
        </button>
      </div>

      <nav className="space-y-0.5">{NAV_MAIN.map(navItem)}</nav>

      {collapsed ? (
        <div className="my-4 border-t border-rule" />
      ) : (
        <p className="group-heading mb-1.5 mt-7 px-3">Personalize</p>
      )}
      <nav className="space-y-0.5">{NAV_PERSONAL.map(navItem)}</nav>

      {/* Brand foot: wordmark + accent avatar opens the switcher popover. */}
      <div ref={footRef} className="relative mt-auto">
        {switcherOpen ? (
          <div className="absolute bottom-full left-0 z-30 mb-2 w-[216px] rounded-2xl bg-ink-750 p-1.5">
            <p className="group-heading px-2.5 pb-1 pt-1.5">Brands</p>
            {options.map((b) => (
              <button
                key={b.slug}
                type="button"
                onClick={() => {
                  setSwitcherOpen(false);
                  onBrand(b.slug);
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.875rem] transition-colors hover:bg-ink-800 ${
                  b.slug === brandSlug
                    ? "font-medium text-foreground"
                    : "text-text-soft"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                {b.slug === brandSlug ? (
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ background: accent }}
                  />
                ) : null}
              </button>
            ))}
            <div className="my-1.5 border-t border-rule" />
            <button
              type="button"
              onClick={() => {
                setSwitcherOpen(false);
                setDialogOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[0.875rem] text-text-soft transition-colors hover:bg-ink-800 hover:text-foreground"
            >
              <Plus className="size-3.5" strokeWidth={2} />
              New brand…
            </button>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setSwitcherOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={switcherOpen}
          title={collapsed ? display : undefined}
          className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-ink-850 ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <span
            className="grid size-7 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold"
            style={{ background: accent, color: onAccent(accent) }}
          >
            {display.slice(0, 1).toUpperCase()}
          </span>
          {collapsed ? null : (
            <span
              className="min-w-0 flex-1 truncate text-left text-[0.9375rem] font-semibold tracking-[-0.01em]"
              style={{ color: accent }}
            >
              {display}
            </span>
          )}
        </button>
      </div>

      {/* Onboarding dialog: URL in, Scout runs async (202 + runId). */}
      {dialogOpen ? (
        <div
          className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-6"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDialogOpen(false);
          }}
        >
          <div className="w-full max-w-[420px] rounded-3xl bg-ink-800 p-6">
            <h2 className="text-[1.125rem] font-semibold tracking-[-0.02em]">
              Add a new brand
            </h2>
            <p className="mt-1.5 text-[0.875rem] leading-relaxed text-text-soft">
              The Scout reads the website and builds the brand profile.
            </p>
            <form
              className="mt-5 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = url.trim();
                if (!trimmed) return;
                onOnboard(trimmed);
                setUrl("");
                setDialogOpen(false);
              }}
            >
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://new-brand.com"
                aria-label="Website of the new brand"
                autoFocus
                disabled={onboarding}
                className="h-11 w-full rounded-xl bg-ink-750 px-4 text-[0.9375rem] text-foreground placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-rule-2 disabled:opacity-40"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDialogOpen(false)}
                  className="inline-flex h-10 items-center rounded-xl px-4 text-[0.875rem] text-text-soft transition-colors hover:bg-ink-750 hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={onboarding || url.trim() === ""}
                  className="inline-flex h-10 items-center rounded-xl bg-emerald-600 px-5 text-[0.875rem] font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {onboarding ? (
                    <span className="animate-pulse">Scout starting…</span>
                  ) : (
                    "Add brand"
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {onboardError && !collapsed ? (
        <p className="mt-2 px-2 text-[0.75rem] leading-snug text-signal-red">
          {onboardError}
        </p>
      ) : null}
    </aside>
  );
}
