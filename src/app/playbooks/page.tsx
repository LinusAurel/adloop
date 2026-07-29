"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AppNav } from "@/components/AppNav";

interface OverrideRow {
  id: string;
  playbook_slug: string;
  version: number;
  content_hash: string;
  active: boolean;
}

export default function PlaybooksPage() {
  const t = useTranslations("app");
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [slug, setSlug] = useState("general");
  const [body, setBody] = useState("# Override\n\nTest playbook body.\n");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/playbooks/overrides", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { overrides: OverrideRow[] };
    setOverrides(data.overrides);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    setError(null);
    const res = await fetch("/api/playbooks/overrides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playbookSlug: slug, files: { "PLAYBOOK.md": body } }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? "save_failed");
      return;
    }
    await refresh();
  }

  async function reset(playbookSlug: string) {
    await fetch("/api/playbooks/overrides", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playbookSlug }),
    });
    await refresh();
  }

  return (
    <div>
      <AppNav />
      <main className="page" style={{ maxWidth: 860 }}>
        <h1>{t("playbooks")}</h1>

        <div className="panel">
          <label className="field">
            <span>{t("playbookSlug")}</span>
            <input className="data" value={slug} onChange={(e) => setSlug(e.target.value)} />
          </label>
          <label className="field">
            <span>PLAYBOOK.md</span>
            <textarea
              className="data"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              style={{ resize: "vertical", lineHeight: 1.6 }}
            />
          </label>
          <button type="button" className="btn pri" onClick={() => void save()}>
            {t("saveOverride")}
          </button>
          {error && (
            <div className="msgbox err data" style={{ marginTop: 12, marginBottom: 0 }} role="alert">
              {error}
            </div>
          )}
        </div>

        <h2 style={{ fontSize: 13, fontWeight: 640, margin: "18px 0 8px" }}>
          {t("activeOverrides")}
        </h2>
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>{t("playbookSlug")}</th>
                <th>Version</th>
                <th>content_hash</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {overrides
                .filter((o) => o.active)
                .map((o) => (
                  <tr key={o.id}>
                    <td className="name">{o.playbook_slug}</td>
                    <td>v{o.version}</td>
                    <td style={{ color: "var(--dim)" }}>{o.content_hash.slice(0, 16)}…</td>
                    <td>
                      <button
                        type="button"
                        className="chip"
                        onClick={() => void reset(o.playbook_slug)}
                      >
                        {t("resetOverride")}
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
