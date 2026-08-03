"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { uuidv7 } from "uuidv7";
import { AppNav } from "@/components/AppNav";
import { SetupHint } from "@/components/SetupHint";

interface Project {
  id: string;
  name: string;
}

interface Chat {
  id: string;
  project_id: string | null;
  name: string;
  name_code: string | null;
  name_params: Record<string, string> | null;
}

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  content_code: string | null;
  content_params: Record<string, string> | null;
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

  /** null = Eingabe geschlossen; "" = offen und noch leer. */
  const [newProject, setNewProject] = useState<string | null>(null);

  async function createProject() {
    // Ein leerer Name legt nichts an — ein namenloser Ordner ist kein Ordner.
    const name = (newProject ?? "").trim();
    if (!name) return;
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      setError("project_create_failed");
      return;
    }
    setNewProject(null);
    await loadProjects();
  }

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
        {
          id: userMessageId,
          role: "user",
          content: message,
          content_code: null,
          content_params: null,
          render_artifacts: null,
          run_id: runId,
        },
        {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          content_code: null,
          content_params: null,
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

  // Ein Werkzeug ist eine Zeile, nicht ein Ereignis je Zeile: tool_running und
  // das spätere tool_completed desselben Aufrufs fallen zusammen. Sonst wächst
  // der Verlauf bei jedem Schritt um einen Block, den niemand liest.
  const toolRuns = (() => {
    const order: string[] = [];
    const byKey = new Map<string, { tool: string; done: boolean; params: StreamActivity["params"] }>();
    for (const a of activities) {
      if (a.code !== "tool_running" && a.code !== "tool_completed") continue;
      const key = String(a.params.tool ?? a.code);
      if (!byKey.has(key)) {
        order.push(key);
        byKey.set(key, { tool: key, done: false, params: {} });
      }
      const entry = byKey.get(key)!;
      entry.params = { ...entry.params, ...a.params };
      if (a.code === "tool_completed") entry.done = true;
    }
    return order.map((k) => byKey.get(k)!);
  })();

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <AppNav />
      <div className="chat">
        <aside className="projects">
          {projects.map((p) => (
            <div key={p.id}>
              <div className="pgroup">{p.name}</div>
              {chats
                .filter((c) => c.project_id === p.id)
                .map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="pitem"
                    aria-current={c.id === activeChatId ? "true" : "false"}
                    onClick={() => void loadChat(c.id)}
                  >
                    {c.name_code
                      ? t(c.name_code as never, (c.name_params ?? {}) as never)
                      : c.name || c.id.slice(0, 8)}
                  </button>
                ))}
            </div>
          ))}
          <div style={{ padding: "10px 14px 0", display: "grid", gap: 6 }}>
            <button
              type="button"
              className="btn pri"
              onClick={() => {
                setActiveChatId(null);
                setMessages([]);
                setStreaming("");
              }}
            >
              {t("app.newChat")}
            </button>
            {/* Ohne dies blieb die Projektgliederung leer: das API konnte
                Projekte anlegen, die Oberfläche hat es nie angeboten. */}
            {newProject === null ? (
              <button type="button" className="btn" onClick={() => setNewProject("")}>
                {t("app.newProject")}
              </button>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void createProject();
                }}
                style={{ display: "grid", gap: 6 }}
              >
                <input
                  value={newProject}
                  onChange={(e) => setNewProject(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setNewProject(null);
                  }}
                  placeholder={t("app.newProjectPlaceholder")}
                  aria-label={t("app.newProject")}
                  autoComplete="off"
                  autoFocus
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="submit" className="btn pri" disabled={!newProject.trim()}>
                    {t("app.create")}
                  </button>
                  <button type="button" className="btn" onClick={() => setNewProject(null)}>
                    {t("app.cancel")}
                  </button>
                </div>
              </form>
            )}
          </div>
        </aside>

        <main className="thread">
          <SetupHint style={{ margin: "12px 20px 0" }} />
          <div className="msgs">
            {messages.length === 0 && !streaming && (
              <div className="empty">
                <h3>{t("empty.chatTitle")}</h3>
                <p>{t("empty.chatBody")}</p>
              </div>
            )}
            {messages.map((m) => {
              const isAgent = m.role === "assistant";
              const live = isAgent && !m.content && streaming;
              const body = live
                ? streaming
                : m.content_code
                  ? t(m.content_code as never, (m.content_params ?? {}) as never)
                  : m.content;
              return (
                <div className="msg" key={m.id}>
                  <div className={isAgent ? "who agent" : "who"}>
                    {isAgent ? t("app.title") : t("chat.you")}
                  </div>
                  <div>
                    {/* Die Werkzeugzeilen gehören zur laufenden Antwort und stehen
                        deshalb über ihr, nicht als eigener Abschnitt am Ende. */}
                    {isAgent && live && toolRuns.length > 0 && (
                      <div>
                        {toolRuns.map((run) => (
                          <details className="tool" key={run.tool} open={!run.done}>
                            <summary>
                              <span className="tname">{run.tool}</span>
                              <span
                                className="tstate"
                                style={{ color: run.done ? "var(--good)" : "var(--dim)" }}
                              >
                                {run.done ? t("chat.toolCompleted") : t("chat.toolRunning")}
                              </span>
                            </summary>
                            <div className="tbody">
                              {Object.entries(run.params)
                                .filter(([key]) => key !== "tool")
                                .map(([key, value]) => (
                                  <div key={key}>
                                    {key} <b>{String(value)}</b>
                                  </div>
                                ))}
                            </div>
                          </details>
                        ))}
                      </div>
                    )}
                    <p style={{ whiteSpace: "pre-wrap" }}>
                      {body}
                      {live && <span className="stream" />}
                    </p>
                  </div>
                </div>
              );
            })}

            {/* Die Freigabe steht im Verlauf, nicht als Modal darüber: ein Dialog,
                der den Chat verdeckt, nimmt genau den Kontext weg, auf dem die
                Entscheidung beruht. */}
            {approval && (
              <div className="msg">
                <div className="who agent">{t("app.title")}</div>
                <div className="approve">
                  <div className="ahead">
                    <h4>{t("chat.approvalRequired")}</h4>
                    {approval.costEstimate && (
                      <span className="cost">{approval.costEstimate}</span>
                    )}
                  </div>
                  <dl className="kv">
                    <dt>{t("chat.tool")}</dt>
                    <dd>{approval.tool}</dd>
                    {Object.entries(
                      (approval.resolvedPayload ?? {}) as Record<string, unknown>,
                    ).map(([key, value]) => (
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
                  <div className="hashline">
                    sha256 <b>{approval.resolvedRequestHash.slice(0, 12)}…</b> —{" "}
                    {t("chat.approvalHashHint")}
                  </div>
                  <div className="acts">
                    <button type="button" className="btn pri" onClick={() => void decide(true)}>
                      {t("chat.approve")}
                    </button>
                    <button type="button" className="btn" onClick={() => void decide(false)}>
                      {t("chat.deny")}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="msgbox err data" role="alert">
                {error}
              </div>
            )}
          </div>

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("chat.placeholder")}
              aria-label={t("chat.placeholder")}
              autoComplete="off"
            />
            <button type="submit" className="btn pri">
              {t("app.send")}
            </button>
          </form>
        </main>
      </div>
    </div>
  );
}
