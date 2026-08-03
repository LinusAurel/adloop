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

/**
 * In welche Richtung eine Kennzahl "besser" zeigt.
 *
 * Ohne diese Tabelle stand dieselbe Zahl an zwei Stellen in zwei Farben: die
 * Tabelle drehte das CPA-Delta richtig um, das Detailraster färbte pauschal
 * jedes Plus grün. Ein steigender Cost-per-Acquisition wurde damit der Person,
 * die darüber entscheidet, als gute Nachricht angezeigt.
 *
 * `spend` ist ausdrücklich neutral: mehr Ausgabe ist weder gut noch schlecht,
 * das hängt am Ergebnis daneben.
 */
const HIGHER_IS_BETTER: Readonly<Record<string, boolean | null>> = {
  spend: null,
  impressions: null,
  reach: null,
  conversions: true,
  conversionValue: true,
  ctr: true,
  netNewReach: true,
  cpa: false,
  cpm: false,
};

/** Zustandsklasse für ein Delta — leer, wo die Richtung nichts aussagt. */
function deltaTone(metric: string, changePct: number | null): string {
  if (changePct === null || changePct === 0) return "";
  const better = HIGHER_IS_BETTER[metric];
  if (better === null || better === undefined) return "";
  const good = changePct > 0 ? better : !better;
  return good ? "up" : "down";
}

