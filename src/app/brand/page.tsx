"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AppNav } from "@/components/AppNav";
import { emptyBrandProfile, type BrandProfile } from "@/brand/profile";

interface AdvertiserOption {
  id: string;
  name: string;
}

/** Zeilenweise Liste ↔ Array. Leere Zeilen zählen nicht als Eintrag. */
function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export default function BrandPage() {
  const t = useTranslations();
  const [advertisers, setAdvertisers] = useState<AdvertiserOption[]>([]);
  const [advertiserId, setAdvertiserId] = useState("");
  const [profile, setProfile] = useState<BrandProfile | null>(null);
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

  const loadProfile = useCallback(async () => {
    if (!advertiserId) return;
    const res = await fetch(`/api/brand-profile?advertiserId=${advertiserId}`, {
      cache: "no-store",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "validation_error");
      return;
    }
    const data = (await res.json()) as {
      version: number | null;
      profile: BrandProfile | null;
    };
    setVersion(data.version);
    setProfile(data.profile);
    setError(null);
    setSaved(false);
  }, [advertiserId]);

  useEffect(() => {
    void loadAdvertisers();
  }, [loadAdvertisers]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  /** Ein Feld ändern, ohne den Rest des Profils anzufassen. */
  function edit(change: (draft: BrandProfile) => BrandProfile) {
    setProfile((current) => (current ? change(current) : current));
    setSaved(false);
  }

  async function save() {
    if (!profile) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/brand-profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ advertiserId, expectedVersion: version, profile }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = body?.error ?? "validation_error";
        setError(code);
        // Bei einem Versionskonflikt hat jemand anderes gespeichert. Neu laden,
        // statt die eigene Fassung darüberzuschreiben.
        if (code === "brand_profile_version_conflict") await loadProfile();
        return;
      }
      const data = (await res.json()) as { version: number; profile: BrandProfile };
      setVersion(data.version);
      setProfile(data.profile);
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  // ── Bausteine ──

  function prose(
    label: string,
    value: string,
    onChange: (next: string) => void,
    rows: number,
    hint?: string,
  ) {
    return (
      <label className="field">
        <span>{label}</span>
        <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
        {hint && <div className="hint">{hint}</div>}
      </label>
    );
  }

  function listField(
    label: string,
    values: string[],
    onChange: (next: string[]) => void,
    hint: string,
  ) {
    return (
      <label className="field">
        <span>{label}</span>
        <textarea
          className="lines"
          rows={5}
          value={values.join("\n")}
          onChange={(e) => onChange(linesToArray(e.target.value))}
          spellCheck={false}
        />
        <div className="hint">
          {hint} · {values.length}
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
        <h1>{t("brand.title")}</h1>
        <p>
          {t("brand.subtitle")}
          {version !== null ? ` · v${version}` : ""}
        </p>

        <label className="row" style={{ marginBottom: 14 }}>
          <span>{t("brand.advertiser")}</span>
          <select value={advertiserId} onChange={(e) => setAdvertiserId(e.target.value)}>
            {advertisers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        {!profile ? (
          <div className="empty">
            <h3>{t("brand.noProfile")}</h3>
            <p>{t("brand.noProfileBody")}</p>
            <p>
              <button
                type="button"
                className="btn pri"
                disabled={!advertiserId}
                onClick={() => setProfile(emptyBrandProfile())}
              >
                {t("brand.create")}
              </button>
            </p>
          </div>
        ) : (
          <>
            {panel(t("brand.business"), (
              <>
                {prose(
                  t("brand.businessLabel"),
                  profile.business,
                  (next) => edit((draft) => ({ ...draft, business: next })),
                  5,
                  t("brand.businessHint"),
                )}
              </>
            ))}

            {panel(t("brand.offerings"), (
              <>
                {profile.offerings.map((offering, index) => (
                  <details className="fold" key={index} open>
                    <summary>{offering.name || t("brand.offeringUntitled")}</summary>
                    <div>
                      <label className="row">
                        <span>{t("brand.offeringName")}</span>
                        <input
                          value={offering.name}
                          onChange={(e) =>
                            edit((draft) => ({
                              ...draft,
                              offerings: draft.offerings.map((item, i) =>
                                i === index ? { ...item, name: e.target.value } : item,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label className="field">
                        <span>{t("brand.offeringPromise")}</span>
                        <textarea
                          rows={3}
                          value={offering.promise}
                          onChange={(e) =>
                            edit((draft) => ({
                              ...draft,
                              offerings: draft.offerings.map((item, i) =>
                                i === index ? { ...item, promise: e.target.value } : item,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label className="row">
                        <span>{t("brand.offeringPrice")}</span>
                        <input
                          value={offering.price}
                          onChange={(e) =>
                            edit((draft) => ({
                              ...draft,
                              offerings: draft.offerings.map((item, i) =>
                                i === index ? { ...item, price: e.target.value } : item,
                              ),
                            }))
                          }
                        />
                      </label>
                      <div className="hint">{t("brand.offeringPriceHint")}</div>
                      <div className="acts" style={{ marginTop: 10 }}>
                        <button
                          type="button"
                          className="btn"
                          onClick={() =>
                            edit((draft) => ({
                              ...draft,
                              offerings: draft.offerings.filter((_, i) => i !== index),
                            }))
                          }
                        >
                          {t("brand.removeOffering")}
                        </button>
                      </div>
                    </div>
                  </details>
                ))}
                <div className="acts" style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      edit((draft) => ({
                        ...draft,
                        offerings: [...draft.offerings, { name: "", promise: "", price: "" }],
                      }))
                    }
                  >
                    {t("brand.addOffering")}
                  </button>
                </div>
              </>
            ))}

            {panel(t("brand.audience"), (
              <>
                {prose(
                  t("brand.audienceWho"),
                  profile.audience.who,
                  (next) =>
                    edit((draft) => ({ ...draft, audience: { ...draft.audience, who: next } })),
                  3,
                )}
                {prose(
                  t("brand.audienceProblem"),
                  profile.audience.problem,
                  (next) =>
                    edit((draft) => ({
                      ...draft,
                      audience: { ...draft.audience, problem: next },
                    })),
                  3,
                )}
              </>
            ))}

            {panel(t("brand.voice"), (
              <>
                {prose(
                  t("brand.voiceHow"),
                  profile.voice.how,
                  (next) => edit((draft) => ({ ...draft, voice: { ...draft.voice, how: next } })),
                  3,
                )}
                {prose(
                  t("brand.voiceAvoid"),
                  profile.voice.avoid,
                  (next) =>
                    edit((draft) => ({ ...draft, voice: { ...draft.voice, avoid: next } })),
                  3,
                  t("brand.voiceAvoidHint"),
                )}
              </>
            ))}

            {panel(t("brand.claims"), (
              <>
                {listField(
                  t("brand.claimsSupported"),
                  profile.claims.supported,
                  (next) =>
                    edit((draft) => ({
                      ...draft,
                      claims: { ...draft.claims, supported: next },
                    })),
                  t("brand.claimsSupportedHint"),
                )}
                {listField(
                  t("brand.claimsUnsupported"),
                  profile.claims.unsupported,
                  (next) =>
                    edit((draft) => ({
                      ...draft,
                      claims: { ...draft.claims, unsupported: next },
                    })),
                  t("brand.claimsUnsupportedHint"),
                )}
              </>
            ))}

            {panel(t("brand.vocabulary"), (
              <>
                {listField(
                  t("brand.termsPreferred"),
                  profile.vocabulary.preferred,
                  (next) =>
                    edit((draft) => ({
                      ...draft,
                      vocabulary: { ...draft.vocabulary, preferred: next },
                    })),
                  t("brand.oneTermPerLine"),
                )}
                {listField(
                  t("brand.termsBanned"),
                  profile.vocabulary.banned,
                  (next) =>
                    edit((draft) => ({
                      ...draft,
                      vocabulary: { ...draft.vocabulary, banned: next },
                    })),
                  t("brand.oneTermPerLine"),
                )}
              </>
            ))}

            <div className="acts" style={{ alignItems: "center" }}>
              <button type="button" className="btn pri" onClick={() => void save()} disabled={busy}>
                {busy ? t("brand.saving") : t("brand.save")}
              </button>
              {version === null && <span className="hint">{t("brand.createHint")}</span>}
              {saved && (
                <span className="data" style={{ color: "var(--good)", fontSize: "var(--fs-label)" }}>
                  {t("brand.saved")}
                </span>
              )}
            </div>
          </>
        )}

        {error && (
          <div className="msgbox err" style={{ marginTop: 12 }} role="alert">
            {t(`errors.${error}` as never)}
          </div>
        )}
      </main>
    </div>
  );
}
