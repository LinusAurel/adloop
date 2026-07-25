"use client";

// Connections (Personalize): the ONLY place in the UI that talks about
// connection status. Reads GET /api/connections; the Configure dialog stores
// a key via POST /api/connections into data/settings.json (gitignored).
// Env vars stay the primary source for the engine connectors — settings.json
// as a connector fallback is a follow-up step.

import { useEffect, useState } from "react";
import { ErrorNote, PillButton, ViewHeader } from "@/components/bits";

interface ServiceCard {
  id: string;
  name: string;
  role: string;
}

const SERVICES: ServiceCard[] = [
  { id: "meta", name: "Meta", role: "Publishes campaigns as paused ads" },
  { id: "fal", name: "Fal", role: "Generates the ad visuals" },
  { id: "firecrawl", name: "Firecrawl", role: "Researches brand websites for the Scout" },
  { id: "elevenlabs", name: "ElevenLabs", role: "Speaks the daily briefing" },
  { id: "anthropic", name: "Anthropic", role: "Powers the strategist, copywriter and critic" },
];

type Status = "connected" | "connected (stored locally)" | "not configured";
type StatusMap = Record<string, Status>;

// Monochrome wordmark badge, built in-house: initial in a circle + name.
// Deliberately no third-party logo assets.
function WordmarkBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="flex size-9 items-center justify-center rounded-full border border-rule bg-ink-750 text-[0.9375rem] font-semibold text-foreground">
        {name.charAt(0)}
      </span>
      <span className="text-[1.0625rem] font-semibold tracking-[-0.015em]">
        {name}
      </span>
    </span>
  );
}

function StatusPill({ status }: { status: Status | undefined }) {
  const connected = status !== undefined && status !== "not configured";
  return (
    <span className="mt-1 inline-flex items-center gap-1.5 text-[0.75rem] font-medium text-text-soft">
      <span
        className={`size-1.5 rounded-full ${
          connected ? "bg-mint/70" : "bg-text-faint/50"
        }`}
      />
      {status ?? "checking…"}
    </span>
  );
}

function ConfigureDialog({
  service,
  onClose,
  onStored,
}: {
  service: ServiceCard;
  onClose: () => void;
  onStored: (id: string, status: Status) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: service.id, key }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        status?: Status;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      onStored(service.id, body.status ?? "connected (stored locally)");
      onClose();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "unknown error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-ink-800 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[1.0625rem] font-semibold tracking-[-0.015em]">
          Configure {service.name}
        </p>
        <p className="mt-1 text-[0.8125rem] leading-relaxed text-text-soft">
          The key is stored locally in <code>data/settings.json</code> and never
          committed. Environment variables remain the primary source.
        </p>
        <input
          type="password"
          autoFocus
          value={key}
          placeholder="API key"
          autoComplete="off"
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && key.trim() !== "" && !busy) void save();
            if (e.key === "Escape") onClose();
          }}
          className="mt-4 w-full rounded-xl bg-ink-750 px-4 py-2.5 text-[0.9375rem] text-foreground placeholder:text-text-faint focus:outline-none"
        />
        {failed ? <ErrorNote text={`Could not save: ${failed}`} /> : null}
        <div className="mt-4 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-[0.8125rem] font-medium text-text-soft hover:text-foreground"
          >
            Cancel
          </button>
          <PillButton
            label="Save key"
            busyLabel="saving…"
            busy={busy}
            disabled={key.trim() === ""}
            onClick={() => void save()}
          />
        </div>
      </div>
    </div>
  );
}

export function ConnectionsView() {
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [configuring, setConfiguring] = useState<ServiceCard | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/connections", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as {
          connections?: { id: string; status: Status }[];
        };
        if (!cancelled && body.connections) {
          setStatuses(
            Object.fromEntries(body.connections.map((c) => [c.id, c.status])),
          );
        }
      } catch {
        /* cards fall back to "checking…" */
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
        {SERVICES.map((service) => (
          <div key={service.id} className="rounded-2xl bg-ink-800 p-6">
            <div className="flex items-start justify-between gap-4">
              <WordmarkBadge name={service.name} />
              <StatusPill status={statuses[service.id]} />
            </div>
            <p className="mt-4 text-[0.875rem] leading-relaxed text-text-soft">
              {service.role}
            </p>
            <button
              type="button"
              onClick={() => setConfiguring(service)}
              className="mt-4 rounded-lg bg-ink-750 px-3 py-1.5 text-[0.8125rem] font-medium text-text-soft transition-colors hover:text-foreground"
            >
              Configure
            </button>
          </div>
        ))}
      </div>
      {configuring ? (
        <ConfigureDialog
          service={configuring}
          onClose={() => setConfiguring(null)}
          onStored={(id, status) =>
            setStatuses((prev) => ({ ...prev, [id]: status }))
          }
        />
      ) : null}
    </>
  );
}
