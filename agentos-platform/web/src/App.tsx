import { useMemo } from "react";
import {
  createMemoryChatTransport,
  useRivetChat,
} from "@client/use-rivet-chat";
import { ChatPanel } from "./components/ChatPanel";

const endpoint =
  import.meta.env.VITE_RIVET_ENDPOINT ?? "http://localhost:6420";
const useMemory = import.meta.env.VITE_CHAT_MODE === "memory";

export function App() {
  const transport = useMemo(
    () => (useMemory ? createMemoryChatTransport() : undefined),
    [],
  );
  const chat = useRivetChat({
    endpoint,
    transport,
    threadId: "thread_demo",
    workspaceId: "ws_demo",
    orgId: "org_demo",
    projectId: "app",
    initialTitle: "Build the next feature",
  });

  return (
    <div className="app-shell">
      <aside className="workspace-rail" aria-label="Workspace navigation">
        <div className="brand">
          <span className="brand-mark">c</span>
          <span>camelAI</span>
        </div>

        <nav className="rail-nav">
          <button className="rail-item active" type="button">
            <span className="rail-icon" aria-hidden="true">
              ◫
            </span>
            Agent
          </button>
          <button className="rail-item" type="button">
            <span className="rail-icon" aria-hidden="true">
              ⌘
            </span>
            Files
          </button>
          <button className="rail-item" type="button">
            <span className="rail-icon" aria-hidden="true">
              ⎇
            </span>
            Deploys
          </button>
        </nav>

        <div className="workspace-switcher">
          <span className="eyebrow">Workspace</span>
          <strong>Demo workspace</strong>
          <span className="muted">app / main</span>
        </div>
      </aside>

      <main className="workbench">
        <header className="topbar">
          <div>
            <span className="eyebrow">Agent session</span>
            <h1>{chat.threadState.title ?? "Untitled thread"}</h1>
          </div>
          <div className="topbar-actions">
            <span className={`status-pill status-${chat.connStatus}`}>
              <span className="status-dot" />
              {chat.connStatus}
            </span>
            <button
              className="button secondary"
              type="button"
              onClick={() => void chat.refresh()}
              disabled={chat.connStatus !== "connected"}
            >
              Refresh
            </button>
          </div>
        </header>

        <div className="workbench-body">
          <ChatPanel chat={chat} />

          <aside className="context-panel" aria-label="Session context">
            <section className="context-section">
              <div className="section-heading">
                <span>Session</span>
                <span className="section-count">{chat.turnStatus}</span>
              </div>
              <dl className="metadata-list">
                <div>
                  <dt>Model</dt>
                  <dd>{chat.threadState.model ?? "Default"}</dd>
                </div>
                <div>
                  <dt>Context</dt>
                  <dd>
                    {chat.threadState.contextUsedPercent === null
                      ? "—"
                      : `${chat.threadState.contextUsedPercent}%`}
                  </dd>
                </div>
                <div>
                  <dt>Endpoint</dt>
                  <dd title={endpoint}>
                    {useMemory ? "In-memory demo" : endpoint}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="context-section context-grow">
              <div className="section-heading">
                <span>Plan</span>
                <span className="section-count">
                  {chat.threadState.currentTodos.length}
                </span>
              </div>
              {chat.threadState.currentTodos.length === 0 ? (
                <p className="empty-copy">
                  Agent todos will appear here during a turn.
                </p>
              ) : (
                <ul className="todo-list">
                  {chat.threadState.currentTodos.map((todo, index) => (
                    <li key={`${todo.content}-${index}`}>
                      <span className={`todo-state ${todo.status}`} />
                      <span>
                        {todo.status === "in_progress"
                          ? todo.activeForm
                          : todo.content}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="context-section">
              <div className="section-heading">
                <span>Preview</span>
              </div>
              {chat.threadState.previewUrl ? (
                <a
                  className="preview-link"
                  href={chat.threadState.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open current preview ↗
                </a>
              ) : (
                <p className="empty-copy">No preview is active.</p>
              )}
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
