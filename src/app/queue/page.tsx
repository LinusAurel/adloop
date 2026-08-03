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
    // Ohne Code gibt es keinen Text. next-intl liefert für einen fehlenden
    // Schlüssel den Schlüssel zurück, sodass sonst "progress.undefined" in der
    // Spalte steht statt einer leeren Zelle.
    if (!progress?.code) return "";
    const key = `progress.${progress.code}` as const;
    try {
      return t(key, progress.params as Record<string, string | number | Date>);
    } catch {
      return progress.code;
    }
  }

  // Lauf-Status auf die vier Zustandsrollen: erledigt trägt, laufend ist der
  // Akzent (Handlung, kein Zustand), gescheitert ruft nach Handeln, wartend
  // sagt noch nichts aus.
  function statusColor(status: string): string {
    if (status === "completed") return "var(--good)";
    if (status === "running") return "var(--accent)";
    if (status === "failed" || status === "timed_out") return "var(--crit)";
    if (status === "cancelled") return "var(--warn)";
    return "var(--none)";
  }

  return (
    <div>
      <AppNav />
      <main className="page">
        <h1>{t("app.queueSmoke")}</h1>
        <p>{t("queue.lead")}</p>

        <form onSubmit={submit} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={t("queue.enqueue")}
            autoComplete="off"
          />
          <button type="submit" className="btn pri" disabled={submitting} style={{ flexShrink: 0 }}>
            {submitting ? "…" : t("queue.enqueue")}
          </button>
        </form>

        {errorMsg && (
          <div className="msgbox err data" role="alert">
            {errorMsg}
          </div>
        )}

        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>run_id</th>
                <th>{t("queue.status")}</th>
                <th>job</th>
                <th>{t("queue.progress")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId}>
                  <td className="name">
                    <i
                      className={`stripe${statusColor(r.status) === "var(--none)" ? " none" : ""}`}
                      style={{ background: statusColor(r.status) }}
                    />
                    <span className="data">{r.runId.slice(0, 8)}…</span>
                  </td>
                  <td style={{ color: statusColor(r.status) }}>{r.status}</td>
                  <td style={{ color: "var(--dim)" }}>{r.job.status ?? "—"}</td>
                  <td style={{ minWidth: 180, textAlign: "left" }}>
                    <div className="meter" style={{ marginTop: 0 }}>
                      <i
                        style={{
                          width: `${r.job.progress?.percent ?? 0}%`,
                          background: statusColor(r.status),
                        }}
                      />
                    </div>
                    <div style={{ color: "var(--dim)", fontSize: "var(--fs-label)", marginTop: 3 }}>
                      {progressLabel(r.job.progress)}
                    </div>
                  </td>
                  <td>
                    {(r.status === "queued" || r.status === "running") && (
                      <button type="button" className="chip" onClick={() => void cancel(r.runId)}>
                        {t("queue.cancel")}
                      </button>
                    )}
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
