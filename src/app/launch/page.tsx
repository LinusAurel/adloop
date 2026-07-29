"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
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
    <div>
      <AppNav />
      <main className="page" style={{ maxWidth: 860 }}>
        <h1>{t("launch.title")}</h1>
        <p>{t("launch.subtitle")}</p>

        <div className="panel">
          <label className="row">
            <span>{t("launch.advertiser")}</span>
            <select value={advertiserId} onChange={(e) => setAdvertiserId(e.target.value)}>
              {advertisers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="row">
            <span>{t("launch.account")}</span>
            <select
              className="data"
              value={metaAdAccountId}
              onChange={(e) => setMetaAdAccountId(e.target.value)}
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

          <label className="row">
            <span>{t("launch.campaign")}</span>
            <select
              value={campaignMode}
              onChange={(e) => setCampaignMode(e.target.value as "new" | "existing")}
            >
              <option value="new">{t("launch.newCampaign")}</option>
              <option value="existing">{t("launch.existingCampaign")}</option>
            </select>
          </label>

          {campaignMode === "existing" ? (
            <label className="row">
              <span>{t("launch.existingCampaignId")}</span>
              <div>
                <input
                  className="data"
                  value={existingCampaignId}
                  onChange={(e) => setExistingCampaignId(e.target.value)}
                />
                {existingCampaignId.trim() && existingIsCbo !== null ? (
                  <div className="data" style={{ color: "var(--dim)", fontSize: 11, marginTop: 4 }}>
                    {existingIsCbo ? t("launch.existingCbo") : t("launch.existingAbo")}
                  </div>
                ) : null}
              </div>
            </label>
          ) : (
            <label className="row">
              <span>{t("launch.budgetMode")}</span>
              <select
                className="data"
                value={budgetMode}
                onChange={(e) => setBudgetMode(e.target.value as "ABO" | "CBO")}
              >
                <option value="ABO">ABO</option>
                <option value="CBO">CBO</option>
              </select>
            </label>
          )}

          {budgetNeeded ? (
            <label className="row">
              <span>{t("launch.budget")}</span>
              <div>
                <input
                  className="data"
                  value={budgetAmount}
                  onChange={(e) => setBudgetAmount(e.target.value)}
                  inputMode="numeric"
                />
                <div className="data" style={{ color: "var(--dim)", fontSize: 11, marginTop: 4 }}>
                  {t("launch.budgetHint")}
                </div>
              </div>
            </label>
          ) : null}

          <label className="row">
            <span>{t("launch.creative")}</span>
            <select value={selectedCreative} onChange={(e) => setSelectedCreative(e.target.value)}>
              <option value="">{t("launch.selectCreative")}</option>
              {creatives.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="row" style={{ marginBottom: 0 }}>
            <span>{t("launch.deviationReason")}</span>
            <input
              value={deviationReason}
              onChange={(e) => setDeviationReason(e.target.value)}
              placeholder={t("launch.deviationPlaceholder")}
            />
          </label>
        </div>

        {/* Jede Anzeige entsteht pausiert. Das ist kein Hinweis am Rand, sondern
            die Zusage, unter der überhaupt veröffentlicht werden darf. */}
        <div className="msgbox warn">{t("launch.pausedNotice")}</div>

        <div className="acts">
          <button
            type="button"
            className="btn pri"
            disabled={busy || !selectedCreative || !metaAdAccountId}
            onClick={() => void requestPublish()}
          >
            {t("launch.publish")}
          </button>
        </div>

        {approval ? (
          <div className="approve" style={{ marginTop: 16, maxWidth: "none" }}>
            <div className="ahead">
              <h4>{t("chat.approvalRequired")}</h4>
              <span className="cost">{t("launch.costly")}</span>
            </div>

            {approval.bindingMismatch ? (
              <div className="msgbox err data">metric_binding_mismatch</div>
            ) : null}

            <dl className="kv">
              {Object.entries(approval.resolved as Record<string, unknown>).map(([key, value]) => (
                <Fragment key={key}>
                  <dt>{key}</dt>
                  <dd>
                    {typeof value === "object" && value !== null
                      ? JSON.stringify(value)
                      : String(value)}
                  </dd>
                </Fragment>
              ))}
            </dl>

            <div className="hashline">
              sha256 <b>{approval.resolvedRequestHash.slice(0, 12)}…</b> —{" "}
              {t("chat.approvalHashHint")}
            </div>

            <div className="acts">
              <button type="button" className="btn pri" disabled={busy} onClick={() => void decide(true)}>
                {t("chat.approve")}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void decide(false)}>
                {t("chat.deny")}
              </button>
            </div>
          </div>
        ) : null}

        {publicationId ? (
          <div className="msgbox ok data" style={{ marginTop: 14 }}>
            {t("launch.queued")} · {publicationId}
          </div>
        ) : null}

        {error ? (
          <div className="msgbox err data" style={{ marginTop: 14 }} role="alert">
            {error}
            {errorParams ? ` ${JSON.stringify(errorParams)}` : ""}
          </div>
        ) : null}
      </main>
    </div>
  );
}
