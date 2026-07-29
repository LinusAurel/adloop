"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { uuidv7 } from "uuidv7";
import { AppNav } from "@/components/AppNav";

interface AdvertiserOption {
  id: string;
  name: string;
}

interface CreativeRow {
  id: string;
  advertiserId: string;
  name: string;
  primaryText: string;
  headline: string;
  description: string;
  aspectRatio: string;
  status: string;
  previewUrl: string | null;
}

interface PendingApproval {
  approvalId: string;
  runId: string;
  costEstimate: { image: number; copy: number; currency: string };
  resolved: unknown;
  statusCode: string;
}

const ASPECTS = ["4:5", "1:1", "9:16", "16:9"] as const;

export default function WorkshopPage() {
  const t = useTranslations();
  const [advertisers, setAdvertisers] = useState<AdvertiserOption[]>([]);
  const [advertiserId, setAdvertiserId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECTS)[number]>("4:5");
  const [count, setCount] = useState(3);
  const [filterAspect, setFilterAspect] = useState<string>("");
  const [creatives, setCreatives] = useState<CreativeRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [statusCode, setStatusCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAdvertisers = useCallback(async () => {
    const res = await fetch("/api/advertisers", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as {
      advertisers: Array<{ id: string; name: string }>;
    };
    setAdvertisers(data.advertisers);
    if (data.advertisers[0] && !advertiserId) setAdvertiserId(data.advertisers[0].id);
  }, [advertiserId]);

  const loadCreatives = useCallback(async () => {
    const params = new URLSearchParams();
    if (advertiserId) params.set("advertiserId", advertiserId);
    if (filterAspect) params.set("aspectRatio", filterAspect);
    const res = await fetch(`/api/creatives?${params}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { creatives: CreativeRow[] };
    setCreatives(data.creatives);
  }, [advertiserId, filterAspect]);

  useEffect(() => {
    void loadAdvertisers();
  }, [loadAdvertisers]);

  useEffect(() => {
    void loadCreatives();
  }, [loadCreatives]);

  async function requestGeneration() {
    if (!advertiserId || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    setStatusCode(null);
    try {
      const res = await fetch("/api/workshop/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          advertiserId,
          prompt: prompt.trim(),
          aspectRatio,
          count,
          clientRequestId: uuidv7(),
        }),
      });
      if (!res.ok) {
        setError("request_failed");
        return;
      }
      const data = (await res.json()) as PendingApproval;
      setApproval(data);
      setStatusCode(data.statusCode);
    } finally {
      setBusy(false);
    }
  }

  async function decide(approve: boolean) {
    if (!approval) return;
    setBusy(true);
    try {
      const res = await fetch("/api/workshop/generate", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: approval.approvalId, approve }),
      });
      const data = (await res.json()) as { statusCode?: string };
      if (!res.ok) {
        setError(data.statusCode ?? "execute_failed");
        return;
      }
      setStatusCode(data.statusCode ?? (approve ? "submitted" : "denied"));
      setApproval(null);
      await loadCreatives();
    } finally {
      setBusy(false);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <AppNav />
      <div className="split">
        <div className="lcol" style={{ padding: "14px 16px" }}>
          <h1 style={{ fontSize: "var(--fs-lead)", fontWeight: 640, margin: "0 0 3px" }}>{t("workshop.title")}</h1>
          <p style={{ color: "var(--dim)", fontSize: "var(--fs-label)", margin: "0 0 14px" }}>
            {t("workshop.subtitle")}
          </p>

          <label className="field">
            <span>{t("workshop.advertiser")}</span>
            <select value={advertiserId} onChange={(e) => setAdvertiserId(e.target.value)}>
              {advertisers.length === 0 && <option value="">{t("workshop.noAdvertiser")}</option>}
              {advertisers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t("workshop.prompt")}</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              style={{ resize: "vertical" }}
            />
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label className="field">
              <span>{t("workshop.aspectRatio")}</span>
              <select
                className="data"
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value as (typeof ASPECTS)[number])}
              >
                {ASPECTS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("workshop.count")}</span>
              <input
                type="number"
                min={1}
                max={10}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </label>
          </div>

          <button
            type="button"
            className="btn pri"
            style={{ width: "100%" }}
            disabled={busy || !advertiserId || !prompt.trim()}
            onClick={() => void requestGeneration()}
          >
            {t("workshop.generate")}
          </button>

          {approval && (
            <div className="approve" style={{ marginTop: 12 }}>
              <div className="ahead">
                <h4>{t("chat.approvalRequired")}</h4>
                <span className="cost">
                  {approval.costEstimate.image} / {approval.costEstimate.copy}{" "}
                  {approval.costEstimate.currency}
                </span>
              </div>
              <dl className="kv">
                {Object.entries(approval.resolved as Record<string, unknown>).map(([key, value]) => (
                  <Fragment key={key}>
                    <dt>{key}</dt>
                    <dd>
                      {typeof value === "object" && value !== null
                        ? JSON.stringify(value)
                        : String(value)}
                    </dd>
                  </Fragment>
                ))}
              </dl>
              <div className="hashline">{t("chat.approvalHashHint")}</div>
              <div className="acts">
                <button
                  type="button"
                  className="btn pri"
                  disabled={busy}
                  onClick={() => void decide(true)}
                >
                  {t("chat.approve")}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void decide(false)}>
                  {t("chat.deny")}
                </button>
              </div>
            </div>
          )}

          {statusCode && (
            <div
              className="data"
              style={{ fontSize: "var(--fs-label)", color: "var(--dim)", marginTop: 12 }}
            >
              {t("workshop.status")}:{" "}
              {/* Ein Anbieterabsturz ohne Idempotenzschutz ist kein Fehler, sondern
                  ein Fall für einen Menschen — deshalb Warnfarbe, nicht Rot. */}
              <span
                style={{
                  color:
                    statusCode === "needs_human_check" ||
                    statusCode === "provider_unprotected_crash"
                      ? "var(--warn)"
                      : "var(--fg)",
                }}
              >
                {statusCode === "needs_human_check" || statusCode === "provider_unprotected_crash"
                  ? t("workshop.needsHumanCheck")
                  : statusCode}
              </span>
            </div>
          )}
          {error && (
            <div className="msgbox err data" style={{ marginTop: 12, marginBottom: 0 }} role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="rcol">
          <div className="rhead">
            <h3>{t("workshop.library")}</h3>
            <select
              className="data"
              style={{ width: "auto", padding: "4px 9px", fontSize: "var(--fs-label)" }}
              value={filterAspect}
              onChange={(e) => setFilterAspect(e.target.value)}
              aria-label={t("workshop.aspectRatio")}
            >
              <option value="">{t("workshop.allFormats")}</option>
              {ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <span className="meta" style={{ marginLeft: "auto" }}>
              {t("workshop.selected")} {selected.size}
            </span>
          </div>

          {creatives.length === 0 ? (
            <div className="empty">
              <h3>{t("empty.workshopTitle")}</h3>
              <p>{t("empty.workshopBody")}</p>
            </div>
          ) : null}

          <div className="tiles">
            {creatives.map((c) => {
              const isSelected = selected.has(c.id);
              return (
                <button
                  type="button"
                  key={c.id}
                  className="tile"
                  aria-pressed={isSelected}
                  onClick={() => toggleSelect(c.id)}
                >
                  <div className="shot">
                    {c.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.previewUrl} alt={c.name} />
                    ) : (
                      <span className="data">{c.aspectRatio}</span>
                    )}
                  </div>
                  <div className="cap">
                    <strong>{c.headline}</strong>
                    <p>{c.primaryText}</p>
                    <span className="data">
                      {c.aspectRatio} · {c.status}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
