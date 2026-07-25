"use client";

// Connections (Personalize): the ONLY place in the UI that talks about
// connection status. Reads GET /api/connections if the engine stream shipped
// it; otherwise the cards state the static truth: configured via env vars.

import { useEffect, useState } from "react";
import { ViewHeader } from "@/components/bits";

interface ConnectionCard {
  key: string;
  name: string;
  role: string;
}

const SERVICES: ConnectionCard[] = [
  { key: "meta", name: "Meta", role: "Campaigns, ads and insights" },
  { key: "fal", name: "Fal", role: "Image generation for ad visuals" },
  { key: "firecrawl", name: "Firecrawl", role: "Website research for the Scout" },
  { key: "elevenlabs", name: "ElevenLabs", role: "Voice output" },
];

type StatusMap = Record<string, { connected?: boolean; detail?: string }>;

export function ConnectionsView() {
  // null = no live endpoint (static fallback), otherwise per-service status.
  const [statuses, setStatuses] = useState<StatusMap | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/connections", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as {
          connections?: StatusMap;
        } & StatusMap;
        if (!cancelled) setStatuses(body.connections ?? body);
      } catch {
        /* static fallback stays */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <ViewHeader
        title="Connections"
        lead="The services the agents work with."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {SERVICES.map((service) => {
          const live = statuses?.[service.key];
          return (
            <div key={service.key} className="rounded-2xl bg-ink-800 p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[1.0625rem] font-semibold tracking-[-0.015em]">
                    {service.name}
                  </p>
                  <p className="mt-1 text-[0.875rem] leading-relaxed text-text-soft">
                    {service.role}
                  </p>
                </div>
                {live?.connected !== undefined ? (
                  <span
                    className={`mt-1 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[0.75rem] font-medium ${
                      live.connected
                        ? "bg-mint/10 text-mint"
                        : "bg-signal-red/10 text-signal-red"
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${
                        live.connected ? "bg-mint" : "bg-signal-red"
                      }`}
                    />
                    {live.connected ? "connected" : "disconnected"}
                  </span>
                ) : null}
              </div>
              <p className="mt-4 text-[0.8125rem] text-text-faint">
                {live?.detail ?? "configured via environment variables"}
              </p>
            </div>
          );
        })}
      </div>
    </>
  );
}
