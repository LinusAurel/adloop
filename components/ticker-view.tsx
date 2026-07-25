"use client";

// Ticker: the last hundred log lines from all runs, newest first.

import type { RunLogEntry } from "@/engine/types";
import { Hero, ViewHeader } from "@/components/bits";
import { clock } from "@/lib/format";

export function TickerView({
  lines,
}: {
  lines: (RunLogEntry & { runId: string })[];
}) {
  if (lines.length === 0) {
    return (
      <Hero
        title="Noch keine Läufe"
        lead="Hier schreiben die Agenten mit, sobald die erste Pipeline startet: wer gerade was tut, in der Reihenfolge, in der es passiert."
      />
    );
  }

  return (
    <>
      <ViewHeader
        title="Ticker"
        lead="Die letzten hundert Zeilen aus allen Läufen, neueste zuerst."
      />
      <div className="space-y-1">
        {lines.map((line, i) => (
          <div
            key={`${line.runId}-${i}`}
            className="flex items-baseline gap-4 rounded-xl px-4 py-2.5 transition-colors hover:bg-sink/50"
          >
            <span className="shrink-0 font-mono text-[0.75rem] tnum text-ink-faint">
              {clock(line.ts)}
            </span>
            <span className="w-[92px] shrink-0 truncate text-[0.8125rem] font-medium text-ink">
              {line.agent}
            </span>
            <span
              className={`min-w-0 flex-1 text-[0.875rem] leading-relaxed ${
                line.level === "error"
                  ? "text-negative"
                  : line.level === "warn"
                    ? "text-warn"
                    : "text-ink-soft"
              }`}
            >
              {line.message}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
