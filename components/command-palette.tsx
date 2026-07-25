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
      { key: "economics", label: "Wirtschaftlichkeit" },
      { key: "ticker", label: "Ticker" },
      { key: "brand", label: "Brand-Profil" },
      { key: "connections", label: "Verbindungen" },
    ];
    const all: PaletteItem[] = [
      ...nav.map((n) => ({
        id: `nav-${n.key}`,
        group: "Bereiche",
        label: n.label,
        run: () => onView(n.key),
      })),
      ...brands.map((b) => ({
        id: `brand-${b.slug}`,
        group: "Brands",
        label: b.name,
        detail: "Brand wechseln",
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

  if (!open) return null;

  const pick = (item?: PaletteItem) => {
    if (!item) return;
    item.run();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 px-6 pt-[16vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="surface w-full max-w-[560px] overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b border-rule px-5">
          <Search className="size-4 shrink-0 text-ink-faint" strokeWidth={1.75} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, items.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              }
              if (e.key === "Enter") pick(items[index]);
            }}
            placeholder="Bereich, Brand oder Angle suchen …"
            aria-label="Suchen"
            className="h-13 w-full bg-transparent py-4 text-[0.9375rem] text-ink placeholder:text-ink-faint focus:outline-none"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto p-2">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-[0.875rem] text-ink-faint">
              Nichts gefunden zu „{query}“.
            </p>
          ) : (
            items.slice(0, 30).map((item, i) => (
              <button
                key={item.id}
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(item)}
                className={`flex w-full items-baseline gap-3 rounded-xl px-3 py-2.5 text-left text-[0.875rem] transition-colors ${
                  i === index ? "bg-sink text-ink" : "text-ink-soft"
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-medium text-ink">
                  {item.label}
                </span>
                {item.detail ? (
                  <span className="truncate text-[0.75rem] text-ink-faint">
                    {item.detail}
                  </span>
                ) : null}
                <span className="shrink-0 text-[0.6875rem] uppercase tracking-wide text-ink-faint/70">
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
