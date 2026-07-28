"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { uuidv7 } from "uuidv7";
import { AppNav } from "@/components/AppNav";

interface AdAccount {
  id: string;
  name: string;
  selected: boolean;
}

interface Compared {
  value: number | null;
  previous: number | null;
  changePct: number | null;
  reason?: string;
}

interface PulseIndex {
  status: string;
  value: number | null;
  band: string;
  reason?: string;
}

interface OverviewResponse {
  metaAdAccountId: string;
  windowStart: string;
  windowEnd: string;
  dataAsOf: string;
  metricDefinition: {
    id: string;
    version: number;
    label: string;
    configuredBy: string;
  };
  accountCurrency: string;
  pulse: {
    version: string;
    creativeStrain: PulseIndex;
    spendEfficiency: PulseIndex;
    accountHealth: PulseIndex;
    overall: PulseIndex;
  };
  overview: Record<string, Compared>;
  previousPeriodComplete: boolean;
  ads: Array<{
    metaAdId: string;
    name: string | null;
    spend: Compared;
    impressions: Compared;
    conversions: Compared;
    conversionValue: Compared;
    cpa: Compared;
    cpm: Compared;
    ctr: Compared;
    reach: Compared;
    netNewReach: Compared;
    funnelPosition: {
      gateStatus: string;
      gateReasons: string[];
      score: number | null;
      band: string | null;
      snapshotId: string | null;
    };
  }>;
}

type WindowPreset = "30" | "90";

function windowForPreset(preset: WindowPreset, end: string): { start: string; end: string } {
  const days = preset === "30" ? 30 : 90;
  const endDate = new Date(`${end}T00:00:00.000Z`);
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  return {
    start: startDate.toISOString().slice(0, 10),
    end,
  };
}

function fmt(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  return value.toFixed(digits);
}

function fmtDelta(compared: Compared): string {
  if (compared.changePct === null) return "—";
  const sign = compared.changePct > 0 ? "+" : "";
  return `${sign}${compared.changePct.toFixed(1)}%`;
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--bg)",
  color: "var(--fg)",
  fontFamily: "var(--font-ui)",
};

const panelStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius)",
  padding: "1rem",
};

const mono: React.CSSProperties = { fontFamily: "var(--font-data)" };

