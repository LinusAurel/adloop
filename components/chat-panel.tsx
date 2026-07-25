"use client";

/*
  ChatPanel (#16) — the heart of the platform: the user steers the whole
  engine in dialogue. Before the first message the panel is a calm, centred
  entry ("What should we work on?") with contextual suggestion chips derived
  from the brand state; afterwards it is a classic chat view. Executed tool
  actions appear as small badges under the assistant reply. Design tokens
  come from app/globals.css; quiet surfaces, lots of whitespace, no emojis.
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import type { BrandState } from "@/engine/types";

interface ChatAction {
  type: string;
  label: string;
}

// Clickable references (angles/assets) the reply talks about; clicking one
// dispatches an app-wide event that opens the board detail or the studio.
interface ChatRef {
  type: "angle" | "asset";
  id: string;
  label: string;
}

interface PanelMessage {
  role: "user" | "assistant";
  content: string;
  actions?: ChatAction[];
  refs?: ChatRef[];
}

interface Suggestion {
  label: string;
  prompt: string;
}

// Per-brand persistence (#16): the conversation survives view switches and
// reloads. Key mirrors app-shell's "+ New" handler, which clears it.
const MAX_PERSISTED_MESSAGES = 50;

function chatStorageKey(brandSlug: string): string {
  return `adloop_chat_${brandSlug}`;
}

// Defensive restore: broken JSON or unexpected shapes yield an empty history.
function restoreMessages(brandSlug: string): PanelMessage[] {
  try {
    const raw = window.localStorage.getItem(chatStorageKey(brandSlug));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is PanelMessage =>
          typeof m === "object" &&
          m !== null &&
          ((m as PanelMessage).role === "user" ||
            (m as PanelMessage).role === "assistant") &&
          typeof (m as PanelMessage).content === "string",
      )
      .map((m) => ({
        role: m.role,
        content: m.content,
        // Keep refs/actions so chips stay clickable after a restore.
        actions: Array.isArray(m.actions) ? m.actions : undefined,
        refs: Array.isArray(m.refs) ? m.refs : undefined,
      }))
      .slice(-MAX_PERSISTED_MESSAGES);
  } catch {
    return [];
  }
}

function persistMessages(brandSlug: string, messages: PanelMessage[]) {
  try {
    const key = chatStorageKey(brandSlug);
    if (messages.length === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(
        key,
        JSON.stringify(messages.slice(-MAX_PERSISTED_MESSAGES)),
      );
    }
  } catch {
    /* quota/private mode — persistence is best effort */
  }
}

// Contextual chips: derived from the state, never more than four.
function buildSuggestions(state: BrandState | null): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const angles = state?.angles ?? [];
  const assets = state?.assets ?? [];

  const draftAssets = assets.filter((a) => a.status === "draft");
  if (draftAssets.length > 0) {
    suggestions.push({
      label: `${draftAssets.length} asset${draftAssets.length === 1 ? "" : "s"} waiting for approval — review now`,
      prompt: "Show me the assets waiting for approval and give me your recommendation.",
    });
  }

  const draftAngles = angles.filter((a) => a.status === "draft");
  if (draftAngles.length > 0) {
    suggestions.push({
      label: `${draftAngles.length} ${draftAngles.length === 1 ? "hypothesis" : "hypotheses"} waiting for your decision`,
      prompt: "Walk me through the open hypotheses — which ones would you approve, and why?",
    });
  }

  if (angles.length === 0) {
    suggestions.push({
      label: "Generate new angles from the research",
      prompt: "Start the Strategist and register new angle hypotheses.",
    });
  }

  const approvedAssets = assets.filter((a) => a.status === "approved");
  if (approvedAssets.length > 0) {
    suggestions.push({
      label: "Publish the campaign (launches paused)",
      prompt: "Publish the approved assets as a campaign — paused, as always.",
    });
  }

  suggestions.push({
    label: "How is the brand doing right now?",
    prompt: "Give me a quick overview: where do we stand, and what would be the most sensible next step?",
  });

  return suggestions.slice(0, 4);
}

function openRef(ref: ChatRef) {
  if (ref.type === "angle") {
    window.dispatchEvent(new CustomEvent("adloop:open-angle", { detail: { angleId: ref.id } }));
  } else {
    window.dispatchEvent(new CustomEvent("adloop:open-asset", { detail: { assetId: ref.id } }));
  }
}

function RefChips({ refs }: { refs?: ChatRef[] }) {
  if (!refs || refs.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {refs.map((ref) => (
        <button
          key={`${ref.type}-${ref.id}`}
          type="button"
          onClick={() => openRef(ref)}
          className="inline-flex items-center gap-1 rounded-full border border-rule px-2.5 py-1 text-[0.6875rem] font-medium text-text-soft transition-colors hover:bg-ink-750 hover:text-foreground"
        >
          <span className="text-text-faint">{ref.type === "angle" ? "Angle" : "Asset"}</span>
          {ref.label}
        </button>
      ))}
    </div>
  );
}

function ActionBadges({ actions }: { actions?: ChatAction[] }) {
  if (!actions || actions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {actions.map((action, i) => (
        <span
          key={`${action.type}-${i}`}
          className="inline-flex items-center rounded-full bg-ink-800 px-2.5 py-1 text-[0.6875rem] font-medium text-text-soft"
        >
          {action.label}
        </span>
      ))}
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  autoFocus?: boolean;
}) {
  return (
    <form
      className="flex w-full items-center gap-2 rounded-full bg-ink-750 py-1.5 pl-5 pr-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="What should we work on?"
        aria-label="Message the campaign strategist"
        disabled={busy}
        autoFocus={autoFocus}
        className="h-9 min-w-0 flex-1 bg-transparent text-[0.9375rem] text-foreground placeholder:text-text-faint focus:outline-none disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={busy || value.trim() === ""}
        aria-label="Send"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-emerald-600 text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-35"
      >
        <ArrowUp className="size-4" strokeWidth={2} />
      </button>
    </form>
  );
}

