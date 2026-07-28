"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

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
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 1100,
        margin: "2rem auto",
        padding: "0 1rem",
      }}
    >
      <h1>Metriken (Etappe 3)</h1>
      <p style={{ color: "#666" }}>
        Prüfoberfläche für Leitmetrik, Funnel-Position und Creative Strain. Codes
        kommen vom Backend; Texte hier sind nur Beschriftung.
      </p>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Leitmetrik anlegen</h2>
        <form
          onSubmit={(event) => void createMetric(event)}
          style={{ display: "grid", gap: "0.5rem", maxWidth: 520 }}
        >
          <label>
            Label
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label>
            Aktionstypen (kommagetrennt)
            <input
              value={actionTypes}
              onChange={(event) => setActionTypes(event.target.value)}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label>
            Aggregation
            <select
              value={aggregation}
              onChange={(event) => setAggregation(event.target.value)}
            >
              <option value="coalesce_aliases">coalesce_aliases</option>
              <option value="first_present">first_present</option>
              <option value="sum_disjoint">sum_disjoint</option>
            </select>
          </label>
          <label>
            Nenner
            <select
              value={denominator}
              onChange={(event) => setDenominator(event.target.value)}
            >
              <option value="link_clicks">link_clicks</option>
              <option value="clicks">clicks</option>
              <option value="impressions">impressions</option>
              <option value="landing_page_views">landing_page_views</option>
              <option value="none">kein Nenner</option>
            </select>
          </label>
          <label>
            Wertquelle
            <select
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
              <label>
                Fixed value
                <input
                  value={fixedValue}
                  onChange={(event) => setFixedValue(event.target.value)}
                />
              </label>
              <label>
                Währung
                <input
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value)}
                />
              </label>
            </>
          )}
          <button type="submit" disabled={busy}>
            Anlegen
          </button>
        </form>
      </section>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Zuordnung</h2>
        <label>
          Werbekonto
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            style={{ display: "block" }}
          >
            <option value="">—</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.currency})
              </option>
            ))}
          </select>
        </label>
        <ul>
          {metrics.map((metric) => (
            <li key={`${metric.id}:${metric.version}`}>
              {metric.label} v{metric.version}{" "}
              <button
                type="button"
                disabled={!accountId || busy}
                onClick={() => void assignMetric(metric.id)}
              >
                Zuordnen
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Auswertung</h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <label>
            Von
            <input
              type="date"
              value={windowStart}
              onChange={(event) => setWindowStart(event.target.value)}
            />
          </label>
          <label>
            Bis
            <input
              type="date"
              value={windowEnd}
              onChange={(event) => setWindowEnd(event.target.value)}
            />
          </label>
          <button type="button" disabled={busy} onClick={() => void resolve()}>
            Kennzahlen laden
          </button>
        </div>
      </section>

      {error && (
        <p style={{ color: "crimson" }}>
          Fehlercode: <code>{error}</code>
        </p>
      )}

      {resolved && (
        <>
          <section style={{ marginBottom: "1.5rem" }}>
            <h2>metricDefinition</h2>
            <pre
              style={{
                background: "#f4f4f4",
                padding: "0.75rem",
                overflow: "auto",
              }}
            >
              {JSON.stringify(resolved.metricDefinition, null, 2)}
            </pre>
            <p>
              Kontosumme Spend: {resolved.accountTotals.spend}{" "}
              {resolved.accountCurrency} · Zähler:{" "}
              {resolved.accountTotals.numerator ?? "null"} · CPA:{" "}
              {resolved.accountTotals.cpa ?? "null"}
            </p>
          </section>

          <section>
            <h2>Anzeigen</h2>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.9rem",
              }}
            >
              <thead>
                <tr>
                  <th align="left">Ad</th>
                  <th align="right">Spend</th>
                  <th align="right">Zähler</th>
                  <th align="right">CVR</th>
                  <th align="left">Funnel</th>
                  <th align="left">Strain</th>
                  <th align="left">Gate</th>
                </tr>
              </thead>
              <tbody>
                {resolved.ads.map((ad) => (
                  <tr key={ad.metaAdId} style={{ borderTop: "1px solid #ddd" }}>
                    <td>
                      <code>{ad.metaAdId}</code>
                    </td>
                    <td align="right">{ad.spend}</td>
                    <td align="right">{ad.numerator ?? "null"}</td>
                    <td align="right">
                      {ad.cvr === null ? "null" : ad.cvr.toFixed(4)}
                    </td>
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
                    <td>
                      {formatGate([
                        ...(ad.funnelPosition?.gateReasons ?? []),
                        ...(ad.creativeStrain?.gateReasons ?? []),
                      ])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
