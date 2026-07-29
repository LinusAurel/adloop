"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AppNav } from "@/components/AppNav";

type Source = "db" | "dir" | "bundled";

interface Playbook {
  slug: string;
  source: Source;
  files: Record<string, string>;
}

const MAIN = "PLAYBOOK.md";

export default function PlaybooksPage() {
  const t = useTranslations("app");
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (keep?: string) => {
    const res = await fetch("/api/playbooks", { cache: "no-store" });
    if (!res.ok) {
      setError(res.status === 403 ? "forbidden" : "load_failed");
      return;
    }
    const data = (await res.json()) as { playbooks: Playbook[] };
    setPlaybooks(data.playbooks);
    const next = keep ?? data.playbooks[0]?.slug ?? null;
    setSlug(next);
    const chosen = data.playbooks.find((p) => p.slug === next);
    setDraft(chosen?.files[MAIN] ?? "");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const current = playbooks.find((p) => p.slug === slug) ?? null;
  const dirty = current !== null && draft !== (current.files[MAIN] ?? "");

  function choose(next: string) {
    const chosen = playbooks.find((p) => p.slug === next);
    setSlug(next);
    setDraft(chosen?.files[MAIN] ?? "");
    setSaved(false);
    setError(null);
  }

  async function save() {
    if (!slug) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // Speichern heißt immer: einen Override anlegen. Die mitgelieferte
      // Fassung bleibt unberührt und ist damit jederzeit wiederherstellbar.
      const res = await fetch("/api/playbooks/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playbookSlug: slug, files: { [MAIN]: draft } }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "save_failed");
        return;
      }
      setSaved(true);
      await refresh(slug);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!slug) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await fetch("/api/playbooks/overrides", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playbookSlug: slug }),
      });
      await refresh(slug);
    } finally {
      setBusy(false);
    }
  }

  // Die Herkunft ist keine Zustandsbewertung, sondern eine Tatsache — deshalb
  // trägt nur der Override den Akzent, alles andere bleibt gedämpft.
  function sourceColor(source: Source): string {
    return source === "db" ? "var(--accent)" : "var(--dim)";
  }

  return (
    <div>
      <AppNav />
      <div className="split">
        <div className="lcol">
          <div className="lhead">
            <span>{t("playbooks")}</span>
            <span className="n">{playbooks.length}</span>
          </div>
          {playbooks.map((p) => (
            <button
              key={p.slug}
              type="button"
              className="item"
              aria-current={p.slug === slug ? "true" : "false"}
              onClick={() => choose(p.slug)}
            >
              <div className="t">{p.slug}</div>
              <div className="m">
                <span style={{ color: sourceColor(p.source) }}>
                  {t(`playbookSource.${p.source}` as never)}
                </span>
              </div>
            </button>
          ))}
          {playbooks.length === 0 && (
            <div className="empty" style={{ borderBottom: "1px solid var(--line)" }}>
              <p>{t("playbooksEmpty")}</p>
            </div>
          )}
        </div>

        <div className="rcol">
          {current ? (
            <>
              <div className="rhead">
                <h3>{current.slug}</h3>
                <span className="meta" style={{ color: sourceColor(current.source) }}>
                  {t(`playbookSource.${current.source}` as never)}
                </span>
                {dirty && <span className="meta">{t("unsaved")}</span>}
              </div>

              <p style={{ color: "var(--dim)", fontSize: "var(--fs-small)", maxWidth: "68ch" }}>
                {t("playbookHint")}
              </p>

              <textarea
                className="data"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSaved(false);
                }}
                rows={22}
                style={{ resize: "vertical", lineHeight: 1.7, marginBottom: 12 }}
                spellCheck={false}
              />

              <div className="acts" style={{ alignItems: "center" }}>
                <button
                  type="button"
                  className="btn pri"
                  disabled={busy || !dirty}
                  onClick={() => void save()}
                >
                  {t("saveOverride")}
                </button>
                {current.source === "db" && (
                  <button type="button" className="btn" disabled={busy} onClick={() => void reset()}>
                    {t("resetOverride")}
                  </button>
                )}
                {saved && (
                  <span className="data" style={{ color: "var(--good)", fontSize: "var(--fs-label)" }}>
                    {t("saved")}
                  </span>
                )}
              </div>

              {error && (
                <div className="msgbox err data" style={{ marginTop: 12 }} role="alert">
                  {error}
                </div>
              )}
            </>
          ) : (
            <div className="empty">
              <p>{t("playbooksEmpty")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
