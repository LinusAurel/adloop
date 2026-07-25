"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "adloop_admin";

// Deployment unlock: opening the app once with ?admin=<secret> stores the
// secret locally and attaches it as x-admin-secret to every same-origin API
// call. Without it the deployed app stays a read-only view (mutations 401) —
// a persistent notice makes that limitation explicit to visitors.
// The secret never appears in the bundle and is stripped from the URL.
export function AdminKeyBridge() {
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get("admin");
    if (fromQuery) {
      window.localStorage.setItem(STORAGE_KEY, fromQuery);
      url.searchParams.delete("admin");
      window.history.replaceState(null, "", url.toString());
    }

    const key = window.localStorage.getItem(STORAGE_KEY);
    const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    if (!key) {
      // Local dev keeps the guard open, so the notice only applies deployed.
      setReadOnly(!isLocal);
      return;
    }

    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try {
        const target =
          typeof input === "string" || input instanceof URL
            ? new URL(String(input), window.location.origin)
            : new URL(input.url, window.location.origin);
        if (target.origin === window.location.origin && target.pathname.startsWith("/api/")) {
          const headers = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
          );
          if (!headers.has("x-admin-secret")) headers.set("x-admin-secret", key);
          return original(input, { ...init, headers });
        }
      } catch {
        // fall through to the untouched fetch on URL parsing issues
      }
      return original(input, init);
    };
    return () => {
      window.fetch = original;
    };
  }, []);

  if (!readOnly) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-3">
      <p className="pointer-events-auto rounded-full border border-amber-400/30 bg-ink-800/95 px-4 py-2 text-[0.8125rem] text-amber-200/90 shadow-lg backdrop-blur">
        Read-only view — no admin key detected. Explore the demo data freely;
        actions that change state are disabled.
      </p>
    </div>
  );
}
