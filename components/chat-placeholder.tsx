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
        <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em]">
          What should we work on?
        </h1>
        <p className="mt-3 max-w-[46ch] text-[0.9375rem] leading-relaxed text-text-soft">
          The chat is being wired up. Until then, Board, Studio and Economics
          run the campaign.
        </p>
      </div>
      {/* Composer slot: same footprint as the real chat input. */}
      <div className="mx-auto w-full max-w-[720px] pb-10">
        <div className="flex h-14 items-center rounded-2xl bg-ink-750 px-6 text-[0.9375rem] text-text-faint">
          Write a message …
        </div>
      </div>
    </div>
  );
}
