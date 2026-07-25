"use client";

// ⌘K palette: navigate the few areas, jump to a brand or an angle. Pure
// client-side filter over data that /state already delivered — no own fetch.

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { BrandState } from "@/engine/types";
import type { ViewKey } from "@/components/app-shell";
import type { BrandListEntry } from "@/components/sidebar";
import { matches } from "@/lib/format";

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  detail?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  state,
  brands,
  onView,
  onBrand,
}: {
  open: boolean;
  onClose: () => void;
  state: BrandState | null;
  brands: BrandListEntry[];
  onView: (v: ViewKey) => void;
  onBrand: (slug: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const nav: { key: ViewKey; label: string }[] = [
      { key: "chat", label: "Chat" },
      { key: "board", label: "Board" },
      { key: "studio", label: "Studio" },
      { key: "economics", label: "Economics" },
      { key: "ticker", label: "Ticker" },
      { key: "brand", label: "Brand Profile" },
      { key: "connections", label: "Connections" },
    ];
    const all: PaletteItem[] = [
      ...nav.map((n) => ({
        id: `nav-${n.key}`,
        group: "Areas",
        label: n.label,
        run: () => onView(n.key),
      })),
      ...brands.map((b) => ({
        id: `brand-${b.slug}`,
        group: "Brands",
        label: b.name,
        detail: "Switch brand",
        run: () => onBrand(b.slug),
      })),
      ...(state?.angles ?? []).map((a) => ({
        id: `angle-${a.id}`,
        group: "Angles",
        label: a.name,
        detail: a.segment,
        run: () => onView("board"),
      })),
    ];
    return all.filter((i) => matches(query, i.label, i.detail, i.group));
  }, [query, state, brands, onView, onBrand]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      // Focus after the overlay painted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  // Keyboard control sits on the window while the palette is open, so
  // arrows and Enter work regardless of where the focus currently is.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[index];
        if (item) {
          item.run();
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, index, onClose]);

  if (!open) return null;

  const pick = (item?: PaletteItem) => {
    if (!item) return;
    item.run();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-6 pt-[16vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[560px] overflow-hidden rounded-2xl bg-ink-800">
        <div className="flex items-center gap-3 border-b border-rule px-5">
          <Search
            className="size-4 shrink-0 text-text-faint"
            strokeWidth={1.75}
          />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search areas, brands or angles…"
            aria-label="Search"
            className="h-13 w-full bg-transparent py-4 text-[0.9375rem] text-foreground placeholder:text-text-faint focus:outline-none"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto p-2">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-[0.875rem] text-text-faint">
              Nothing matches your search.
            </p>
          ) : (
            items.slice(0, 30).map((item, i) => (
              <button
                key={item.id}
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(item)}
                className={`flex w-full items-baseline gap-3 rounded-xl px-3 py-2.5 text-left text-[0.875rem] transition-colors ${
                  i === index ? "bg-ink-750" : ""
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {item.label}
                </span>
                {item.detail ? (
                  <span className="truncate text-[0.75rem] text-text-faint">
                    {item.detail}
                  </span>
                ) : null}
                <span className="shrink-0 text-[0.6875rem] uppercase tracking-wide text-text-faint/70">
                  {item.group}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
