"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { uuidv7 } from "uuidv7";

interface ReadinessArea {
  status: "ready" | "syncing" | "optional_pending" | "error";
  progress?: {
    labelCode: string;
    completed: number;
    total: number;
    percent?: number;
  };
  blocks: string[];
  messageCode?: string;
}

interface Connection {
  id: string;
  expiresInDays: number;
  expiringSoon: boolean;
  status: string;
}

interface AdAccount {
  id: string;
  advertiserId: string;
  metaAdAccountId: string;
  name: string;
  currency: string;
  timezoneName: string;
  businessName: string | null;
  selected: boolean;
  readiness: Record<string, ReadinessArea>;
  contentLocale: string;
}

interface MetaStatus {
  metaConfigured: boolean;
  connections: Connection[];
  adAccounts: AdAccount[];
}

const MESSAGE_TEXT: Readonly<Record<string, string>> = {
  base_facts_not_synced: "Tageswerte wurden noch nicht synchronisiert.",
  base_facts_syncing: "Wir bereiten dein Konto vor…",
  base_facts_ready: "Tageswerte sind bereit.",
};

const ERROR_TEXT: Readonly<Record<string, string>> = {
  account_not_selected: "Wähle zuerst ein Werbekonto aus.",
  idempotency_conflict: "Diese Anfrage wurde bereits anders verwendet.",
  meta_not_configured: "Meta-Zugangsdaten fehlen in der Umgebung.",
  sync_in_progress: "Für dieses Werbekonto läuft bereits ein Sync.",
  unauthenticated: "Bitte melde dich erneut an.",
};

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "unknown_error";
}

export default function ConnectorsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localeDrafts, setLocaleDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const response = await fetch("/api/auth/meta/status", { cache: "no-store" });
    if (response.status === 401) {
      router.push("/login");
      return;
    }
    if (!response.ok) {
      const code = await responseError(response);
      setError(ERROR_TEXT[code] ?? `Status konnte nicht geladen werden (${code}).`);
      return;
    }
    const data = (await response.json()) as MetaStatus;
    setStatus(data);
    setLocaleDrafts((current) => {
      const next = { ...current };
      for (const account of data.adAccounts) {
        next[account.advertiserId] ??= account.contentLocale;
      }
      return next;
    });
  }, [router]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function selectAccount(account: AdAccount) {
    setBusy(`select:${account.id}`);
    setError(null);
    const response = await fetch("/api/meta/ad-accounts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selectedAccountIds: [account.metaAdAccountId] }),
    });
    setBusy(null);
    if (!response.ok) {
      const code = await responseError(response);
      setError(ERROR_TEXT[code] ?? `Auswahl fehlgeschlagen (${code}).`);
      return;
    }
    await refresh();
  }

  async function startSync(account: AdAccount) {
    setBusy(`sync:${account.id}`);
    setError(null);
    const response = await fetch("/api/meta/sync/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: uuidv7(), metaAdAccountId: account.id }),
    });
    setBusy(null);
    if (!response.ok) {
      const code = await responseError(response);
      setError(ERROR_TEXT[code] ?? `Sync konnte nicht gestartet werden (${code}).`);
      return;
    }
    await refresh();
  }

  async function saveLocale(account: AdAccount) {
    setBusy(`locale:${account.id}`);
    setError(null);
    const response = await fetch(`/api/advertisers/${account.advertiserId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentLocale: localeDrafts[account.advertiserId] }),
    });
    setBusy(null);
    if (!response.ok) {
      const code = await responseError(response);
      setError(ERROR_TEXT[code] ?? `Sprache konnte nicht gespeichert werden (${code}).`);
      return;
    }
    await refresh();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 800, margin: "2rem auto", padding: "0 1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Connectors</h1>
        <button onClick={() => void logout()}>Abmelden</button>
      </div>

      {!status && <p>Status wird geladen…</p>}
      {status && !status.metaConfigured && (
        <p style={{ color: "#8a5b00" }}>
          Meta ist noch nicht konfiguriert. Setze App-Kennung, App-Geheimnis, Redirect-URI und Verschlüsselungsschlüssel.
        </p>
      )}
      <button
        disabled={!status?.metaConfigured}
        onClick={() => {
          window.location.href = "/api/auth/meta/start";
        }}
      >
        Meta verbinden
      </button>

      {status?.connections.map((connection) => (
        <p key={connection.id} style={{ color: connection.expiringSoon ? "crimson" : "#555" }}>
          Token: {connection.status}, noch {connection.expiresInDays} Tage
          {connection.expiringSoon ? " — bitte Meta erneut verbinden" : ""}
        </p>
      ))}

      <h2>Werbekonten</h2>
      {status?.adAccounts.length === 0 && <p>Keine Werbekonten gefunden.</p>}
      {status?.adAccounts.map((account) => (
        <section
          key={account.id}
          style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem", marginBottom: "1rem" }}
        >
          <h3>{account.name}</h3>
          <p>
            {account.businessName ?? "Ohne Business-Name"} · {account.currency} · {account.timezoneName}
          </p>
          <button
            disabled={account.selected || busy !== null}
            onClick={() => void selectAccount(account)}
          >
            {account.selected ? "Ausgewählt" : "Auswählen"}
          </button>{" "}
          <button
            disabled={!account.selected || busy !== null}
            onClick={() => void startSync(account)}
          >
            {busy === `sync:${account.id}` ? "Sync startet…" : "Sync anstoßen"}
          </button>

          <div style={{ marginTop: "1rem" }}>
            <label>
              Sprache der erzeugten Anzeigentexte{" "}
              <input
                value={localeDrafts[account.advertiserId] ?? account.contentLocale}
                onChange={(event) =>
                  setLocaleDrafts((current) => ({
                    ...current,
                    [account.advertiserId]: event.target.value,
                  }))
                }
                style={{ width: 100 }}
              />
            </label>{" "}
            <button disabled={busy !== null} onClick={() => void saveLocale(account)}>
              Speichern
            </button>
          </div>

          <h4>Readiness</h4>
          <ul>
            {Object.entries(account.readiness).map(([area, readiness]) => (
              <li key={area}>
                <strong>{area}</strong>: {readiness.status}
                {readiness.progress
                  ? ` (${readiness.progress.completed}/${readiness.progress.total})`
                  : ""}
                {readiness.messageCode
                  ? ` — ${MESSAGE_TEXT[readiness.messageCode] ?? readiness.messageCode}`
                  : ""}
                {readiness.blocks.length > 0
                  ? ` — gesperrt: ${readiness.blocks.join(", ")}`
                  : ""}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </main>
  );
}
