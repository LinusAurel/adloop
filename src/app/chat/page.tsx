"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { uuidv7 } from "uuidv7";
import { AppNav } from "@/components/AppNav";

interface Project {
  id: string;
  name: string;
}

interface Chat {
  id: string;
  project_id: string | null;
  name: string;
}

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  render_artifacts: unknown;
  run_id: string | null;
}

interface StreamActivity {
  code: string;
  params: Record<string, string | number | boolean>;
}

interface PendingApproval {
  approvalId: string;
  tool: string;
  resolvedRequestHash: string;
  costEstimate: string;
  resolvedPayload?: unknown;
}

export default function ChatPage() {
  const t = useTranslations();
  const [projects, setProjects] = useState<Project[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [activities, setActivities] = useState<StreamActivity[]>([]);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seenSeq = useRef(new Set<number>());
  const abortRef = useRef<AbortController | null>(null);

  const loadProjects = useCallback(async () => {
    const res = await fetch("/api/projects", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { projects: Project[] };
    setProjects(data.projects);
  }, []);

  const loadChats = useCallback(async (projectId?: string) => {
    const url = projectId ? `/api/chats?projectId=${projectId}` : "/api/chats";
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { chats: Chat[] };
    setChats(data.chats);
  }, []);

  const loadChat = useCallback(async (chatId: string) => {
    const res = await fetch(`/api/chats/${chatId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { messages: ChatMessage[] };
    setMessages(data.messages);
    setActiveChatId(chatId);
  }, []);

  useEffect(() => {
    void loadProjects().then(() => loadChats());
  }, [loadProjects, loadChats]);

  async function ensureChat(): Promise<string> {
    if (activeChatId) return activeChatId;
    const projectId = projects[0]?.id ?? null;
    const res = await fetch("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, name: t("app.newChat") }),
    });
    if (!res.ok) throw new Error("chat_create_failed");
    const data = (await res.json()) as { id: string };
    await loadChats(projectId ?? undefined);
    setActiveChatId(data.id);
    return data.id;
  }

  async function connectEvents(runId: string, after = 0) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const res = await fetch(`/api/chat/runs/${runId}/events?after=${after}`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) {
      setError(`events_${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastSeq = after;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.startsWith(": hb")) continue;
        if (part.includes("data: [DONE]")) {
          setStreaming((s) => s);
          return;
        }
        const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
        const idLine = part.split("\n").find((l) => l.startsWith("id: "));
        if (!dataLine) continue;
        const seq = idLine ? Number(idLine.slice(4)) : undefined;
        // Client dedupes by seq (auftrag §0.3).
        if (seq !== undefined && seenSeq.current.has(seq)) continue;
        if (seq !== undefined) {
          seenSeq.current.add(seq);
          lastSeq = seq;
        }
        try {
          const event = JSON.parse(dataLine.slice(6)) as {
            seq: number;
            kind: string;
            payload: Record<string, unknown>;
          };
          if (event.kind === "delta") {
            setStreaming((prev) => prev + String(event.payload.text ?? ""));
          } else if (event.kind === "activity") {
            const code = String(event.payload.code ?? "");
            const params = (event.payload.params ?? {}) as Record<
              string,
              string | number | boolean
            >;
            setActivities((prev) => [...prev, { code, params }]);
            if (code === "approval_required") {
              const approvalId = String(params.approvalId ?? "");
              setApproval({
                approvalId,
                tool: String(params.tool ?? ""),
                resolvedRequestHash: String(params.resolvedRequestHash ?? ""),
                costEstimate: String(params.costEstimate ?? ""),
              });
              void fetch(`/api/tool-approvals/${approvalId}`)
                .then((r) => r.json())
                .then((body: { resolved_payload?: unknown }) => {
                  setApproval((prev) =>
                    prev
                      ? { ...prev, resolvedPayload: body.resolved_payload }
                      : prev,
                  );
                });
            }
          }
        } catch {
          /* ignore malformed */
        }
      }
    }
    // Auto-reconnect on drop with same runId (Fall 2).
    if (!controller.signal.aborted) {
      await connectEvents(runId, lastSeq);
    }
  }

  async function send() {
    if (!draft.trim()) return;
    setError(null);
    setStreaming("");
    setActivities([]);
    setApproval(null);
    seenSeq.current = new Set();
    try {
      const chatId = await ensureChat();
      const runId = uuidv7();
      const userMessageId = uuidv7();
      const assistantMessageId = uuidv7();
      const message = draft.trim();
      setDraft("");
      setMessages((prev) => [
        ...prev,
        { id: userMessageId, role: "user", content: message, render_artifacts: null, run_id: runId },
        {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          render_artifacts: null,
          run_id: runId,
        },
      ]);
      const res = await fetch("/api/chat/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          chatId,
          userMessageId,
          assistantMessageId,
          message,
          playbookSlug: "general",
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `error_${res.status}`);
        return;
      }
      void connectEvents(runId, 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "send_failed");
    }
  }

  async function decide(approve: boolean) {
    if (!approval) return;
    await fetch(`/api/tool-approvals/${approval.approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve }),
    });
    if (!approve) setApproval(null);
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <AppNav />
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "220px 1fr",
          minHeight: 0,
        }}
      >
        <aside
          style={{
            borderRight: "1px solid var(--line)",
            background: "var(--surface)",
            padding: "0.75rem",
            overflow: "auto",
          }}
        >
          <div style={{ color: "var(--dim)", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            {t("app.projects")}
          </div>
          {projects.map((p) => (
            <div key={p.id} style={{ marginBottom: "0.75rem" }}>
              <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>{p.name}</div>
              {chats
                .filter((c) => c.project_id === p.id)
                .map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => void loadChat(c.id)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background:
                        c.id === activeChatId ? "var(--raised)" : "transparent",
                      color: "var(--fg)",
                      border: "none",
                      borderRadius: "var(--radius)",
                      padding: "0.35rem 0.5rem",
                      cursor: "pointer",
                    }}
                  >
                    {c.name || c.id.slice(0, 8)}
                  </button>
                ))}
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              setActiveChatId(null);
              setMessages([]);
              setStreaming("");
            }}
            style={{
              width: "100%",
              marginTop: "0.5rem",
              background: "var(--accent)",
              color: "var(--on-accent)",
              border: "none",
              borderRadius: "var(--radius)",
              padding: "0.5rem",
              cursor: "pointer",
            }}
          >
            {t("app.newChat")}
          </button>
        </aside>

        <main style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ flex: 1, overflow: "auto", padding: "1rem" }}>
            {messages.length === 0 && !streaming && (
              <p style={{ color: "var(--dim)" }}>{t("chat.empty")}</p>
            )}
            {messages.map((m) => (
              <div key={m.id} style={{ marginBottom: "1rem" }}>
                <div style={{ color: "var(--dim)", fontSize: "0.75rem" }}>{m.role}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>
                  {m.role === "assistant" && !m.content && streaming
                    ? streaming
                    : m.content}
                </div>
              </div>
            ))}

            {activities.map((a, i) => (
              <details
                key={`${a.code}-${i}`}
                style={{
                  marginBottom: "0.5rem",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--radius)",
                  padding: "0.35rem 0.5rem",
                  background: "var(--raised)",
                }}
              >
                <summary style={{ cursor: "pointer" }}>
                  {a.code === "tool_running"
                    ? `${t("chat.toolRunning")}: `
                    : a.code === "tool_completed"
                      ? `${t("chat.toolCompleted")}: `
                      : a.code === "approval_required"
                        ? `${t("chat.approvalRequired")}: `
                        : ""}
                  <span className="data">{String(a.params.tool ?? a.code)}</span>
                </summary>
                <pre className="data" style={{ margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
                  {JSON.stringify(a.params, null, 2)}
                </pre>
              </details>
            ))}

            {approval && (
              <div
                style={{
                  border: "1px solid var(--warn)",
                  borderRadius: "var(--radius)",
                  padding: "0.75rem",
                  background: "var(--raised)",
                  marginTop: "0.75rem",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
                  {t("chat.approvalRequired")}: <span className="data">{approval.tool}</span>
                </div>
                <div style={{ color: "var(--warn)", marginBottom: "0.5rem" }}>
                  {t("chat.costEstimate")}: <span className="data">{approval.costEstimate}</span>
                </div>
                <div style={{ marginBottom: "0.35rem" }}>{t("chat.resolvedValues")}</div>
                <pre className="data" style={{ fontSize: "0.8rem", overflow: "auto" }}>
                  {JSON.stringify(approval.resolvedPayload ?? {}, null, 2)}
                </pre>
                <div className="data" style={{ fontSize: "0.75rem", margin: "0.5rem 0" }}>
                  hash {approval.resolvedRequestHash}
                </div>
                <p style={{ color: "var(--dim)", fontSize: "0.85rem" }}>
                  {t("chat.approvalHashHint")}
                </p>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    type="button"
                    onClick={() => void decide(true)}
                    style={{
                      background: "var(--accent)",
                      color: "var(--on-accent)",
                      border: "none",
                      borderRadius: "var(--radius)",
                      padding: "0.4rem 0.75rem",
                      cursor: "pointer",
                    }}
                  >
                    {t("chat.approve")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void decide(false)}
                    style={{
                      background: "var(--surface)",
                      color: "var(--fg)",
                      border: "1px solid var(--line)",
                      borderRadius: "var(--radius)",
                      padding: "0.4rem 0.75rem",
                      cursor: "pointer",
                    }}
                  >
                    {t("chat.deny")}
                  </button>
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            style={{
              display: "flex",
              gap: "0.5rem",
              padding: "0.75rem",
              borderTop: "1px solid var(--line)",
              background: "var(--surface)",
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("chat.placeholder")}
              style={{
                flex: 1,
                background: "var(--bg)",
                color: "var(--fg)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius)",
                padding: "0.6rem 0.75rem",
              }}
            />
            <button
              type="submit"
              style={{
                background: "var(--accent)",
                color: "var(--on-accent)",
                border: "none",
                borderRadius: "var(--radius)",
                padding: "0.6rem 1rem",
                cursor: "pointer",
              }}
            >
              {t("app.send")}
            </button>
          </form>
          {error && (
            <p style={{ color: "var(--crit)", padding: "0 0.75rem 0.75rem" }} className="data">
              {error}
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
