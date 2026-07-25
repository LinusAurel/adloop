"use client";

// Shared atoms of the app shell. Direction contract (DESIGN.md): dark ink
// ground, soft strongly rounded surfaces, mint as the one strong action,
// decisions carry colour (approve mint filled, reject red outline).

import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------- requests -- */

export interface ActionResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

// Every click either changes something visible or names why it did not.
// Returns status + parsed body so callers can bind routes defensively
// (404/405/501 -> feature not available yet).
export async function postAction(
  url: string,
  payload?: unknown,
): Promise<ActionResult> {
  const res = await fetch(url, {
    method: "POST",
    ...(payload !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }
      : {}),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* keep the status code */
  }
  return { ok: res.ok, status: res.status, body };
}

export function actionError(result: ActionResult): string {
  const err = result.body.error;
  return typeof err === "string" ? err : `status ${result.status}`;
}

/* ---------------------------------------------------------------- hooks -- */

// The one authored moment: an entry settles when its status really changed,
// not on every mount and not on every poll.
export function useSettle(status: string): boolean {
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

/* -------------------------------------------------------------- buttons -- */

// The one strong element per view: the primary action (muted emerald — mint
// is reserved for brand accents).
export function PillButton({
  label,
  busyLabel,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="inline-flex h-11 shrink-0 items-center rounded-2xl bg-emerald-600 px-6 text-[0.9375rem] font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-45"
    >
      {busy ? (
        <span className="animate-pulse">{busyLabel ?? label}</span>
      ) : (
        label
      )}
    </button>
  );
}

// Coloured decision buttons: approve is filled emerald, reject red outline.
// Quiet is the neutral secondary action.
export function ActionButton({
  label,
  tone,
  onClick,
  disabled,
  small,
}: {
  label: string;
  tone: "approve" | "reject" | "quiet";
  onClick: () => void;
  disabled?: boolean;
  small?: boolean;
}) {
  const skin =
    tone === "approve"
      ? "bg-emerald-600 font-semibold text-white hover:bg-emerald-500"
      : tone === "reject"
        ? "border border-signal-red/50 font-medium text-signal-red hover:bg-signal-red/10"
        : "bg-ink-750 font-medium text-foreground hover:bg-rule";
  const size = small
    ? "h-8 px-3.5 text-[0.8125rem]"
    : "h-9 px-4 text-[0.875rem]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center rounded-xl transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${size} ${skin}`}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------- surfaces -- */

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`rounded-2xl bg-ink-800 ${className}`}>{children}</div>;
}

export function GroupHeading({
  label,
  count,
}: {
  label: string;
  count?: number;
}) {
  return (
    <p className="group-heading mb-3 px-1">
      {label}
      {count === undefined ? null : (
        <span className="ml-1.5 tnum text-text-faint/70">{count}</span>
      )}
    </p>
  );
}

export function ViewHeader({
  title,
  lead,
  action,
}: {
  title: string;
  lead?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-10 flex items-start justify-between gap-8">
      <div className="min-w-0">
        <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em]">
          {title}
        </h1>
        {lead ? (
          <p className="mt-2 max-w-[52ch] text-[0.9375rem] leading-relaxed text-text-soft">
            {lead}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0 pt-1">{action}</div> : null}
    </header>
  );
}

// Centred empty state: one line, one sentence, one action. It is the normal
// state before the first run — not an error.
export function Hero({
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

export function ErrorNote({ text }: { text: string }) {
  return (
    <p className="mt-3 rounded-xl bg-signal-red/10 px-4 py-2.5 text-[0.8125rem] text-signal-red">
      {text}
    </p>
  );
}
