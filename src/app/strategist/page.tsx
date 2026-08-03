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

type SortKey = "name" | "funnel" | "spend" | "conversions" | "cpa" | "impressions" | "netNewReach";

/** Der Wert, nach dem eine Spalte sortiert. `null` heißt "kein Wert". */
function sortValue(ad: OverviewResponse["ads"][number], key: SortKey): number | string | null {
  switch (key) {
    case "name":
      return (ad.name ?? ad.metaAdId).toLowerCase();
    case "funnel":
      return ad.funnelPosition.gateStatus === "ok" ? (ad.funnelPosition.score ?? null) : null;
    case "spend":
      return ad.spend.value;
    case "conversions":
      return ad.conversions.value;
    case "cpa":
      return ad.cpa.value;
    case "impressions":
      return ad.impressions.value;
    case "netNewReach":
      return ad.netNewReach.value;
  }
}

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
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "spend",
    dir: "desc",
  });
  const [filter, setFilter] = useState("");

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

  // Filtern, dann sortieren. Anzeigen ohne Wert in der Sortierspalte landen
  // immer am Ende — eine gesperrte Anzeige ist keine mit dem Wert null, und
  // sie soll die Spitze der Liste nicht besetzen.
  const rows = (() => {
    if (!overview) return [];
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? overview.ads.filter((ad) => (ad.name ?? ad.metaAdId).toLowerCase().includes(needle))
      : overview.ads;

    return [...filtered].sort((a, b) => {
      const left = sortValue(a, sort.key);
      const right = sortValue(b, sort.key);
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      const order =
        typeof left === "string" && typeof right === "string"
          ? left.localeCompare(right)
          : Number(left) - Number(right);
      return sort.dir === "asc" ? order : -order;
    });
  })();

  // Summen über das, was gerade sichtbar ist — ein Filter, der die Summe nicht
  // mitzieht, beantwortet die Frage "was kostet diese Auswahl" falsch.
  const totals = rows.reduce(
    (acc, ad) => ({
      spend: acc.spend + (ad.spend.value ?? 0),
      conversions: acc.conversions + (ad.conversions.value ?? 0),
      impressions: acc.impressions + (ad.impressions.value ?? 0),
    }),
    { spend: 0, conversions: 0, impressions: 0 },
  );
  // Gewichteter CPA, nicht das Mittel der Spalte: der Durchschnitt von
  // Durchschnitten gewichtet eine Anzeige mit zwei Konversionen so stark wie
  // eine mit zweihundert.
  const totalCpa = totals.conversions > 0 ? totals.spend / totals.conversions : null;

  function toggleSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : // Zahlen fangen groß an, Namen alphabetisch — was man beim ersten
          // Klick erwartet, ist je nach Spalte verschieden.
          { key, dir: key === "name" ? "asc" : "desc" },
    );
  }

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
        <input
          className="filter"
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("strategist.filterPlaceholder")}
          aria-label={t("strategist.filterPlaceholder")}
          autoComplete="off"
        />

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
                {/* Feste Spaltenbreiten: ohne sie verteilt der Browser die
                    Breite nach Inhalt, und zwischen Anzeigenname und Urteil
                    entsteht ein leerer Korridor von mehreren hundert Pixeln,
                    den das Auge bei jeder Zeile überqueren muss. */}
                <colgroup>
                  <col style={{ width: "auto", minWidth: 260 }} />
                  <col style={{ width: 140 }} />
                  {["spend", "conversions", "cpa", "impressions", "netNewReach"].map((key) => (
                    <col key={key} style={{ width: 116 }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    {(
                      [
                        ["name", "ad"],
                        ["funnel", "funnel"],
                        ["spend", "spend"],
                        ["conversions", "conversions"],
                        ["cpa", "cpa"],
                        ["impressions", "impressions"],
                        ["netNewReach", "netNewReach"],
                      ] as const
                    ).map(([key, label]) => (
                      <th
                        key={key}
                        aria-sort={
                          sort.key === key
                            ? sort.dir === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                      >
                        <button type="button" className="sortable" onClick={() => toggleSort(key)}>
                          {t(`strategist.col.${label}` as never)}
                          <span aria-hidden="true">
                            {sort.key === key ? (sort.dir === "asc" ? "↑" : "↓") : ""}
                          </span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((ad) => {
                    const gated = ad.funnelPosition.gateStatus !== "ok";
                    return (
                      <tr
                        key={ad.metaAdId}
                        aria-current={selectedAdId === ad.metaAdId ? "true" : undefined}
                      >
                        <td className="name">
                          {/* Der Knopf trägt die Auswahl, nicht die Zeile: eine
                              <tr> mit onClick ist per Tastatur nicht erreichbar,
                              und genau das ist die Haupthandlung dieser Ansicht. */}
                          <button
                            type="button"
                            className="rowlink"
                            onClick={() => {
                              setSelectedAdId(ad.metaAdId);
                              setView("detail");
                            }}
                          >
                            <i
                              className={`stripe${adColor(ad) === "var(--none)" ? " none" : ""}`}
                              style={{ background: adColor(ad) }}
                            />
                            {ad.name ?? ad.metaAdId}
                          </button>
                        </td>
                        <td>
                          {gated ? (
                            <span className="nogate">{gateText(ad)}</span>
                          ) : (
                            <span className="band" style={{ color: adColor(ad) }}>
                              {t(`strategist.pulseBand.${ad.funnelPosition.band}` as never)}
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
                {rows.length > 0 && (
                  <tfoot>
                    <tr>
                      <td className="name">
                        {t("strategist.total", { count: rows.length })}
                      </td>
                      <td />
                      <td>{fmt(totals.spend)}</td>
                      <td>{fmt(totals.conversions, 0)}</td>
                      <td>{totalCpa === null ? "—" : fmt(totalCpa)}</td>
                      <td>{fmt(totals.impressions, 0)}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
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
                              {t(`strategist.pulseBand.${selectedAd.funnelPosition.band}` as never)}
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
