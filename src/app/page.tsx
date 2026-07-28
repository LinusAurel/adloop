"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { uuidv7 } from "uuidv7";

interface RunSummary {
  runId: string;
  status: string;
  result: unknown;
  job: {
    status: string | null;
    attempts: number | null;
    progress: { state: string; message: string; percent: number } | null;
  };
  createdAt: string;
}

export default function Home() {
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
        setErrorMsg(body?.error ?? `request failed (${res.status})`);
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

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 680, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>adloop v2 — queue smoke test</h1>
      <p style={{ color: "#666" }}>
        Verification tool, not a product surface (§7 of the auftrag). Starts an <code>echo</code> run
        (the runId is generated in the browser) and polls its progress.{" "}
        <a href="/connectors">Connectors</a> · <a href="/metrics">Metriken</a>
      </p>
      <form onSubmit={submit} style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="text to echo"
          style={{ flex: 1, padding: "0.5rem" }}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? "starting..." : "start echo run"}
        </button>
      </form>
      {errorMsg && <p style={{ color: "crimson" }}>{errorMsg}</p>}

      <h2>Runs</h2>
      {runs.length === 0 && <p style={{ color: "#666" }}>No runs yet.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {runs.map((r) => (
          <li
            key={r.runId}
            style={{ border: "1px solid #ddd", borderRadius: 8, padding: "0.75rem", marginBottom: "0.5rem" }}
          >
            <div>
              <strong>{r.runId}</strong> — run: {r.status}, job: {r.job.status ?? "—"} (attempts{" "}
              {r.job.attempts ?? 0})
            </div>
            <div style={{ background: "#eee", borderRadius: 4, overflow: "hidden", height: 8, marginTop: 4 }}>
              <div
                style={{
                  background: "#3366ff",
                  height: "100%",
                  width: `${r.job.progress?.percent ?? 0}%`,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <div style={{ fontSize: "0.85rem", color: "#666" }}>{r.job.progress?.message}</div>
            {r.status === "completed" && (
              <div style={{ fontSize: "0.85rem", marginTop: 4 }}>result: {JSON.stringify(r.result)}</div>
            )}
            {(r.status === "queued" || r.status === "running") && (
              <button onClick={() => void cancel(r.runId)} style={{ marginTop: 4 }}>
                cancel
              </button>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
