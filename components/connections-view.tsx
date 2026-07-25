"use client";

// Verbindungen (Personalisieren): the ONLY place in the UI that talks about
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
  { key: "meta", name: "Meta", role: "Kampagnen, Ads und Insights" },
  { key: "fal", name: "Fal", role: "Bildgenerierung für Motive" },
  { key: "firecrawl", name: "Firecrawl", role: "Website-Research des Scouts" },
  { key: "elevenlabs", name: "ElevenLabs", role: "Sprachausgabe" },
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
        title="Verbindungen"
        lead="Die Dienste, mit denen die Agenten arbeiten."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {SERVICES.map((service) => {
          const live = statuses?.[service.key];
          return (
            <div key={service.key} className="surface p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[1.0625rem] font-semibold tracking-[-0.015em]">
                    {service.name}
                  </p>
                  <p className="mt-1 text-[0.875rem] leading-relaxed text-ink-soft">
                    {service.role}
                  </p>
                </div>
                {live?.connected !== undefined ? (
                  <span
                    className={`mt-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.75rem] font-medium ${
                      live.connected
                        ? "bg-positive/10 text-positive"
                        : "bg-negative/10 text-negative"
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${
                        live.connected ? "bg-positive" : "bg-negative"
                      }`}
                    />
                    {live.connected ? "verbunden" : "getrennt"}
                  </span>
                ) : null}
              </div>
              <p className="mt-4 text-[0.8125rem] text-ink-faint">
                {live?.detail ?? "konfiguriert über Umgebungsvariablen"}
              </p>
            </div>
          );
        })}
      </div>
    </>
  );
}
