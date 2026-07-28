"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { uuidv7 } from "uuidv7";
import { AppNav } from "@/components/AppNav";

interface RunSummary {
  runId: string;
  status: string;
  result: unknown;
  job: {
    status: string | null;
    attempts: number | null;
    progress: {
      state: string;
      code: string;
      params: Record<string, string | number | boolean>;
      percent: number;
    } | null;
  };
  createdAt: string;
}

export default function QueuePage() {
  const t = useTranslations();
  const [text, setText] = useState("ok");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/runs", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { runs: RunSummary[] };
      setRuns(data.runs);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErrorMsg(null);
    const runId = uuidv7();
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, family: "echo", input: { text } }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setErrorMsg(body?.error ?? `request_failed`);
        return;
      }
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(runId: string) {
    await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
    await refresh();
  }

  function progressLabel(progress: RunSummary["job"]["progress"]): string {
    if (!progress) return "";
    const key = `progress.${progress.code}` as const;
    try {
      return t(key, progress.params as Record<string, string | number | Date>);
    } catch {
      return progress.code;
    }
  }

  return (
    <div>
      <AppNav />
      <main style={{ maxWidth: 680, margin: "2rem auto", padding: "0 1rem" }}>
        <h1>{t("app.queueSmoke")}</h1>
        <form
          onSubmit={submit}
          style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{
              flex: 1,
              padding: "0.5rem",
              background: "var(--surface)",
              color: "var(--fg)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius)",
            }}
          />
          <button
            type="submit"
            disabled={submitting}
            style={{
              background: "var(--accent)",
              color: "var(--on-accent)",
              border: "none",
              borderRadius: "var(--radius)",
              padding: "0.5rem 0.75rem",
              cursor: "pointer",
            }}
          >
            {submitting ? "…" : "echo"}
          </button>
        </form>
        {errorMsg && <p style={{ color: "var(--crit)" }} className="data">{errorMsg}</p>}
        <ul style={{ listStyle: "none", padding: 0 }}>
          {runs.map((r) => (
            <li
              key={r.runId}
              style={{
                border: "1px solid var(--line)",
                borderRadius: "var(--radius)",
                padding: "0.75rem",
                marginBottom: "0.5rem",
                background: "var(--surface)",
              }}
            >
              <div>
                <strong className="data">{r.runId}</strong> — {r.status} /{" "}
                <span className="data">{r.job.status ?? "—"}</span>
              </div>
              <div
                style={{
                  background: "var(--raised)",
                  borderRadius: "var(--radius)",
                  overflow: "hidden",
                  height: 8,
                  marginTop: 4,
                }}
              >
                <div
                  style={{
                    background: "var(--accent)",
                    height: "100%",
                    width: `${r.job.progress?.percent ?? 0}%`,
                  }}
                />
              </div>
              <div style={{ fontSize: "0.85rem", color: "var(--dim)" }}>
                {progressLabel(r.job.progress)}
              </div>
              {(r.status === "queued" || r.status === "running") && (
                <button
                  type="button"
                  onClick={() => void cancel(r.runId)}
                  style={{
                    marginTop: 4,
                    background: "var(--raised)",
                    color: "var(--fg)",
                    border: "1px solid var(--line)",
                    borderRadius: "var(--radius)",
                    padding: "0.25rem 0.5rem",
                    cursor: "pointer",
                  }}
                >
                  cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
