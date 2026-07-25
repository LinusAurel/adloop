"use client";

import { useEffect } from "react";

const STORAGE_KEY = "adloop_admin";

// Deployment unlock: opening the app once with ?admin=<secret> stores the
// secret locally and attaches it as x-admin-secret to every same-origin API
// call. Without it the deployed app stays a read-only view (mutations 401).
// The secret never appears in the bundle and is stripped from the URL.
export function AdminKeyBridge() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get("admin");
    if (fromQuery) {
      window.localStorage.setItem(STORAGE_KEY, fromQuery);
      url.searchParams.delete("admin");
      window.history.replaceState(null, "", url.toString());
    }

    const key = window.localStorage.getItem(STORAGE_KEY);
    if (!key) return;

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

  return null;
}
