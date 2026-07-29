"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AppNav } from "@/components/AppNav";
import {
  AttributionClickSchema,
  AttributionEngagedSchema,
  AttributionViewSchema,
  BidStrategySchema,
  BillingEventSchema,
  BudgetModeSchema,
  CallToActionSchema,
  CampaignObjectiveSchema,
  OptimizationGoalSchema,
  type AdvertiserDefaults,
} from "@/publish/settings";

interface AdvertiserOption {
  id: string;
  name: string;
}

/** Die elf Advantage+-Schalter, in der Reihenfolge des Schemas. */
const ADVANTAGE_TOGGLES = [
  "advantagePlusCreative",
  "visualTouchUps",
  "textImprovements",
  "addOverlays",
  "musicOverlay",
  "imageAnimation",
  "generateBackgrounds",
  "enhanceCta",
  "translateText",
  "profileAndCard",
  "dynamicDescription",
] as const;

const CREATIVE_FORMATS = ["image", "video", "carousel"] as const;

const PLACEMENTS = [
  "advantagePlus",
  "facebook",
  "instagram",
  "audienceNetwork",
  "messenger",
] as const;

/**
 * Eine Kopie mit einem geänderten Feld. Die Vorgaben sind vier Ebenen tief;
 * ohne so etwas müsste jede Änderung ihren eigenen Spread-Ausdruck schreiben,
 * und genau dabei fallen Felder still unter den Tisch — das war der Grund,
 * warum die vorige Fassung nur zwölf von sechsundzwanzig Feldern kannte.
 */
