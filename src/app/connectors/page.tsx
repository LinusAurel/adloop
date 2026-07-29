"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AppNav } from "@/components/AppNav";
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

// Codes, für die es einen eigenen Text gibt. Alles andere fällt auf "unknown"
// mit dem Rohcode zurück — sichtbar, aber nicht erfunden.
const KNOWN_ERRORS = new Set([
  "account_not_selected",
  "idempotency_conflict",
  "meta_not_configured",
  "sync_in_progress",
  "unauthenticated",
]);

const KNOWN_MESSAGES = new Set([
  "base_facts_not_synced",
  "base_facts_syncing",
  "base_facts_ready",
]);

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "unknown_error";
}

export default function ConnectorsPage() {
  const t = useTranslations("connectors");
  const router = useRouter();
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localeDrafts, setLocaleDrafts] = useState<Record<string, string>>({});

  // Der Server schickt Codes, nie fertigen Text (SPEC §8.2). Unbekannte Codes
  // bleiben als Code sichtbar, statt hinter einem allgemeinen Satz zu verschwinden.
  const describe = useCallback(
    (code: string) => (KNOWN_ERRORS.has(code) ? t(`err.${code}` as never) : t("errUnknown", { code })),
    [t],
  );

  const refresh = useCallback(async () => {
    const response = await fetch("/api/auth/meta/status", { cache: "no-store" });
    if (response.status === 401) {
      router.push("/login");
      return;
    }
    if (!response.ok) {
      const code = await responseError(response);
      setError(describe(code));
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
  }, [router, describe]);

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
      setError(describe(code));
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
      setError(describe(code));
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
      setError(describe(code));
      return;
    }
    await refresh();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  // Bereitschaft auf die vier Zustandsrollen. "syncing" ist bewusst --none:
  // solange gelesen wird, ist noch keine Aussage möglich.
  function readyColor(state: ReadinessArea["status"]): string {
    if (state === "ready") return "var(--good)";
    if (state === "optional_pending") return "var(--warn)";
    if (state === "error") return "var(--crit)";
    return "var(--none)";
  }

  return (
    <div>
      <AppNav />
      <main className="page" style={{ maxWidth: 900 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h1>{t("title")}</h1>
          <button type="button" className="chip" style={{ marginLeft: "auto" }} onClick={() => void logout()}>
            {t("logout")}
          </button>
        </div>

        {!status && <p style={{ color: "var(--dim)" }}>{t("loading")}</p>}

        {status && !status.metaConfigured && (
          <div className="msgbox warn">{t("metaNotConfigured")}</div>
        )}

        <div className="panel">
          <div className="acts">
            <button
              type="button"
              className="btn pri"
              disabled={!status?.metaConfigured}
              onClick={() => {
                window.location.href = "/api/auth/meta/start";
              }}
            >
              {t("connectMeta")}
            </button>
          </div>
          {status?.connections.map((connection) => (
            <div
              key={connection.id}
              className="data"
              style={{
                fontSize: 11.5,
                marginTop: 10,
                color: connection.expiringSoon ? "var(--crit)" : "var(--dim)",
              }}
            >
              {t("token")} {connection.status} · {t("daysLeft", { days: connection.expiresInDays })}
              {connection.expiringSoon ? ` — ${t("reconnect")}` : ""}
            </div>
          ))}
        </div>

        <h2 style={{ fontSize: 13, fontWeight: 640, margin: "18px 0 8px" }}>{t("adAccounts")}</h2>
        {status?.adAccounts.length === 0 && (
          <p style={{ color: "var(--dim)" }}>{t("noAdAccounts")}</p>
        )}

        {status?.adAccounts.map((account) => (
          <div className="panel" key={account.id}>
            <div className="rhead">
              <h3>{account.name}</h3>
              <span className="meta">
                {account.businessName ?? t("noBusinessName")} · {account.currency} ·{" "}
                {account.timezoneName}
              </span>
            </div>

            <div className="acts" style={{ marginBottom: 12 }}>
              <button
                type="button"
                className={account.selected ? "btn" : "btn pri"}
                disabled={account.selected || busy !== null}
                onClick={() => void selectAccount(account)}
              >
                {account.selected ? t("selected") : t("select")}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!account.selected || busy !== null}
                onClick={() => void startSync(account)}
              >
                {busy === `sync:${account.id}` ? t("syncStarting") : t("startSync")}
              </button>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
              <label className="field" style={{ marginBottom: 0, maxWidth: 160 }}>
                <span>{t("contentLocale")}</span>
                <input
                  className="data"
                  value={localeDrafts[account.advertiserId] ?? account.contentLocale}
                  onChange={(event) =>
                    setLocaleDrafts((current) => ({
                      ...current,
                      [account.advertiserId]: event.target.value,
                    }))
                  }
                />
              </label>
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() => void saveLocale(account)}
              >
                {t("save")}
              </button>
            </div>

            <div className="lhead" style={{ padding: "0 0 6px", borderBottom: 0 }}>
              {t("readiness")}
            </div>
            <div className="scroller">
              <table>
                <tbody>
                  {Object.entries(account.readiness).map(([area, readiness]) => (
                    <tr key={area}>
                      <td className="name">
                        <i className="stripe" style={{ background: readyColor(readiness.status) }} />
                        {area}
                      </td>
                      <td style={{ color: readyColor(readiness.status) }}>{readiness.status}</td>
                      <td>
                        {readiness.progress
                          ? `${readiness.progress.completed}/${readiness.progress.total}`
                          : "—"}
                      </td>
                      <td style={{ color: "var(--dim)", textAlign: "left", whiteSpace: "normal" }}>
                        {readiness.messageCode
                          ? KNOWN_MESSAGES.has(readiness.messageCode)
                            ? t(`msg.${readiness.messageCode}` as never)
                            : readiness.messageCode
                          : ""}
                        {readiness.blocks.length > 0
                          ? ` — ${t("blocked")}: ${readiness.blocks.join(", ")}`
                          : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {error && (
          <div className="msgbox err" role="alert">
            {error}
          </div>
        )}
      </main>
    </div>
  );
}
