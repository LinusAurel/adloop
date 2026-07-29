"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AppNav } from "@/components/AppNav";
import type { AdvertiserDefaults } from "@/publish/settings";
import { mergeDefaultsFormPatch } from "@/publish/defaults-form";

interface AdvertiserOption {
  id: string;
  name: string;
}

type DefaultsForm = {
  pageId: string;
  instagramActorId: string;
  beneficiaryName: string;
  payerName: string;
  optimizationGoal: string;
  budgetMode: "CBO" | "ABO";
  countries: string;
  websiteUrl: string;
  utmParams: string;
  creativeTemplate: string;
  adSetTemplate: string;
  adTemplate: string;
};

const emptyForm: DefaultsForm = {
  pageId: "",
  instagramActorId: "",
  beneficiaryName: "",
  payerName: "",
  optimizationGoal: "LINK_CLICKS",
  budgetMode: "ABO",
  countries: "DE",
  websiteUrl: "https://example.com",
  utmParams: "utm_source=meta&utm_medium=paid",
  creativeTemplate: "{advertiser} / {date}",
  adSetTemplate: "{advertiser} / {optimization}",
  adTemplate: "{creative} / {date}",
};

function formFromSettings(settings: AdvertiserDefaults): DefaultsForm {
  return {
    pageId: settings.identity.pageId,
    instagramActorId: settings.identity.instagramActorId ?? "",
    beneficiaryName: settings.identity.beneficiaryName ?? "",
    payerName: settings.identity.payerName ?? "",
    optimizationGoal: settings.adSet.optimizationGoal,
    budgetMode: settings.adSet.budgetMode,
    countries: settings.adSet.targeting.countries.join(","),
    websiteUrl: settings.website.url,
    utmParams: settings.website.utmParams,
    creativeTemplate: settings.autoNaming.creativeTemplate,
    adSetTemplate: settings.autoNaming.adSetTemplate,
    adTemplate: settings.autoNaming.adTemplate,
  };
}

export default function SettingsPage() {
  const t = useTranslations();
  const [advertisers, setAdvertisers] = useState<AdvertiserOption[]>([]);
  const [advertiserId, setAdvertiserId] = useState("");
  const [form, setForm] = useState<DefaultsForm>(emptyForm);
  /** Full loaded defaults — source of truth for fields the form does not show. */
  const [baseSettings, setBaseSettings] = useState<AdvertiserDefaults | null>(
    null,
  );
  const [version, setVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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

  const loadDefaults = useCallback(async () => {
    if (!advertiserId) return;
    const res = await fetch(
      `/api/meta/ad-account-settings?advertiserId=${advertiserId}`,
      { cache: "no-store" },
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      version: number | null;
      settings: AdvertiserDefaults | null;
    };
    setVersion(data.version);
    if (data.settings) {
      setBaseSettings(data.settings);
      setForm(formFromSettings(data.settings));
    } else {
      setBaseSettings(null);
      setForm(emptyForm);
    }
  }, [advertiserId]);

  useEffect(() => {
    void loadAdvertisers();
  }, [loadAdvertisers]);

  useEffect(() => {
    void loadDefaults();
  }, [loadDefaults]);

  async function save() {
    setError(null);
    setSaved(false);
    if (!baseSettings) {
      setError("defaults_missing");
      return;
    }
    const settings = mergeDefaultsFormPatch(baseSettings, form);

    const res = await fetch("/api/meta/ad-account-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        advertiserId,
        expectedVersion: version,
        settings,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      const code = body?.error ?? "validation_error";
      setError(code);
      if (code === "settings_version_conflict") {
        await loadDefaults();
      }
      return;
    }
    const data = (await res.json()) as {
      version: number;
      settings: AdvertiserDefaults;
    };
    setVersion(data.version);
    setBaseSettings(data.settings);
    setForm(formFromSettings(data.settings));
    setSaved(true);
  }

  // Diese Werte gehen als Felder an Meta und stehen später in Spalten —
  // deshalb Festbreitenschrift schon bei der Eingabe.
  const field = (key: keyof DefaultsForm, label: string) => (
    <label className="row" key={key}>
      <span>{label}</span>
      <input
        className="data"
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <div>
      <AppNav />
      <main className="page" style={{ maxWidth: 860 }}>
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

        <div className="panel">
          <h2>{t("settings.identity")}</h2>
          {field("pageId", t("settings.pageId"))}
          {field("instagramActorId", t("settings.instagramActorId"))}
          {field("beneficiaryName", t("settings.beneficiaryName"))}
          {field("payerName", t("settings.payerName"))}
        </div>

        <div className="panel">
          <h2>{t("settings.adSet")}</h2>
          {field("optimizationGoal", t("settings.optimizationGoal"))}
          <label className="row">
            <span>{t("settings.budgetMode")}</span>
            <select
              className="data"
              value={form.budgetMode}
              onChange={(e) => setForm({ ...form, budgetMode: e.target.value as "CBO" | "ABO" })}
            >
              <option value="ABO">ABO</option>
              <option value="CBO">CBO</option>
            </select>
          </label>
          {field("countries", t("settings.countries"))}
        </div>

        <div className="panel">
          <h2>{t("settings.website")}</h2>
          {field("websiteUrl", t("settings.websiteUrl"))}
          {field("utmParams", t("settings.utmParams"))}
        </div>

        <div className="panel">
          <h2>{t("settings.autoNaming")}</h2>
          {field("creativeTemplate", t("settings.creativeTemplate"))}
          {field("adSetTemplate", t("settings.adSetTemplate"))}
          {field("adTemplate", t("settings.adTemplate"))}
        </div>

        <div className="acts" style={{ alignItems: "center" }}>
          <button type="button" className="btn pri" onClick={() => void save()} disabled={!baseSettings}>
            {t("settings.save")}
          </button>
          {saved ? (
            <span className="data" style={{ color: "var(--good)", fontSize: 11.5 }}>
              {t("settings.saved")}
            </span>
          ) : null}
        </div>

        {error ? (
          <div className="msgbox err data" style={{ marginTop: 12 }} role="alert">
            {error}
          </div>
        ) : null}
      </main>
    </div>
  );
}