type View = "list" | "detail";

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
  const [view, setView] = useState<View>("list");

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

  // Eine Anzeige, die das Data Gate nicht passiert, bekommt --none. Das ist
  // keine schlechte Bewertung, sondern gar keine — und muss sichtbar anders
  // aussehen als eine schlechte.
  function adColor(ad: OverviewResponse["ads"][number]): string {
    if (ad.funnelPosition.gateStatus !== "ok") return "var(--none)";
    return bandColor(ad.funnelPosition.band ?? "");
  }

  function gateText(ad: OverviewResponse["ads"][number]): string {
    return t(`errors.${ad.funnelPosition.gateReasons[0] ?? "insufficient_data"}` as never);
  }

  // Ein Anteil in Prozent für den Balken unter einer Kennzahl. Ohne Wert kein
  // Balken — ein Balken der Breite 0 liest sich wie „null“, nicht wie „unbekannt“.
  function meterPct(index: PulseIndex): number | null {
    if (index.value === null) return null;
    return Math.max(0, Math.min(100, Math.round(index.value)));
  }

  return (
    <div>
      <AppNav />

      {/* Zweite Leiste: Konto, Zeitfenster, Ansicht. Sie trägt dieselben
          Bauteile wie die Hauptleiste, damit kein zweites Formular entsteht. */}
      <div className="bar tools">
        {/* Ohne Konten wäre das ein leeres Feld, das nach einem Fehler aussieht.
            Der Leerzustand darunter sagt bereits, was zu tun ist. */}
        {accounts.length > 0 && (
          <select
            style={{ width: "auto", padding: "5px 10px", fontSize: "var(--fs-label)" }}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            aria-label={t("strategist.adAccount")}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        )}
        <div className="seg" role="group" aria-label={t("strategist.timeWindow")}>
          {(["30", "90"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={preset === value}
              onClick={() => setPreset(value)}
            >
              {value === "30" ? t("strategist.window30") : t("strategist.window90")}
            </button>
          ))}
        </div>

        <span className="right">
          <div className="seg" role="group" aria-label={t("strategist.view")}>
            {(["list", "detail"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => setView(value)}
              >
                {value === "list" ? t("strategist.overview") : t("strategist.detail")}
              </button>
            ))}
          </div>
          {/* Kein Segment: Auffrischen ist eine Handlung, keine Auswahl. */}
          <button type="button" className="btn" disabled={busy} onClick={() => void refreshSync()}>
            {busy ? t("strategist.syncing") : t("strategist.refreshSync")}
          </button>
        </span>
      </div>

      {error ? (
        <div className="page">
          <div className="msgbox err" role="alert">
            {error}
          </div>
        </div>
      ) : null}

      {overview ? (
        <>
          <div className="pulse">
            {(
              [
                ["overall", overview.pulse.overall],
                ["creativeStrain", overview.pulse.creativeStrain],
                ["spendEfficiency", overview.pulse.spendEfficiency],
                ["accountHealth", overview.pulse.accountHealth],
              ] as const
            ).map(([key, index]) => {
              const pct = meterPct(index);
              return (
                <div key={key}>
                  <div className="k">{t(`strategist.pulseIndex.${key}`)}</div>
                  <div className="v" style={{ color: bandColor(index.band) }}>
                    {index.value === null ? "—" : Math.round(index.value)}
                  </div>
                  {pct === null ? (
                    <div className="nogate" style={{ marginTop: 6 }}>
                      {pulseLabel(index)}
                    </div>
                  ) : (
                    <div className="meter">
                      <i style={{ width: `${pct}%`, background: bandColor(index.band) }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* SPEC §6.3: Beruht die Leitmetrik auf einem Rückfall statt auf einer
              Konfiguration, sagt die Oberfläche das — statt eine Zahl zu
              behaupten, die auf einer Vermutung steht. */}
          {overview.metricDefinition.configuredBy === "fallback" && (
            <div className="msgbox warn" style={{ margin: "12px 16px 0" }}>
              {t("strategist.metricFallback")}
            </div>
          )}

          <div
            className="crumb"
            style={{ padding: "8px 16px", borderBottom: "1px solid var(--line)" }}
          >
            {overview.windowStart} → {overview.windowEnd} · dataAsOf {overview.dataAsOf} ·{" "}
            {overview.metricDefinition.label} v{overview.metricDefinition.version} ·{" "}
            <span
              style={{
                color:
                  overview.metricDefinition.configuredBy === "user"
                    ? "var(--dim)"
                    : "var(--warn)",
              }}
            >
              {t(`strategist.configuredBy.${overview.metricDefinition.configuredBy}` as never)}
            </span>
          </div>

          {view === "list" ? (
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th>{t("strategist.col.ad")}</th>
                    <th>{t("strategist.col.funnel")}</th>
                    <th>{t("strategist.col.spend")}</th>
                    <th>{t("strategist.col.conversions")}</th>
                    <th>{t("strategist.col.cpa")}</th>
                    <th>{t("strategist.col.impressions")}</th>
                    <th>{t("strategist.col.netNewReach")}</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.ads.map((ad) => {
                    const gated = ad.funnelPosition.gateStatus !== "ok";
                    return (
                      <tr
                        key={ad.metaAdId}
                        className="pick"
                        aria-current={selectedAdId === ad.metaAdId ? "true" : "false"}
                        onClick={() => {
                          setSelectedAdId(ad.metaAdId);
                          setView("detail");
                        }}
                      >
                        <td className="name">
                          <i
                            className={`stripe${adColor(ad) === "var(--none)" ? " none" : ""}`}
                            style={{ background: adColor(ad) }}
                          />
                          {ad.name ?? ad.metaAdId}
                        </td>
                        <td>
                          {gated ? (
                            <span className="nogate">{gateText(ad)}</span>
                          ) : (
                            <span className="band" style={{ color: adColor(ad) }}>
                              {ad.funnelPosition.band}
                            </span>
                          )}
                        </td>
                        <td>{fmt(ad.spend.value)}</td>
                        <td>{fmt(ad.conversions.value, 0)}</td>
                        <td>
                          {fmt(ad.cpa.value)}
                          {ad.cpa.changePct !== null && (
                            <span className={`delta ${deltaTone("cpa", ad.cpa.changePct)}`}>
                              {fmtDelta(ad.cpa)}
                            </span>
                          )}
                        </td>
                        <td>{fmt(ad.impressions.value, 0)}</td>
                        <td>{fmt(ad.netNewReach.value, 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="split">
              <div className="lcol">
                <div className="lhead">
                  <span>{t("strategist.ads")}</span>
                  <span className="n">{overview.ads.length}</span>
                </div>
                {overview.ads.map((ad) => (
                  <button
                    key={ad.metaAdId}
                    type="button"
                    className="item"
                    aria-current={selectedAdId === ad.metaAdId ? "true" : "false"}
                    onClick={() => setSelectedAdId(ad.metaAdId)}
                  >
                    <div className="t">
                      <i
                            className={`stripe${adColor(ad) === "var(--none)" ? " none" : ""}`}
                            style={{ background: adColor(ad) }}
                          />
                      {ad.name ?? ad.metaAdId}
                    </div>
                    <div className="m">
                      <span>{fmt(ad.spend.value)}</span>
                      {ad.funnelPosition.gateStatus === "ok" ? (
                        <span style={{ color: adColor(ad) }}>{fmt(ad.funnelPosition.score, 0)}</span>
                      ) : (
                        <span className="nogate">{t("strategist.noVerdict")}</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>

              <div className="rcol">
                {selectedAd ? (
                  <>
                    <div className="rhead">
                      <h3>{selectedAd.name ?? selectedAd.metaAdId}</h3>
                      <span className="meta">
                        {overview.windowStart} → {overview.windowEnd}
                      </span>
                    </div>

                    <div className="cells">
                      {(
                        [
                          ["spend", selectedAd.spend, 2],
                          ["conversions", selectedAd.conversions, 0],
                          ["cpa", selectedAd.cpa, 2],
                          ["ctr", selectedAd.ctr, 2],
                          ["impressions", selectedAd.impressions, 0],
                          ["netNewReach", selectedAd.netNewReach, 0],
                        ] as const
                      ).map(([key, value, digits]) => (
                        <div className="cell" key={key}>
                          <div className="k">{t(`strategist.col.${key}` as never)}</div>
                          <div className="cv">{fmt(value.value, digits)}</div>
                          <div
                            className={`cd ${deltaTone(key, value.changePct)}`}
                          >
                            {fmtDelta(value)}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="verdict">
                      {selectedAd.funnelPosition.gateStatus === "ok" ? (
                        <>
                          <h4>
                            {t("strategist.col.funnel")}
                            <span className="score" style={{ color: adColor(selectedAd) }}>
                              {fmt(selectedAd.funnelPosition.score, 0)}
                            </span>
                            <span style={{ color: "var(--dim)", fontWeight: 400 }}>
                              {selectedAd.funnelPosition.band}
                            </span>
                          </h4>
                          <div className="signals">
                            <span>
                              {t("strategist.col.netNewReach")}{" "}
                              <b className={deltaTone("netNewReach", selectedAd.netNewReach.changePct)}>
                                {fmtDelta(selectedAd.netNewReach)}
                              </b>
                            </span>
                            <span>
                              {t("strategist.col.ctr")}{" "}
                              <b className={deltaTone("ctr", selectedAd.ctr.changePct)}>{fmtDelta(selectedAd.ctr)}</b>
                            </span>
                          </div>
                        </>
                      ) : (
                        <>
                          <h4>{t("strategist.col.funnel")}</h4>
                          {/* Kein Urteil ist kein schlechtes Urteil — deshalb hier
                              kein Score und keine Zustandsfarbe, sondern der Grund. */}
                          <p className="nogate">{gateText(selectedAd)}</p>
                        </>
                      )}
                    </div>

                    <div className="acts">
                      <button
                        type="button"
                        className="btn pri"
                        disabled={busy}
                        onClick={() => void runReview("variations", true)}
                      >
                        {t("strategist.action.variations")}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void runReview("copychief", true)}
                      >
                        {t("strategist.action.copychief")}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void runReview("cro", true)}
                      >
                        {t("strategist.action.cro")}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void runReview("cro", false)}
                      >
                        {t("strategist.action.croPreview")}
                      </button>
                    </div>

                    {previewPacket ? (
                      <details className="tool" open style={{ marginTop: 14 }}>
                        <summary>
                          <span className="tname">{t("strategist.action.croPreview")}</span>
                        </summary>
                        <div className="tbody">{previewPacket}</div>
                      </details>
                    ) : null}
                  </>
                ) : (
                  <p style={{ color: "var(--dim)" }}>{t("strategist.selectAd")}</p>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        // Zwei verschiedene Leerzustände: gar kein Konto ist ein Einrichtungs-
        // schritt, kein Wert im Fenster ist eine Frage des Zeitraums. Sie
        // brauchen unterschiedliche nächste Schritte.
        <div className="empty">
          {accounts.length === 0 ? (
            <>
              <h3>{t("empty.strategistNoAccount")}</h3>
              <p>{t("empty.strategistNoAccountBody")}</p>
              <a className="btn" href="/connectors">
                {t("empty.goToConnectors")}
              </a>
            </>
          ) : (
            <>
              <h3>{t("empty.strategistNoData")}</h3>
              <p>{t("empty.strategistNoDataBody")}</p>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void refreshSync()}
              >
                {t("strategist.refreshSync")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