function withPath<T>(source: T, path: readonly (string | number)[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  if (Array.isArray(source)) {
    const copy = [...source];
    copy[head as number] = withPath(copy[head as number], rest, value);
    return copy as T;
  }
  const object = (source ?? {}) as Record<string, unknown>;
  return {
    ...object,
    [head as string]: withPath(object[head as string], rest, value),
  } as T;
}

function read(source: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>(
    (acc, key) => (acc === null || acc === undefined ? acc : (acc as Record<string, unknown>)[key as string]),
    source,
  );
}

/** Zeilenweise Liste ↔ Array. Leere Zeilen zählen nicht als Eintrag. */
function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export default function SettingsPage() {
  const t = useTranslations();
  const [advertisers, setAdvertisers] = useState<AdvertiserOption[]>([]);
  const [advertiserId, setAdvertiserId] = useState("");
  const [settings, setSettings] = useState<AdvertiserDefaults | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadAdvertisers = useCallback(async () => {
    const res = await fetch("/api/advertisers", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { advertisers: AdvertiserOption[] };
    setAdvertisers(data.advertisers);
    if (data.advertisers[0] && !advertiserId) setAdvertiserId(data.advertisers[0].id);
  }, [advertiserId]);

  const loadDefaults = useCallback(async () => {
    if (!advertiserId) return;
    const res = await fetch(`/api/meta/ad-account-settings?advertiserId=${advertiserId}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      version: number | null;
      settings: AdvertiserDefaults | null;
    };
    setVersion(data.version);
    setSettings(data.settings);
    setSaved(false);
  }, [advertiserId]);

  useEffect(() => {
    void loadAdvertisers();
  }, [loadAdvertisers]);

  useEffect(() => {
    void loadDefaults();
  }, [loadDefaults]);

  function set(path: readonly (string | number)[], value: unknown) {
    setSettings((current) => (current ? withPath(current, path, value) : current));
    setSaved(false);
  }

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/meta/ad-account-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ advertiserId, expectedVersion: version, settings }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = body?.error ?? "validation_error";
        setError(code);
        // Bei einem Versionskonflikt hat jemand anderes gespeichert. Neu laden,
        // statt die eigene Fassung darüberzuschreiben.
        if (code === "settings_version_conflict") await loadDefaults();
        return;
      }
      const data = (await res.json()) as { version: number; settings: AdvertiserDefaults };
      setVersion(data.version);
      setSettings(data.settings);
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  // ── kleine Bausteine, die alle denselben Pfad-Mechanismus benutzen ──

  function textRow(path: readonly string[], label: string, mono = true) {
    return (
      <label className="row" key={path.join(".")}>
        <span>{label}</span>
        <input
          className={mono ? "data" : undefined}
          value={(read(settings, path) as string | null) ?? ""}
          onChange={(e) => set(path, e.target.value === "" ? null : e.target.value)}
        />
      </label>
    );
  }

  function numberRow(path: readonly string[], label: string, min?: number, max?: number) {
    const value = read(settings, path);
    return (
      <label className="row" key={path.join(".")}>
        <span>{label}</span>
        <input
          type="number"
          min={min}
          max={max}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => set(path, e.target.value === "" ? undefined : Number(e.target.value))}
        />
      </label>
    );
  }

  function selectRow(path: readonly string[], label: string, options: readonly string[]) {
    return (
      <label className="row" key={path.join(".")}>
        <span>{label}</span>
        <select
          className="data"
          value={(read(settings, path) as string) ?? options[0]}
          onChange={(e) => set(path, e.target.value)}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  function checkbox(path: readonly string[], label: string) {
    return (
      <label className="check" key={path.join(".")}>
        <input
          type="checkbox"
          checked={Boolean(read(settings, path))}
          onChange={(e) => set(path, e.target.checked)}
        />
        <span>{label}</span>
      </label>
    );
  }

  function linesRow(path: readonly string[], label: string, hint: string) {
    const value = (read(settings, path) as string[] | undefined) ?? [];
    return (
      <label className="field" key={path.join(".")}>
        <span>{label}</span>
        <textarea
          className="lines"
          rows={4}
          value={value.join("\n")}
          onChange={(e) => set(path, linesToArray(e.target.value))}
          spellCheck={false}
        />
        <div className="hint">
          {hint} · {value.length}
        </div>
      </label>
    );
  }

  function panel(title: string, children: ReactNode) {
    return (
      <div className="panel">
        <h2>{title}</h2>
        {children}
      </div>
    );
  }

  return (
    <div>
      <AppNav />
      <main className="page" style={{ maxWidth: 940 }}>
        <h1>{t("settings.title")}</h1>
        <p>
          {t("settings.subtitle")}
          {version !== null ? ` · v${version}` : ""}
        </p>

        <label className="row" style={{ marginBottom: 14 }}>
          <span>{t("settings.advertiser")}</span>
          <select value={advertiserId} onChange={(e) => setAdvertiserId(e.target.value)}>
            {advertisers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        {!settings ? (
          <div className="empty">
            <h3>{t("settings.noDefaults")}</h3>
            <p>{t("settings.noDefaultsBody")}</p>
          </div>
        ) : (
          <>
            {panel(t("settings.identity"), (
              <>
                {textRow(["identity", "pageId"], t("settings.pageId"))}
                {textRow(["identity", "instagramActorId"], t("settings.instagramActorId"))}
                {textRow(["identity", "beneficiaryName"], t("settings.beneficiaryName"), false)}
                {textRow(["identity", "payerName"], t("settings.payerName"), false)}
                <div className="hint">{t("settings.dsaHint")}</div>
              </>
            ))}

            {panel(t("settings.campaign"), (
              <>
                {selectRow(["campaignObjective"], t("settings.objective"), CampaignObjectiveSchema.options)}
                {selectRow(["adSet", "budgetMode"], t("settings.budgetMode"), BudgetModeSchema.options)}
              </>
            ))}

            {panel(t("settings.adSet"), (
              <>
                {selectRow(["adSet", "optimizationGoal"], t("settings.optimizationGoal"), OptimizationGoalSchema.options)}
                {selectRow(["adSet", "billingEvent"], t("settings.billingEvent"), BillingEventSchema.options)}
                {selectRow(["adSet", "bidStrategy"], t("settings.bidStrategy"), BidStrategySchema.options)}
                {/* Nur sinnvoll, wenn die Gebotsstrategie eine Obergrenze kennt —
                    sonst ist das Feld eine Eingabe ohne Wirkung. */}
                {(read(settings, ["adSet", "bidStrategy"]) as string) !== "LOWEST_COST_WITHOUT_CAP" &&
                  numberRow(["adSet", "bidAmount"], t("settings.bidAmount"), 1)}
              </>
            ))}

            {panel(t("settings.targeting"), (
              <>
                <label className="row">
                  <span>{t("settings.countries")}</span>
                  <input
                    className="data"
                    value={((read(settings, ["adSet", "targeting", "countries"]) as string[]) ?? []).join(",")}
                    onChange={(e) =>
                      set(
                        ["adSet", "targeting", "countries"],
                        e.target.value
                          .split(",")
                          .map((c) => c.trim().toUpperCase())
                          .filter(Boolean),
                      )
                    }
                  />
                </label>
                {numberRow(["adSet", "targeting", "ageMin"], t("settings.ageMin"), 13, 65)}
                {numberRow(["adSet", "targeting", "ageMax"], t("settings.ageMax"), 13, 65)}
                <div className="row">
                  <span>{t("settings.genders")}</span>
                  <div className="checks">
                    {([1, 2] as const).map((g) => {
                      const list = (read(settings, ["adSet", "targeting", "genders"]) as number[]) ?? [];
                      return (
                        <label className="check" key={g}>
                          <input
                            type="checkbox"
                            checked={list.includes(g)}
                            onChange={(e) =>
                              set(
                                ["adSet", "targeting", "genders"],
                                e.target.checked ? [...list, g].sort() : list.filter((x) => x !== g),
                              )
                            }
                          />
                          <span>{g === 1 ? t("settings.male") : t("settings.female")}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                {/* Leere Liste heißt bei Meta "alle" — das muss dastehen, sonst
                    liest sich der leere Zustand wie "niemand". */}
                <div className="hint">{t("settings.gendersHint")}</div>
              </>
            ))}

            {panel(t("settings.placements"), (
              <div className="checks">
                {PLACEMENTS.map((p) =>
                  checkbox(["adSet", "placements", p], t(`settings.placement.${p}` as never)),
                )}
              </div>
            ))}

            {panel(t("settings.audiences"), (
              <>
                {checkbox(["adSet", "audiences", "advantagePlusEnabled"], t("settings.advantageAudience"))}
                {linesRow(
                  ["adSet", "audiences", "includedCustomAudienceIds"],
                  t("settings.includedAudiences"),
                  t("settings.oneIdPerLine"),
                )}
                {linesRow(
                  ["adSet", "audiences", "excludedCustomAudienceIds"],
                  t("settings.excludedAudiences"),
                  t("settings.oneIdPerLine"),
                )}
              </>
            ))}

            {panel(t("settings.attribution"), (
              <>
                {selectRow(["adSet", "attribution", "click"], t("settings.attrClick"), AttributionClickSchema.options)}
                {selectRow(["adSet", "attribution", "view"], t("settings.attrView"), AttributionViewSchema.options)}
                {selectRow(["adSet", "attribution", "engaged"], t("settings.attrEngaged"), AttributionEngagedSchema.options)}
                {/* Das Attributionsfenster entscheidet, welche Konversionen
                    überhaupt gezählt werden — ein Wechsel macht Zahlen vor und
                    nach ihm unvergleichbar. */}
                <div className="hint">{t("settings.attrHint")}</div>
              </>
            ))}

            {panel(t("settings.schedule"), (
              <>
                {textRow(["adSet", "schedule", "timezone"], t("settings.timezone"))}
                {numberRow(["adSet", "schedule", "offsetDays"], t("settings.offsetDays"), 0, 30)}
                {textRow(["adSet", "schedule", "time"], t("settings.startTime"))}
              </>
            ))}

            {panel(t("settings.defaultAdCopy"), (
              <>
                {linesRow(["defaultAdCopy", "primaryTexts"], t("settings.primaryTexts"), t("settings.oneVariantPerLine"))}
                {linesRow(["defaultAdCopy", "headlines"], t("settings.headlines"), t("settings.oneVariantPerLine"))}
                {linesRow(["defaultAdCopy", "descriptions"], t("settings.descriptions"), t("settings.oneVariantPerLine"))}
                {selectRow(["defaultAdCopy", "callToAction"], t("settings.callToAction"), CallToActionSchema.options)}
              </>
            ))}

            {panel(t("settings.creative"), (
              <>
                {CREATIVE_FORMATS.map((format) => {
                  const active = ADVANTAGE_TOGGLES.filter((toggle) =>
                    Boolean(read(settings, ["creative", format, toggle])),
                  ).length;
                  return (
                    <details className="fold" key={format}>
                      <summary>
                        {t(`settings.format.${format}` as never)}
                        <span className="count">
                          {active}/{ADVANTAGE_TOGGLES.length}
                        </span>
                      </summary>
                      <div className="checks">
                        {ADVANTAGE_TOGGLES.map((toggle) =>
                          checkbox(["creative", format, toggle], t(`settings.advantage.${toggle}` as never)),
                        )}
                      </div>
                    </details>
                  );
                })}
              </>
            ))}

            {panel(t("settings.website"), (
              <>
                {textRow(["website", "url"], t("settings.websiteUrl"))}
                {textRow(["website", "utmParams"], t("settings.utmParams"))}
              </>
            ))}

            {panel(t("settings.autoNaming"), (
              <>
                {textRow(["autoNaming", "creativeTemplate"], t("settings.creativeTemplate"))}
                {textRow(["autoNaming", "adSetTemplate"], t("settings.adSetTemplate"))}
                {textRow(["autoNaming", "adTemplate"], t("settings.adTemplate"))}
              </>
            ))}

            <div className="acts" style={{ alignItems: "center" }}>
              <button type="button" className="btn pri" onClick={() => void save()} disabled={busy}>
                {busy ? t("settings.saving") : t("settings.save")}
              </button>
              {saved && (
                <span className="data" style={{ color: "var(--good)", fontSize: "var(--fs-label)" }}>
                  {t("settings.saved")}
                </span>
              )}
            </div>

            {error && (
              <div className="msgbox err data" style={{ marginTop: 12 }} role="alert">
                {error}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
