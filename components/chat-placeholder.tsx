"use client";

// Thin placeholder for the chat start view. A parallel work stream delivers
// components/chat-panel.tsx with the identical export signature; the shell
// then swaps its import in one line (see app-shell.tsx). No chat logic here.

export function ChatPanel({
  brandSlug,
  onStateChanged,
}: {
  brandSlug: string;
  onStateChanged?: () => void;
}) {
  void brandSlug;
  void onStateChanged;
  return (
    <div className="flex h-full min-h-[60vh] flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <h1 className="text-[1.875rem] font-semibold tracking-[-0.025em]">
          Womit sollen wir anfangen?
        </h1>
        <p className="mt-3 max-w-[46ch] text-[0.9375rem] leading-relaxed text-ink-soft">
          Der Chat wird gerade angeschlossen. Bis dahin führen Board, Studio
          und Wirtschaftlichkeit durch die Kampagne.
        </p>
      </div>
      {/* Composer slot: same footprint as the real chat input. */}
      <div className="mx-auto w-full max-w-[720px] pb-10">
        <div className="surface flex h-14 items-center rounded-full px-6 text-[0.9375rem] text-ink-faint">
          Nachricht schreiben …
        </div>
      </div>
    </div>
  );
}
