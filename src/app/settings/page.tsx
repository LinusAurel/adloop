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
      body: JSON.stringify({ advertiserId, settings }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setError(body?.error ?? "validation_error");
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

  const field = (key: keyof DefaultsForm, label: string) => (
    <label
      key={key}
      style={{
        display: "grid",
        gridTemplateColumns: "12rem 1fr",
        gap: "0.75rem",
        alignItems: "center",
        marginBottom: "0.65rem",
        fontFamily: "var(--font-data)",
      }}
    >
      <span style={{ color: "var(--dim)" }}>{label}</span>
      <input
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        style={{
          background: "var(--raised)",
          color: "var(--fg)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius)",
          padding: "0.4rem 0.55rem",
          fontFamily: "var(--font-data)",
        }}
      />
    </label>
  );

  return (
    <main style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)" }}>
      <AppNav />
      <div style={{ maxWidth: "52rem", margin: "0 auto", padding: "1.5rem 1rem" }}>
        <h1 style={{ margin: "0 0 0.35rem", fontSize: "1.5rem" }}>
          {t("settings.title")}
        </h1>
        <p style={{ color: "var(--dim)", marginBottom: "1.25rem" }}>
          {t("settings.subtitle")}
          {version !== null ? ` · v${version}` : ""}
        </p>

        <label style={{ display: "block", marginBottom: "1rem" }}>
          <span style={{ color: "var(--dim)", marginRight: "0.5rem" }}>
            {t("settings.advertiser")}
          </span>
          <select
            value={advertiserId}
            onChange={(e) => setAdvertiserId(e.target.value)}
            style={{
              background: "var(--raised)",
              color: "var(--fg)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius)",
              padding: "0.35rem 0.5rem",
            }}
          >
            {advertisers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <section
          style={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius)",
            padding: "1rem",
            marginBottom: "1rem",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>{t("settings.identity")}</h2>
          {field("pageId", t("settings.pageId"))}
          {field("instagramActorId", t("settings.instagramActorId"))}
          {field("beneficiaryName", t("settings.beneficiaryName"))}
          {field("payerName", t("settings.payerName"))}
        </section>

        <section
          style={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius)",
            padding: "1rem",
            marginBottom: "1rem",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>{t("settings.adSet")}</h2>
          {field("optimizationGoal", t("settings.optimizationGoal"))}
          <label
            style={{
              display: "grid",
              gridTemplateColumns: "12rem 1fr",
              gap: "0.75rem",
              marginBottom: "0.65rem",
              fontFamily: "var(--font-data)",
            }}
          >
            <span style={{ color: "var(--dim)" }}>{t("settings.budgetMode")}</span>
            <select
              value={form.budgetMode}
              onChange={(e) =>
                setForm({
                  ...form,
                  budgetMode: e.target.value as "CBO" | "ABO",
                })
              }
              style={{
                background: "var(--raised)",
                color: "var(--fg)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius)",
                padding: "0.4rem 0.55rem",
              }}
            >
              <option value="ABO">ABO</option>
              <option value="CBO">CBO</option>
            </select>
          </label>
          {field("countries", t("settings.countries"))}
        </section>

        <section
          style={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius)",
            padding: "1rem",
            marginBottom: "1rem",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>{t("settings.website")}</h2>
          {field("websiteUrl", t("settings.websiteUrl"))}
          {field("utmParams", t("settings.utmParams"))}
        </section>

        <section
          style={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius)",
            padding: "1rem",
            marginBottom: "1rem",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>{t("settings.autoNaming")}</h2>
          {field("creativeTemplate", t("settings.creativeTemplate"))}
          {field("adSetTemplate", t("settings.adSetTemplate"))}
          {field("adTemplate", t("settings.adTemplate"))}
        </section>

        <button
          type="button"
          onClick={() => void save()}
          disabled={!baseSettings}
          style={{
            background: "var(--accent)",
            color: "var(--on-accent)",
            border: "none",
            borderRadius: "var(--radius)",
            padding: "0.55rem 1rem",
            cursor: "pointer",
          }}
        >
          {t("settings.save")}
        </button>
        {saved ? (
          <span style={{ marginLeft: "0.75rem", color: "var(--good)" }}>
            {t("settings.saved")}
          </span>
        ) : null}
        {error ? (
          <p style={{ color: "var(--crit)", fontFamily: "var(--font-data)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
