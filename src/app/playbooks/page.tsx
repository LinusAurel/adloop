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
      <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
        <h1>{t("playbooks")}</h1>
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          slug
          <input
            className="data"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              marginTop: 4,
              padding: "0.5rem",
              background: "var(--surface)",
              color: "var(--fg)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius)",
            }}
          />
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          style={{
            width: "100%",
            padding: "0.75rem",
            background: "var(--surface)",
            color: "var(--fg)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius)",
            fontFamily: "var(--font-data)",
          }}
        />
        <button
          type="button"
          onClick={() => void save()}
          style={{
            marginTop: "0.75rem",
            background: "var(--accent)",
            color: "var(--on-accent)",
            border: "none",
            borderRadius: "var(--radius)",
            padding: "0.5rem 0.75rem",
            cursor: "pointer",
          }}
        >
          save override
        </button>
        {error && <p style={{ color: "var(--crit)" }} className="data">{error}</p>}
        <h2 style={{ marginTop: "2rem" }}>active overrides</h2>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {overrides
            .filter((o) => o.active)
            .map((o) => (
              <li
                key={o.id}
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: "var(--radius)",
                  padding: "0.75rem",
                  marginBottom: "0.5rem",
                  background: "var(--surface)",
                }}
              >
                <div>
                  {o.playbook_slug} v{o.version}
                </div>
                <div className="data" style={{ fontSize: "0.8rem", color: "var(--dim)" }}>
                  {o.content_hash}
                </div>
                <button
                  type="button"
                  onClick={() => void reset(o.playbook_slug)}
                  style={{
                    marginTop: 6,
                    background: "var(--raised)",
                    color: "var(--fg)",
                    border: "1px solid var(--line)",
                    borderRadius: "var(--radius)",
                    padding: "0.25rem 0.5rem",
                    cursor: "pointer",
                  }}
                >
                  reset
                </button>
              </li>
            ))}
        </ul>
      </main>
    </div>
  );
}
