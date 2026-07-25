"use client";

// Ticker: the last hundred log lines from all runs, newest first. Log
// content renders verbatim from the run data.

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
        title="No runs yet"
        lead="The agents write here as soon as the first pipeline starts: who is doing what, in the order it happens."
      />
    );
  }

  return (
    <>
      <ViewHeader
        title="Ticker"
        lead="The last hundred lines from all runs, newest first."
      />
      <div className="space-y-1">
        {lines.map((line, i) => (
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
      </div>
    </>
  );
}
