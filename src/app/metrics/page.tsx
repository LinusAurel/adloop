"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AppNav } from "@/components/AppNav";

interface AdAccount {
  id: string;
  name: string;
  currency: string;
  selected: boolean;
}

interface MetricDefinition {
  id: string;
  version: number;
  label: string;
  numeratorActionTypes: string[];
  numeratorAggregation: string;
  attributionSpec: string[];
  denominator: string | null;
  valueSource: string;
  fixedValue: number | null;
  currency: string | null;
  configuredBy: string;
}

interface AdRow {
  metaAdId: string;
  spend: number;
  impressions: number;
  numerator: number | null;
  denominator: number | null;
  cvr: number | null;
  cpa: number | null;
  metaRoas: { value: number | null; reason?: string };
  expectedValueRoas: { value: number | null; reason?: string };
  funnelPosition: {
    gateStatus: string;
    gateReasons: string[];
    score: number | null;
    band: string | null;
  } | null;
  creativeStrain: {
    gateStatus: string;
    gateReasons: string[];
    value: number | null;
  } | null;
}

interface ResolveResponse {
  metricDefinition: MetricDefinition;
  accountCurrency: string;
  accountTotals: {
    spend: number;
    numerator: number | null;
    cpa: number | null;
  };
  ads: AdRow[];
}

const GATE_TEXT: Readonly<Record<string, string>> = {
  below_minimum_spend: "Unter Mindestausgabe",
  below_minimum_impressions: "Unter Mindest-Impressions",
  zero_reach: "Reichweite null",
  zero_denominator: "Nenner null",
  population_too_small: "Population zu klein",
  no_variance: "Keine Varianz",
  window_not_synced: "Fenster nicht synchronisiert",
  cumulative_reach_missing: "Kumulative Reichweite fehlt",
  attribution_not_synced: "Attribution nicht synchronisiert",
  window_too_short: "Fenster zu kurz",
  no_spend: "Keine Ausgabe",
  currency_mismatch: "Währungsabweichung",
  insufficient_data: "Zu wenig Daten",
};

const BAND_TEXT: Readonly<Record<string, string>> = {
  prospector: "Prospector",
  mixed: "Mixed",
  closer: "Closer",
};

function formatGate(reasons: string[]): string {
  if (reasons.length === 0) return "—";
  return reasons.map((reason) => GATE_TEXT[reason] ?? reason).join(", ");
}

