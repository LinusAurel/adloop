"use client";

import { useCallback, useEffect, useState } from "react";
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
          provider: "stub",
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
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)" }}>
      <AppNav />
      <main
        style={{
          display: "grid",
          gridTemplateColumns: "320px 1fr",
          gap: "1.25rem",
          padding: "1.25rem",
          maxWidth: 1400,
          margin: "0 auto",
        }}
      >
        <section
          style={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius)",
            padding: "1rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            height: "fit-content",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "1.1rem" }}>{t("workshop.title")}</h1>
          <p style={{ margin: 0, color: "var(--dim)", fontSize: "0.9rem" }}>{t("workshop.subtitle")}</p>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
            {t("workshop.advertiser")}
            <select
              value={advertiserId}
              onChange={(e) => setAdvertiserId(e.target.value)}
              style={fieldStyle}
            >
              {advertisers.length === 0 && <option value="">{t("workshop.noAdvertiser")}</option>}
              {advertisers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
            {t("workshop.prompt")}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              style={{ ...fieldStyle, resize: "vertical", fontFamily: "var(--font-ui)" }}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
            {t("workshop.aspectRatio")}
            <select
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value as (typeof ASPECTS)[number])}
              style={fieldStyle}
            >
              {ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.85rem" }}>
            {t("workshop.count")}
            <input
              type="number"
              min={1}
              max={10}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              style={fieldStyle}
            />
          </label>

          <button
            type="button"
            disabled={busy || !advertiserId || !prompt.trim()}
            onClick={() => void requestGeneration()}
            style={primaryButton}
          >
            {t("workshop.generate")}
          </button>

          {approval && (
            <div
              style={{
                border: "1px solid var(--warn)",
                borderRadius: "var(--radius)",
                padding: "0.75rem",
                background: "var(--raised)",
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              <strong>{t("chat.approvalRequired")}</strong>
              <span className="data" style={{ fontSize: "0.85rem" }}>
                {t("chat.costEstimate")}: {t("workshop.costImage")}{" "}
                <span className="data">{approval.costEstimate.image}</span> /{" "}
                {t("workshop.costCopy")}{" "}
                <span className="data">{approval.costEstimate.copy}</span>{" "}
                <span className="data">{approval.costEstimate.currency}</span>
              </span>
              <pre
                style={{
                  margin: 0,
                  fontSize: "0.75rem",
                  fontFamily: "var(--font-data)",
                  whiteSpace: "pre-wrap",
                  color: "var(--dim)",
                }}
              >
                {JSON.stringify(approval.resolved, null, 2)}
              </pre>
              <span style={{ fontSize: "0.8rem", color: "var(--dim)" }}>
                {t("chat.approvalHashHint")}
              </span>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button type="button" disabled={busy} onClick={() => void decide(true)} style={primaryButton}>
                  {t("chat.approve")}
                </button>
                <button type="button" disabled={busy} onClick={() => void decide(false)} style={secondaryButton}>
                  {t("chat.deny")}
                </button>
              </div>
            </div>
          )}

          {statusCode && (
            <p style={{ margin: 0, fontSize: "0.85rem" }}>
              {t("workshop.status")}:{" "}
              <span className="data">
                {statusCode === "needs_human_check" || statusCode === "provider_unprotected_crash"
                  ? t("workshop.needsHumanCheck")
                  : statusCode}
              </span>
            </p>
          )}
          {error && (
            <p style={{ margin: 0, color: "var(--crit)", fontSize: "0.85rem" }}>{error}</p>
          )}
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "1rem" }}>{t("workshop.library")}</h2>
            <select
              value={filterAspect}
              onChange={(e) => setFilterAspect(e.target.value)}
              style={{ ...fieldStyle, width: "auto" }}
            >
              <option value="">{t("workshop.allFormats")}</option>
              {ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <span style={{ marginLeft: "auto", color: "var(--dim)", fontSize: "0.85rem" }}>
              {t("workshop.selected")}: <span className="data">{selected.size}</span>
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: "0.75rem",
            }}
          >
            {creatives.map((c) => {
              const isSelected = selected.has(c.id);
              return (
                <article
                  key={c.id}
                  style={{
                    background: "var(--surface)",
                    border: `1px solid ${isSelected ? "var(--accent)" : "var(--line)"}`,
                    borderRadius: "var(--radius)",
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleSelect(c.id)}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      display: "block",
                      background: "var(--raised)",
                      minHeight: 160,
                    }}
                  >
                    {c.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.previewUrl}
                        alt={c.name}
                        style={{ width: "100%", display: "block", objectFit: "cover", maxHeight: 220 }}
                      />
                    ) : (
                      <div
                        style={{
                          height: 160,
                          display: "grid",
                          placeItems: "center",
                          color: "var(--dim)",
                          fontFamily: "var(--font-data)",
                        }}
                      >
                        {c.aspectRatio}
                      </div>
                    )}
                  </button>
                  <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 4 }}>
                    <strong style={{ fontSize: "0.9rem" }}>{c.headline}</strong>
                    <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--dim)" }}>{c.primaryText}</p>
                    <span className="data" style={{ fontSize: "0.75rem", color: "var(--dim)" }}>
                      {c.aspectRatio} · {c.status}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  background: "var(--raised)",
  color: "var(--fg)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius)",
  padding: "0.45rem 0.55rem",
  fontFamily: "var(--font-ui)",
};

const primaryButton: React.CSSProperties = {
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "none",
  borderRadius: "var(--radius)",
  padding: "0.55rem 0.75rem",
  cursor: "pointer",
  fontWeight: 600,
};

const secondaryButton: React.CSSProperties = {
  background: "var(--raised)",
  color: "var(--fg)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius)",
  padding: "0.55rem 0.75rem",
  cursor: "pointer",
};