export function ChatPanel({
  brandSlug,
  onStateChanged,
}: {
  brandSlug: string;
  onStateChanged?: () => void;
}) {
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<BrandState | null>(null);
  // True once the persisted history was restored — gates rendering (no hero
  // flash when a history exists) and gates writing (never clobber storage
  // with the initial empty array before the restore ran).
  const [hydrated, setHydrated] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Chips come from the live state; refreshed after every state change.
  const loadState = useCallback(async () => {
    try {
      const res = await fetch(`/api/brands/${brandSlug}/state`, { cache: "no-store" });
      if (res.ok) setState((await res.json()) as BrandState);
    } catch {
      /* chips are optional — the composer works without them */
    }
  }, [brandSlug]);

  // A brand switch resets the panel (the shell also remounts it via key),
  // then the brand's own persisted history is restored — history is per brand.
  useEffect(() => {
    setInput("");
    setError(null);
    setState(null);
    setMessages(restoreMessages(brandSlug));
    setHydrated(true);
    loadState();
  }, [brandSlug, loadState]);

  // Persist on every change so the conversation survives view switches
  // (remount via key) and reloads.
  useEffect(() => {
    if (!hydrated) return;
    persistMessages(brandSlug, messages);
  }, [brandSlug, hydrated, messages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy) return;
      setError(null);
      setBusy(true);
      setInput("");
      const history = [...messages, { role: "user" as const, content }];
      setMessages(history);
      try {
        const res = await fetch(`/api/brands/${brandSlug}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history.map((m) => ({ role: m.role, content: m.content })),
          }),
          // Long tool chains are fine, hangs are not: cap a turn at 3 minutes.
          signal: AbortSignal.timeout(180_000),
        });
        const data = (await res.json()) as {
          reply?: string;
          actions?: ChatAction[];
          refs?: ChatRef[];
          stateChanged?: boolean;
          error?: string;
        };
        if (!res.ok || typeof data.reply !== "string") {
          throw new Error(data.error ?? `status ${res.status}`);
        }
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.reply as string,
            actions: data.actions,
            refs: data.refs,
          },
        ]);
        if (data.stateChanged) {
          onStateChanged?.();
        }
        loadState();
      } catch (e) {
        // Friendly demo-safe messages instead of raw error strings.
        const friendly =
          e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")
            ? "The strategist took too long to respond. Your message is back in the composer — please try again."
            : e instanceof TypeError
              ? "Could not reach the strategist. Check the connection and try again — your message is back in the composer."
              : "Something went wrong on our side. Your message is back in the composer — please try again.";
        setError(friendly);
        // Roll the failed user message back into the composer.
        setMessages((prev) => prev.slice(0, -1));
        setInput(content);
      } finally {
        setBusy(false);
      }
    },
    [brandSlug, busy, messages, loadState, onStateChanged],
  );

  const suggestions = buildSuggestions(state);

  // Until the restore ran we don't know whether a history exists — render
  // nothing for that instant instead of flashing the hero over a chat view.
  if (!hydrated) {
    return <div className="h-full min-h-[60vh]" />;
  }

  /* -------------------------------------------------- empty state (hero) -- */
  if (messages.length === 0) {
    return (
      <div className="flex h-full min-h-[60vh] flex-col items-center justify-center px-6">
        <div className="w-full max-w-[640px]">
          <h1 className="text-center text-[2rem] font-semibold tracking-[-0.025em]">
            What should we work on?
          </h1>
          <p className="mx-auto mt-3 max-w-[44ch] text-center text-[0.9375rem] leading-relaxed text-text-soft">
            The campaign strategist knows the brand&apos;s current state and executes what you decide.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {suggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                disabled={busy}
                onClick={() => send(s.prompt)}
                className="rounded-full bg-ink-750 px-4 py-2 text-[0.8125rem] text-text-soft transition-colors hover:bg-rule hover:text-foreground disabled:opacity-40"
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="mt-8">
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={() => send(input)}
              busy={busy}
              autoFocus
            />
          </div>

          {busy ? (
            <p className="mt-4 animate-pulse text-center text-[0.8125rem] text-text-faint">
              Strategist is thinking …
            </p>
          ) : null}
          {error ? (
            <p className="mt-4 rounded-xl bg-signal-red/10 px-4 py-2.5 text-center text-[0.8125rem] text-signal-red">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------- chat view -- */
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-6 py-8">
          {messages.map((message, i) =>
            message.role === "user" ? (
              <div
                key={i}
                className="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-ink-750 px-4 py-2.5 text-[0.9375rem] leading-relaxed text-text-soft"
              >
                {message.content}
              </div>
            ) : (
              <div key={i} className="max-w-[92%]">
                <p className="whitespace-pre-wrap text-[0.9375rem] leading-relaxed text-foreground">
                  {message.content}
                </p>
                <ActionBadges actions={message.actions} />
                <RefChips refs={message.refs} />
              </div>
            ),
          )}

          {busy ? (
            <p className="animate-pulse text-[0.875rem] text-text-faint">
              Strategist is thinking …
            </p>
          ) : null}
          {error ? (
            <p className="rounded-xl bg-signal-red/10 px-4 py-2.5 text-[0.8125rem] text-signal-red">
              {error}
            </p>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>

      <div className="shrink-0 px-6 pb-6">
        <div className="mx-auto max-w-[720px]">
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={() => send(input)}
            busy={busy}
          />
        </div>
      </div>
    </div>
  );
}