export default function StrategistPage() {
  const t = useTranslations();
  const router = useRouter();
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [preset, setPreset] = useState<WindowPreset>("90");
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [selectedAdId, setSelectedAdId] = useState<string | null>(null);
  const [previewPacket, setPreviewPacket] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const windowEnd = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const bounds = useMemo(() => windowForPreset(preset, windowEnd), [preset, windowEnd]);

  const loadAccounts = useCallback(async () => {
    const res = await fetch("/api/meta/ad-accounts");
    if (res.status === 401) {
      router.push("/login");
      return;
    }
    if (!res.ok) return;
    const body = (await res.json()) as { accounts: AdAccount[] };
    setAccounts(body.accounts);
    const selected = body.accounts.find((a) => a.selected) ?? body.accounts[0];
    if (selected) setAccountId(selected.id);
  }, [router]);

  const loadOverview = useCallback(async () => {
    if (!accountId) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        metaAdAccountId: accountId,
        windowStart: bounds.start,
        windowEnd: bounds.end,
      });
      const res = await fetch(`/api/creative-strategies/overview?${params}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ? t(`errors.${body.error}` as never) : t("strategist.loadFailed"));
        setOverview(null);
        return;
      }
      const body = (await res.json()) as OverviewResponse;
      setOverview(body);
      if (body.ads[0]) setSelectedAdId(body.ads[0].metaAdId);
    } finally {
      setBusy(false);
    }
  }, [accountId, bounds.end, bounds.start, t]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const selectedAd = overview?.ads.find((ad) => ad.metaAdId === selectedAdId) ?? null;

  async function runReview(mode: "copychief" | "cro" | "variations", execute: boolean) {
    if (!overview || !selectedAd) return;
    setBusy(true);
    setError(null);
    setPreviewPacket(null);
    try {
      const res = await fetch("/api/creative-strategies/ad-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adId: selectedAd.metaAdId,
          adAccountId: overview.metaAdAccountId,
          mode,
          execute,
          runId: uuidv7(),
          userMessageId: uuidv7(),
          assistantMessageId: uuidv7(),
          analysisWindow: {
            since: overview.windowStart,
            until: overview.windowEnd,
            label: preset === "30" ? "Last 30 days" : "Last 90 days",
            dataAsOf: overview.dataAsOf,
          },
          snapshotId: selectedAd.funnelPosition.snapshotId ?? undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          body?.error ? t(`errors.${body.error}` as never) : t("strategist.actionFailed"),
        );
        return;
      }
      if (!execute) {
        setPreviewPacket(body.contextPacket as string);
        return;
      }
      router.push(`/chat?chatId=${body.chatId}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshSync() {
    if (!accountId) return;
    setBusy(true);
    try {
      await fetch("/api/meta/sync/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metaAdAccountId: accountId }),
      });
      await loadOverview();
    } finally {
      setBusy(false);
    }
  }

  function pulseLabel(index: PulseIndex): string {
    if (index.status === "insufficient_data") {
      return t(`strategist.pulseReason.${index.reason ?? "insufficient_data"}` as never);
    }
    return t(`strategist.pulseBand.${index.band}` as never);
  }

  function bandColor(band: string): string {
    if (band === "healthy") return "var(--good)";
    if (band === "attention_required") return "var(--warn)";
    if (band === "critical") return "var(--crit)";
    return "var(--none)";
  }

  return (
    <div style={pageStyle}>
      <AppNav />
      <main style={{ padding: "1.25rem", display: "grid", gap: "1rem" }}>
        <header style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "end" }}>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ color: "var(--dim)", fontSize: "0.85rem" }}>{t("strategist.adAccount")}</span>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              style={{ ...mono, background: "var(--raised)", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: "0.4rem 0.6rem" }}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ color: "var(--dim)", fontSize: "0.85rem" }}>{t("strategist.timeWindow")}</span>
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value as WindowPreset)}
              style={{ ...mono, background: "var(--raised)", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: "0.4rem 0.6rem" }}
            >
              <option value="30">{t("strategist.window30")}</option>
              <option value="90">{t("strategist.window90")}</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => void refreshSync()}
            disabled={busy}
            style={{
              background: "var(--accent)",
              color: "var(--on-accent)",
              border: "none",
              borderRadius: "var(--radius)",
              padding: "0.5rem 0.9rem",
              cursor: "pointer",
            }}
          >
            {t("strategist.refreshSync")}
          </button>
        </header>

        {error ? (
          <p style={{ color: "var(--crit)" }}>{error}</p>
        ) : null}

        {overview ? (
          <>
            <section style={panelStyle}>
              <h2 style={{ margin: "0 0 0.75rem", fontSize: "1rem" }}>{t("strategist.pulse")}</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "0.75rem" }}>
                {(
                  [
                    ["overall", overview.pulse.overall],
                    ["creativeStrain", overview.pulse.creativeStrain],
                    ["spendEfficiency", overview.pulse.spendEfficiency],
                    ["accountHealth", overview.pulse.accountHealth],
                  ] as const
                ).map(([key, index]) => (
                  <div key={key} style={{ borderLeft: `4px solid ${bandColor(index.band)}`, paddingLeft: "0.6rem" }}>
                    <div style={{ color: "var(--dim)", fontSize: "0.8rem" }}>{t(`strategist.pulseIndex.${key}`)}</div>
                    <div style={{ ...mono, fontSize: "1.4rem" }}>
                      {index.value === null ? "—" : Math.round(index.value)}
                    </div>
                    <div style={{ color: "var(--dim)", fontSize: "0.8rem" }}>{pulseLabel(index)}</div>
                  </div>
                ))}
              </div>
            </section>

            <section style={panelStyle}>
              <h2 style={{ margin: "0 0 0.75rem", fontSize: "1rem" }}>{t("strategist.overview")}</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "0.75rem" }}>
                {Object.entries(overview.overview).map(([key, value]) => (
                  <div key={key}>
                    <div style={{ color: "var(--dim)", fontSize: "0.8rem" }}>{t(`strategist.metric.${key}` as never)}</div>
                    <div style={mono}>{fmt(value.value)}</div>
                    <div style={{ ...mono, color: "var(--dim)", fontSize: "0.8rem" }}>{fmtDelta(value)}</div>
                  </div>
                ))}
              </div>
              <p style={{ ...mono, color: "var(--dim)", fontSize: "0.8rem", marginTop: "0.75rem" }}>
                {overview.windowStart} → {overview.windowEnd} · dataAsOf {overview.dataAsOf} ·{" "}
                {overview.metricDefinition.label} v{overview.metricDefinition.version}
              </p>
            </section>

            <section style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: "1rem" }}>
              <div style={panelStyle}>
                <h2 style={{ margin: "0 0 0.75rem", fontSize: "1rem" }}>{t("strategist.ads")}</h2>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", ...mono, fontSize: "0.85rem" }}>
                    <thead>
                      <tr style={{ color: "var(--dim)", textAlign: "left" }}>
                        <th style={{ padding: "0.35rem" }}>{t("strategist.col.ad")}</th>
                        <th style={{ padding: "0.35rem" }}>{t("strategist.col.funnel")}</th>
                        <th style={{ padding: "0.35rem" }}>{t("strategist.col.spend")}</th>
                        <th style={{ padding: "0.35rem" }}>{t("strategist.col.conversions")}</th>
                        <th style={{ padding: "0.35rem" }}>{t("strategist.col.cpa")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.ads.map((ad) => (
                        <tr
                          key={ad.metaAdId}
                          onClick={() => setSelectedAdId(ad.metaAdId)}
                          style={{
                            cursor: "pointer",
                            background: selectedAdId === ad.metaAdId ? "var(--raised)" : "transparent",
                            borderTop: "1px solid var(--line)",
                          }}
                        >
                          <td style={{ padding: "0.4rem" }}>
                            <span
                              style={{
                                display: "inline-block",
                                width: 4,
                                height: "1em",
                                background: bandColor(
                                  ad.funnelPosition.gateStatus === "ok" ? "healthy" : "insufficient_data",
                                ),
                                marginRight: 8,
                                verticalAlign: "middle",
                              }}
                            />
                            {ad.name ?? ad.metaAdId}
                          </td>
                          <td style={{ padding: "0.4rem" }}>
                            {ad.funnelPosition.gateStatus === "ok"
                              ? ad.funnelPosition.band
                              : t(`errors.${ad.funnelPosition.gateReasons[0] ?? "insufficient_data"}` as never)}
                          </td>
                          <td style={{ padding: "0.4rem" }}>{fmt(ad.spend.value)}</td>
                          <td style={{ padding: "0.4rem" }}>{fmt(ad.conversions.value, 0)}</td>
                          <td style={{ padding: "0.4rem" }}>{fmt(ad.cpa.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={panelStyle}>
                <h2 style={{ margin: "0 0 0.75rem", fontSize: "1rem" }}>{t("strategist.detail")}</h2>
                {selectedAd ? (
                  <>
                    <p style={{ marginTop: 0 }}>{selectedAd.name ?? selectedAd.metaAdId}</p>
                    <div style={{ display: "grid", gap: "0.5rem", marginBottom: "1rem", ...mono, fontSize: "0.85rem" }}>
                      <div>{t("strategist.col.spend")}: {fmt(selectedAd.spend.value)} ({fmtDelta(selectedAd.spend)})</div>
                      <div>{t("strategist.col.impressions")}: {fmt(selectedAd.impressions.value, 0)}</div>
                      <div>{t("strategist.col.netNewReach")}: {fmt(selectedAd.netNewReach.value, 0)}</div>
                      <div>
                        {t("strategist.col.funnel")}:{" "}
                        {selectedAd.funnelPosition.gateStatus === "ok"
                          ? `${selectedAd.funnelPosition.band} (${fmt(selectedAd.funnelPosition.score)})`
                          : t(`errors.${selectedAd.funnelPosition.gateReasons[0] ?? "insufficient_data"}` as never)}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                      <button type="button" disabled={busy} onClick={() => void runReview("copychief", true)} style={actionBtn}>
                        {t("strategist.action.copychief")}
                      </button>
                      <button type="button" disabled={busy} onClick={() => void runReview("cro", false)} style={actionBtn}>
                        {t("strategist.action.croPreview")}
                      </button>
                      <button type="button" disabled={busy} onClick={() => void runReview("cro", true)} style={actionBtn}>
                        {t("strategist.action.cro")}
                      </button>
                      <button type="button" disabled={busy} onClick={() => void runReview("variations", true)} style={actionBtn}>
                        {t("strategist.action.variations")}
                      </button>
                    </div>
                    {previewPacket ? (
                      <pre
                        style={{
                          ...mono,
                          marginTop: "1rem",
                          whiteSpace: "pre-wrap",
                          background: "var(--raised)",
                          padding: "0.75rem",
                          borderRadius: "var(--radius)",
                          fontSize: "0.8rem",
                        }}
                      >
                        {previewPacket}
                      </pre>
                    ) : null}
                  </>
                ) : (
                  <p style={{ color: "var(--dim)" }}>{t("strategist.selectAd")}</p>
                )}
              </div>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

const actionBtn: React.CSSProperties = {
  background: "var(--raised)",
  color: "var(--fg)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius)",
  padding: "0.45rem 0.7rem",
  cursor: "pointer",
};