export default function MetricsPage() {
  const t = useTranslations("metrics");
  const router = useRouter();
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [metrics, setMetrics] = useState<MetricDefinition[]>([]);
  const [accountId, setAccountId] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [resolved, setResolved] = useState<ResolveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [label, setLabel] = useState("Anfragen");
  const [actionTypes, setActionTypes] = useState(
    "offsite_conversion.fb_pixel_lead",
  );
  const [aggregation, setAggregation] = useState("coalesce_aliases");
  const [denominator, setDenominator] = useState("link_clicks");
  const [valueSource, setValueSource] = useState("fixed");
  const [fixedValue, setFixedValue] = useState("45");
  const [currency, setCurrency] = useState("EUR");

  const loadAccounts = useCallback(async () => {
    const response = await fetch("/api/auth/meta/status", { cache: "no-store" });
    if (response.status === 401) {
      router.push("/login");
      return;
    }
    if (!response.ok) return;
    const data = (await response.json()) as { adAccounts: AdAccount[] };
    setAccounts(data.adAccounts);
    const selected = data.adAccounts.find((account) => account.selected);
    if (selected) setAccountId((current) => current || selected.id);
  }, [router]);

  const loadMetrics = useCallback(async () => {
    const response = await fetch("/api/metrics", { cache: "no-store" });
    if (response.status === 401) {
      router.push("/login");
      return;
    }
    if (!response.ok) return;
    const data = (await response.json()) as { metrics: MetricDefinition[] };
    setMetrics(data.metrics);
  }, [router]);

  useEffect(() => {
    void loadAccounts();
    void loadMetrics();
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 29);
    setWindowEnd(end.toISOString().slice(0, 10));
    setWindowStart(start.toISOString().slice(0, 10));
  }, [loadAccounts, loadMetrics]);

  async function createMetric(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/metrics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label,
          numeratorActionTypes: actionTypes
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          numeratorAggregation: aggregation,
          denominator: denominator === "none" ? null : denominator,
          valueSource,
          fixedValue: valueSource === "fixed" ? Number(fixedValue) : null,
          currency: valueSource === "fixed" ? currency : null,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? "validation_error");
        return;
      }
      await loadMetrics();
    } finally {
      setBusy(false);
    }
  }

  async function assignMetric(metricId: string) {
    if (!accountId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/metrics/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metaAdAccountId: accountId,
          conversionMetricId: metricId,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? "assign_failed");
        return;
      }
    } finally {
      setBusy(false);
    }
  }

  async function resolve() {
    if (!accountId || !windowStart || !windowEnd) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        metaAdAccountId: accountId,
        windowStart,
        windowEnd,
      });
      const response = await fetch(`/api/metrics/resolve?${params}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? "resolve_failed");
        return;
      }
      setResolved((await response.json()) as ResolveResponse);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <AppNav />
      <main className="page" style={{ maxWidth: 1100 }}>
        <h1>{t("title")}</h1>
        <p>{t("lead")}</p>

        <div className="panel">
          <h2>{t("createMetric")}</h2>
          <form onSubmit={(event) => void createMetric(event)}>
            <label className="row">
              <span>{t("label")}</span>
              <input value={label} onChange={(event) => setLabel(event.target.value)} />
            </label>
            <label className="row">
              <span>{t("actionTypes")}</span>
              <input
                className="data"
                value={actionTypes}
                onChange={(event) => setActionTypes(event.target.value)}
              />
            </label>
            <label className="row">
              <span>{t("aggregation")}</span>
              <select
                className="data"
                value={aggregation}
                onChange={(event) => setAggregation(event.target.value)}
              >
                <option value="coalesce_aliases">coalesce_aliases</option>
                <option value="first_present">first_present</option>
                <option value="sum_disjoint">sum_disjoint</option>
              </select>
            </label>
            <label className="row">
              <span>{t("denominator")}</span>
              <select
                className="data"
                value={denominator}
                onChange={(event) => setDenominator(event.target.value)}
              >
                <option value="link_clicks">link_clicks</option>
                <option value="clicks">clicks</option>
                <option value="impressions">impressions</option>
                <option value="landing_page_views">landing_page_views</option>
                <option value="none">{t("noDenominator")}</option>
              </select>
            </label>
            <label className="row">
              <span>{t("valueSource")}</span>
              <select
                className="data"
                value={valueSource}
                onChange={(event) => setValueSource(event.target.value)}
              >
                <option value="fixed">fixed</option>
                <option value="meta_value">meta_value</option>
                <option value="none">none</option>
              </select>
            </label>
            {valueSource === "fixed" && (
              <>
                <label className="row">
                  <span>{t("fixedValue")}</span>
                  <input
                    className="data"
                    value={fixedValue}
                    onChange={(event) => setFixedValue(event.target.value)}
                  />
                </label>
                <label className="row">
                  <span>{t("currency")}</span>
                  <input
                    className="data"
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value)}
                  />
                </label>
              </>
            )}
            <button type="submit" className="btn pri" disabled={busy}>
              {t("create")}
            </button>
          </form>
        </div>

        <div className="panel">
          <h2>{t("assignment")}</h2>
          <label className="row">
            <span>{t("adAccount")}</span>
            <select
              className="data"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">—</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.currency})
                </option>
              ))}
            </select>
          </label>
          <div className="scroller">
            <table>
              <tbody>
                {metrics.map((metric) => (
                  <tr key={`${metric.id}:${metric.version}`}>
                    <td className="name">{metric.label}</td>
                    <td>v{metric.version}</td>
                    <td>
                      <button
                        type="button"
                        className="chip"
                        disabled={!accountId || busy}
                        onClick={() => void assignMetric(metric.id)}
                      >
                        {t("assign")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <h2>{t("evaluation")}</h2>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="field" style={{ marginBottom: 0, maxWidth: 170 }}>
              <span>{t("from")}</span>
              <input
                className="data"
                type="date"
                value={windowStart}
                onChange={(event) => setWindowStart(event.target.value)}
              />
            </label>
            <label className="field" style={{ marginBottom: 0, maxWidth: 170 }}>
              <span>{t("to")}</span>
              <input
                className="data"
                type="date"
                value={windowEnd}
                onChange={(event) => setWindowEnd(event.target.value)}
              />
            </label>
            <button type="button" className="btn pri" disabled={busy} onClick={() => void resolve()}>
              {t("load")}
            </button>
          </div>
        </div>

        {error && (
          <div className="msgbox err data" role="alert">
            {t("errorCode")}: {error}
          </div>
        )}

        {resolved && (
          <>
            <div className="cells">
              <div className="cell">
                <div className="k">spend</div>
                <div className="cv">{resolved.accountTotals.spend}</div>
                <div className="cd" style={{ color: "var(--dim)" }}>
                  {resolved.accountCurrency}
                </div>
              </div>
              <div className="cell">
                <div className="k">numerator</div>
                <div className="cv">{resolved.accountTotals.numerator ?? "—"}</div>
              </div>
              <div className="cell">
                <div className="k">cpa</div>
                <div className="cv">{resolved.accountTotals.cpa ?? "—"}</div>
              </div>
            </div>

            <details className="tool" style={{ marginBottom: 14 }}>
              <summary>
                <span className="tname">{t("definition")}</span>
              </summary>
              <div className="tbody">{JSON.stringify(resolved.metricDefinition, null, 2)}</div>
            </details>

            <h2 style={{ fontSize: 13, fontWeight: 640, margin: "0 0 8px" }}>{t("ads")}</h2>
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th>ad</th>
                    <th>spend</th>
                    <th>numerator</th>
                    <th>cvr</th>
                    <th>funnel</th>
                    <th>strain</th>
                    <th>{t("gate")}</th>
                  </tr>
                </thead>
                <tbody>
                  {resolved.ads.map((ad) => {
                    const gates = [
                      ...(ad.funnelPosition?.gateReasons ?? []),
                      ...(ad.creativeStrain?.gateReasons ?? []),
                    ];
                    return (
                      <tr key={ad.metaAdId}>
                        <td className="name data">{ad.metaAdId}</td>
                        <td>{ad.spend}</td>
                        <td>{ad.numerator ?? "—"}</td>
                        <td>{ad.cvr === null ? "—" : ad.cvr.toFixed(4)}</td>
                        <td>
                          {ad.funnelPosition?.band
                            ? `${BAND_TEXT[ad.funnelPosition.band] ?? ad.funnelPosition.band} (${ad.funnelPosition.score?.toFixed(3)})`
                            : "—"}
                        </td>
                        <td>
                          {ad.creativeStrain?.value === null ||
                          ad.creativeStrain?.value === undefined
                            ? "—"
                            : ad.creativeStrain.value.toFixed(1)}
                        </td>
                        <td style={{ textAlign: "left" }}>
                          {gates.length === 0 ? (
                            <span style={{ color: "var(--dim)" }}>{t("noGateReason")}</span>
                          ) : (
                            <span className="nogate">{formatGate(gates)}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
