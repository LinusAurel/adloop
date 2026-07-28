"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AppNav } from "@/components/AppNav";

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

export default function SettingsPage() {
  const t = useTranslations();
  const [advertisers, setAdvertisers] = useState<AdvertiserOption[]>([]);
  const [advertiserId, setAdvertiserId] = useState("");
  const [form, setForm] = useState<DefaultsForm>(emptyForm);
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
      settings: {
        identity: {
          pageId: string;
          instagramActorId?: string;
          beneficiaryName?: string;
          payerName?: string;
        };
        adSet: {
          optimizationGoal: string;
          budgetMode: "CBO" | "ABO";
          targeting: { countries: string[] };
        };
        website: { url: string; utmParams: string };
        autoNaming: {
          creativeTemplate: string;
          adSetTemplate: string;
          adTemplate: string;
        };
      } | null;
    };
    setVersion(data.version);
    if (data.settings) {
      setForm({
        pageId: data.settings.identity.pageId,
        instagramActorId: data.settings.identity.instagramActorId ?? "",
        beneficiaryName: data.settings.identity.beneficiaryName ?? "",
        payerName: data.settings.identity.payerName ?? "",
        optimizationGoal: data.settings.adSet.optimizationGoal,
        budgetMode: data.settings.adSet.budgetMode,
        countries: data.settings.adSet.targeting.countries.join(","),
        websiteUrl: data.settings.website.url,
        utmParams: data.settings.website.utmParams,
        creativeTemplate: data.settings.autoNaming.creativeTemplate,
        adSetTemplate: data.settings.autoNaming.adSetTemplate,
        adTemplate: data.settings.autoNaming.adTemplate,
      });
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
    const settings = {
      identity: {
        pageId: form.pageId,
        ...(form.instagramActorId
          ? { instagramActorId: form.instagramActorId }
          : {}),
        ...(form.beneficiaryName.trim()
          ? { beneficiaryName: form.beneficiaryName.trim() }
          : {}),
        ...(form.payerName.trim() ? { payerName: form.payerName.trim() } : {}),
      },
      adSet: {
        optimizationGoal: form.optimizationGoal,
        billingEvent: "IMPRESSIONS",
        placements: {
          advantagePlus: true,
          facebook: true,
          instagram: true,
          audienceNetwork: false,
          messenger: false,
        },
        targeting: {
          countries: form.countries
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
          ageMin: 18,
          ageMax: 65,
          genders: [],
        },
        audiences: {
          advantagePlusEnabled: true,
          includedCustomAudienceIds: [],
          excludedCustomAudienceIds: [],
        },
        schedule: {
          timezone: "Europe/Berlin",
          offsetDays: 1,
          time: "00:00",
        },
        attribution: {
          click: "7d_click",
          view: "1d_view",
          engaged: "none",
        },
        bidStrategy: "LOWEST_COST_WITHOUT_CAP",
        budgetMode: form.budgetMode,
      },
      creative: { image: {}, video: {}, carousel: {} },
      website: { url: form.websiteUrl, utmParams: form.utmParams },
      autoNaming: {
        creativeTemplate: form.creativeTemplate,
        adSetTemplate: form.adSetTemplate,
        adTemplate: form.adTemplate,
      },
      defaultAdCopy: { callToAction: "LEARN_MORE" },
      campaignObjective: "OUTCOME_TRAFFIC",
    };

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
    const data = (await res.json()) as { version: number };
    setVersion(data.version);
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
