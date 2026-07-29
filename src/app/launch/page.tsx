"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { uuidv7 } from "uuidv7";
import { AppNav } from "@/components/AppNav";

interface AdvertiserOption {
  id: string;
  name: string;
}

interface AccountOption {
  id: string;
  name: string;
  metaAdAccountId: string;
}

interface CreativeRow {
  id: string;
  name: string;
  headline: string;
  status: string;
}

interface PendingApproval {
  approvalId: string;
  runId: string;
  resolved: unknown;
  resolvedRequestHash: string;
  bindingMismatch: boolean;
  statusCode: string;
}

export default function LaunchPage() {
  const t = useTranslations();
  const [advertisers, setAdvertisers] = useState<AdvertiserOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [creatives, setCreatives] = useState<CreativeRow[]>([]);
  const [advertiserId, setAdvertiserId] = useState("");
  const [metaAdAccountId, setMetaAdAccountId] = useState("");
  const [selectedCreative, setSelectedCreative] = useState("");
  const [campaignMode, setCampaignMode] = useState<"new" | "existing">("new");
  const [existingCampaignId, setExistingCampaignId] = useState("");
  const [budgetMode, setBudgetMode] = useState<"ABO" | "CBO">("ABO");
  const [budgetAmount, setBudgetAmount] = useState("500");
  /** null = unknown / loading; for existing campaigns from Meta lookup. */
  const [existingIsCbo, setExistingIsCbo] = useState<boolean | null>(null);
  const [deviationReason, setDeviationReason] = useState("");
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [publicationId, setPublicationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorParams, setErrorParams] = useState<Record<string, unknown> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const loadAdvertisers = useCallback(async () => {
    const res = await fetch("/api/advertisers", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as {
      advertisers: Array<{ id: string; name: string }>;
    };
    setAdvertisers(data.advertisers);
    if (data.advertisers[0] && !advertiserId) {
      setAdvertiserId(data.advertisers[0].id);
    }
  }, [advertiserId]);

  const loadAccounts = useCallback(async () => {
    const res = await fetch("/api/auth/meta/status", { cache: "no-store" });
    if (!res.ok) {
      setAccounts([]);
      return;
    }
    const data = (await res.json()) as {
      adAccounts?: Array<{
        id: string;
        name: string;
        metaAdAccountId: string;
        advertiserId: string;
      }>;
    };
    const rows = (data.adAccounts ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      metaAdAccountId: a.metaAdAccountId,
    }));
    setAccounts(rows);
    if (rows[0] && !metaAdAccountId) setMetaAdAccountId(rows[0].id);
  }, [metaAdAccountId]);

  const loadCreatives = useCallback(async () => {
    if (!advertiserId) return;
    const res = await fetch(`/api/creatives?advertiserId=${advertiserId}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = (await res.json()) as { creatives: CreativeRow[] };
    setCreatives(data.creatives.filter((c) => c.status === "ready"));
  }, [advertiserId]);

  useEffect(() => {
    void loadAdvertisers();
    void loadAccounts();
  }, [loadAdvertisers, loadAccounts]);

  useEffect(() => {
    void loadCreatives();
  }, [loadCreatives]);

  useEffect(() => {
    if (campaignMode !== "existing" || !existingCampaignId.trim() || !metaAdAccountId) {
      setExistingIsCbo(null);
      return;
    }
    let cancelled = false;
    setExistingIsCbo(null);
    void (async () => {
      const res = await fetch(
        `/api/meta/campaign-budget?metaAdAccountId=${metaAdAccountId}` +
          `&campaignId=${encodeURIComponent(existingCampaignId.trim())}`,
        { cache: "no-store" },
      );
      if (cancelled) return;
      if (!res.ok) {
        setExistingIsCbo(null);
        return;
      }
      const data = (await res.json()) as { isCbo: boolean };
      setExistingIsCbo(data.isCbo);
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignMode, existingCampaignId, metaAdAccountId]);

  const budgetNeeded =
    campaignMode === "new"
      ? true
      : existingIsCbo === null
        ? false
        : !existingIsCbo;

  async function requestPublish() {
    if (!advertiserId || !metaAdAccountId || !selectedCreative) return;
    if (campaignMode === "existing" && !existingCampaignId.trim()) return;
    if (campaignMode === "existing" && existingIsCbo === null) return;
    setBusy(true);
    setError(null);
    setErrorParams(null);
    setApproval(null);
    try {
      const body: Record<string, unknown> = {
        advertiserId,
        metaAdAccountId,
        creativeIds: [selectedCreative],
        campaign:
          campaignMode === "existing"
            ? { mode: "existing", existingCampaignId: existingCampaignId.trim() }
            : { mode: "new", budgetMode },
        adSet: { mode: "new" },
        idempotencyKey: uuidv7(),
      };
      if (budgetNeeded) {
        body.budget = {
          amount: Number(budgetAmount),
          currency: "EUR",
        };
      }
      if (deviationReason.trim()) {
        body.deviationReason = deviationReason.trim();
      }

      const res = await fetch("/api/meta/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as PendingApproval & {
        error?: string;
        params?: Record<string, unknown>;
      };
      if (!res.ok) {
        setError(data.error ?? "request_failed");
        setErrorParams(data.params ?? null);
        return;
      }
      setApproval(data);
    } finally {
      setBusy(false);
    }
  }

  async function decide(approve: boolean) {
    if (!approval) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/meta/publish", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: approval.approvalId, approve }),
      });
      const data = (await res.json()) as {
        statusCode?: string;
        publicationId?: string;
        error?: string;
        params?: Record<string, unknown>;
      };
      if (!res.ok) {
        setError(data.error ?? "request_failed");
        setErrorParams(data.params ?? null);
        return;
      }
      if (approve && data.publicationId) {
        setPublicationId(data.publicationId);
      }
      setApproval(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)" }}>
      <AppNav />
      <div style={{ maxWidth: "52rem", margin: "0 auto", padding: "1.5rem 1rem" }}>
        <h1 style={{ margin: "0 0 0.35rem", fontSize: "1.5rem" }}>
          {t("launch.title")}
        </h1>
        <p style={{ color: "var(--dim)", marginBottom: "1.25rem" }}>
          {t("launch.subtitle")}
        </p>

        <div
          style={{
            display: "grid",
            gap: "0.75rem",
            marginBottom: "1.25rem",
            fontFamily: "var(--font-data)",
          }}
        >
          <label>
            <span style={{ color: "var(--dim)", marginRight: "0.5rem" }}>
              {t("launch.advertiser")}
            </span>
            <select
              value={advertiserId}
              onChange={(e) => setAdvertiserId(e.target.value)}
              style={selectStyle}
            >
              {advertisers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span style={{ color: "var(--dim)", marginRight: "0.5rem" }}>
              {t("launch.account")}
            </span>
            <select
              value={metaAdAccountId}
              onChange={(e) => setMetaAdAccountId(e.target.value)}
              style={selectStyle}
            >
              {accounts.length === 0 ? (
                <option value="">{t("launch.noAccount")}</option>
              ) : (
                accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))
              )}
            </select>
          </label>

          <label>
            <span style={{ color: "var(--dim)", marginRight: "0.5rem" }}>
              {t("launch.campaign")}
            </span>
            <select
              value={campaignMode}
              onChange={(e) =>
                setCampaignMode(e.target.value as "new" | "existing")
              }
              style={selectStyle}
            >
              <option value="new">{t("launch.newCampaign")}</option>
              <option value="existing">{t("launch.existingCampaign")}</option>
            </select>
          </label>

          {campaignMode === "existing" ? (
            <label>
              <span style={{ color: "var(--dim)", marginRight: "0.5rem" }}>
                {t("launch.existingCampaignId")}
              </span>
              <input
                value={existingCampaignId}
                onChange={(e) => setExistingCampaignId(e.target.value)}
                style={inputStyle}
              />
              {existingCampaignId.trim() && existingIsCbo !== null ? (
                <span style={{ color: "var(--dim)", marginLeft: "0.5rem" }}>
                  {existingIsCbo ? t("launch.existingCbo") : t("launch.existingAbo")}
                </span>
              ) : null}
            </label>
          ) : (
            <label>
              <span style={{ color: "var(--dim)", marginRight: "0.5rem" }}>
                {t("launch.budgetMode")}
              </span>
              <select
                value={budgetMode}
                onChange={(e) =>
                  setBudgetMode(e.target.value as "ABO" | "CBO")
                }
                style={selectStyle}
              >
                <option value="ABO">ABO</option>
                <option value="CBO">CBO</option>
              </select>
            </label>
          )}

          {budgetNeeded ? (
            <label>
              <span style={{ color: "var(--dim)", marginRight: "0.5rem" }}>
                {t("launch.budget")}
              </span>
              <input
                value={budgetAmount}
                onChange={(e) => setBudgetAmount(e.target.value)}
                style={inputStyle}
                inputMode="numeric"
              />
              <span style={{ color: "var(--dim)", marginLeft: "0.35rem" }}>
                {t("launch.budgetHint")}
              </span>
            </label>
          ) : null}

          <label>
            <span style={{ color: "var(--dim)", marginRight: "0.5rem" }}>
              {t("launch.creative")}
            </span>
            <select
              value={selectedCreative}
              onChange={(e) => setSelectedCreative(e.target.value)}
              style={selectStyle}
            >
              <option value="">{t("launch.selectCreative")}</option>
              {creatives.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span style={{ color: "var(--dim)", marginRight: "0.5rem" }}>
              {t("launch.deviationReason")}
            </span>
            <input
              value={deviationReason}
              onChange={(e) => setDeviationReason(e.target.value)}
              style={inputStyle}
              placeholder={t("launch.deviationPlaceholder")}
            />
          </label>
        </div>

        <p style={{ color: "var(--warn)", fontSize: "0.9rem" }}>
          {t("launch.pausedNotice")}
        </p>

        <button
          type="button"
          disabled={busy || !selectedCreative || !metaAdAccountId}
          onClick={() => void requestPublish()}
          style={{
            background: "var(--accent)",
            color: "var(--on-accent)",
            border: "none",
            borderRadius: "var(--radius)",
            padding: "0.55rem 1rem",
            cursor: "pointer",
            marginTop: "0.5rem",
          }}
        >
          {t("launch.publish")}
        </button>

        {approval ? (
          <div
            style={{
              marginTop: "1.25rem",
              padding: "1rem",
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius)",
            }}
          >
            <strong>{t("chat.approvalRequired")}</strong>
            <p style={{ color: "var(--warn)", margin: "0.5rem 0" }}>
              {t("launch.costly")}
            </p>
            {approval.bindingMismatch ? (
              <p style={{ color: "var(--crit)", fontFamily: "var(--font-data)" }}>
                metric_binding_mismatch
              </p>
            ) : null}
            <pre
              style={{
                fontFamily: "var(--font-data)",
                fontSize: "0.8rem",
                overflow: "auto",
                background: "var(--raised)",
                padding: "0.75rem",
                borderRadius: "var(--radius)",
              }}
            >
              {JSON.stringify(approval.resolved, null, 2)}
            </pre>
            <p style={{ color: "var(--dim)", fontFamily: "var(--font-data)" }}>
              {t("chat.approvalHashHint")}
              <br />
              {approval.resolvedRequestHash}
            </p>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(true)}
                style={{
                  background: "var(--accent)",
                  color: "var(--on-accent)",
                  border: "none",
                  borderRadius: "var(--radius)",
                  padding: "0.4rem 0.85rem",
                  cursor: "pointer",
                }}
              >
                {t("chat.approve")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(false)}
                style={{
                  background: "var(--raised)",
                  color: "var(--fg)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--radius)",
                  padding: "0.4rem 0.85rem",
                  cursor: "pointer",
                }}
              >
                {t("chat.deny")}
              </button>
            </div>
          </div>
        ) : null}

        {publicationId ? (
          <p style={{ marginTop: "1rem", fontFamily: "var(--font-data)" }}>
            {t("launch.queued")} · {publicationId}
          </p>
        ) : null}

        {error ? (
          <p
            style={{
              color: "var(--crit)",
              fontFamily: "var(--font-data)",
              marginTop: "1rem",
            }}
          >
            {error}
            {errorParams ? ` ${JSON.stringify(errorParams)}` : ""}
          </p>
        ) : null}
      </div>
    </main>
  );
}

const selectStyle: React.CSSProperties = {
  background: "var(--raised)",
  color: "var(--fg)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius)",
  padding: "0.35rem 0.5rem",
};

const inputStyle: React.CSSProperties = {
  background: "var(--raised)",
  color: "var(--fg)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius)",
  padding: "0.35rem 0.5rem",
  fontFamily: "var(--font-data)",
  minWidth: "12rem",
};
