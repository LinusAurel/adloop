"use client";

/*
  ChatPanel (#16) — the heart of the platform: the user steers the whole
  engine in dialogue. Before the first message the panel is a calm, centred
  entry („Woran arbeiten wir?“) with contextual suggestion chips derived
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

interface PanelMessage {
  role: "user" | "assistant";
  content: string;
  actions?: ChatAction[];
}

interface Suggestion {
  label: string;
  prompt: string;
}

// Contextual chips: derived from the state, never more than four.
function buildSuggestions(state: BrandState | null): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const angles = state?.angles ?? [];
  const assets = state?.assets ?? [];

  const draftAssets = assets.filter((a) => a.status === "draft");
  if (draftAssets.length > 0) {
    suggestions.push({
      label: `${draftAssets.length} Asset${draftAssets.length === 1 ? "" : "s"} warten auf Freigabe — jetzt ansehen`,
      prompt: "Zeig mir das Material, das auf Freigabe wartet, und gib mir Deine Empfehlung.",
    });
  }

  const draftAngles = angles.filter((a) => a.status === "draft");
  if (draftAngles.length > 0) {
    suggestions.push({
      label: `${draftAngles.length} Hypothese${draftAngles.length === 1 ? "" : "n"} warten auf Deine Entscheidung`,
      prompt: "Geh mit mir die offenen Hypothesen durch — welche würdest Du freigeben und warum?",
    });
  }

  if (angles.length === 0) {
    suggestions.push({
      label: "Neue Angles aus dem Research generieren",
      prompt: "Starte den Strategist und melde neue Angle-Hypothesen an.",
    });
  }

  const approvedAssets = assets.filter((a) => a.status === "approved");
  if (approvedAssets.length > 0) {
    suggestions.push({
      label: "Kampagne veröffentlichen (startet pausiert)",
      prompt: "Veröffentliche die freigegebenen Assets als Kampagne — pausiert, wie immer.",
    });
  }

  suggestions.push({
    label: "Wie steht die Brand gerade da?",
    prompt: "Gib mir einen kurzen Überblick: Wo stehen wir, und was wäre jetzt der sinnvollste nächste Schritt?",
  });

  return suggestions.slice(0, 4);
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
        placeholder="Woran arbeiten wir?"
        aria-label="Nachricht an den Kampagnen-Strategen"
        disabled={busy}
        autoFocus={autoFocus}
        className="h-9 min-w-0 flex-1 bg-transparent text-[0.9375rem] text-foreground placeholder:text-text-faint focus:outline-none disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={busy || value.trim() === ""}
        aria-label="Senden"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
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

  // A brand switch resets the conversation; chat history is per brand.
  useEffect(() => {
    setMessages([]);
    setInput("");
    setError(null);
    setState(null);
    loadState();
  }, [brandSlug, loadState]);

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
        });
        const data = (await res.json()) as {
          reply?: string;
          actions?: ChatAction[];
          stateChanged?: boolean;
          error?: string;
        };
        if (!res.ok || typeof data.reply !== "string") {
          throw new Error(data.error ?? `Status ${res.status}`);
        }
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.reply as string, actions: data.actions },
        ]);
        if (data.stateChanged) {
          onStateChanged?.();
        }
        loadState();
      } catch (e) {
        setError(e instanceof Error ? e.message : "unbekannter Fehler");
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

  /* -------------------------------------------------- empty state (hero) -- */
  if (messages.length === 0) {
    return (
      <div className="flex h-full min-h-[60vh] flex-col items-center justify-center px-6">
        <div className="w-full max-w-[640px]">
          <h1 className="text-center text-[2rem] font-semibold tracking-[-0.025em]">
            Woran arbeiten wir?
          </h1>
          <p className="mx-auto mt-3 max-w-[44ch] text-center text-[0.9375rem] leading-relaxed text-text-soft">
            Der Kampagnen-Stratege kennt den Stand der Brand und führt aus, was Du entscheidest.
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
              Stratege denkt nach …
            </p>
          ) : null}
          {error ? (
            <p className="mt-4 rounded-xl bg-signal-red/10 px-4 py-2.5 text-center text-[0.8125rem] text-signal-red">
              Nachricht nicht angekommen: {error}
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
              </div>
            ),
          )}

          {busy ? (
            <p className="animate-pulse text-[0.875rem] text-text-faint">
              Stratege denkt nach …
            </p>
          ) : null}
          {error ? (
            <p className="rounded-xl bg-signal-red/10 px-4 py-2.5 text-[0.8125rem] text-signal-red">
              Nachricht nicht angekommen: {error}
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
