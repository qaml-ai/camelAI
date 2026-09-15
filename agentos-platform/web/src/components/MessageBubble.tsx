import type { UiMessage, UiPart } from "@shared/index";

type MessageBubbleProps = {
  message: UiMessage;
};

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function MessagePart({ part }: { part: UiPart }) {
  switch (part.type) {
    case "text":
      return (
        <div className="message-text">
          {part.text}
          {part.state === "streaming" && (
            <span className="streaming-cursor" aria-label="Streaming" />
          )}
        </div>
      );
    case "reasoning":
      return (
        <details className="reasoning-block">
          <summary>Thinking</summary>
          <div>{part.text}</div>
        </details>
      );
    case "tool-call":
      return (
        <details className="tool-block" open={part.state === "input-streaming"}>
          <summary>
            <span className="tool-icon" aria-hidden="true">
              ⌁
            </span>
            <span>{part.toolName}</span>
            <span className="tool-state">
              {part.state === "input-streaming" ? "preparing" : "called"}
            </span>
          </summary>
          <pre>{displayValue(part.input)}</pre>
        </details>
      );
    case "tool-result":
      return (
        <details className={`tool-block ${part.isError ? "tool-error" : ""}`}>
          <summary>
            <span className="tool-icon" aria-hidden="true">
              {part.isError ? "!" : "✓"}
            </span>
            <span>{part.toolName ?? "Tool result"}</span>
            <span className="tool-state">
              {part.isError ? "failed" : "complete"}
            </span>
          </summary>
          <pre>{displayValue(part.output)}</pre>
        </details>
      );
    case "data-error":
      return (
        <div className="message-error" role="alert">
          <strong>{part.data.title ?? "Agent error"}</strong>
          <span>{part.data.error}</span>
        </div>
      );
    case "data-todos":
      return (
        <div className="inline-todos">
          {part.data.explanation && <p>{part.data.explanation}</p>}
          <ul>
            {part.data.todos.map((todo, index) => (
              <li key={`${todo.content}-${index}`}>
                <span className={`todo-state ${todo.status}`} />
                {todo.status === "in_progress"
                  ? todo.activeForm
                  : todo.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case "data-tool-stream":
      return (
        <pre className="tool-stream" data-sequence={part.data.seq}>
          {part.data.text}
        </pre>
      );
  }
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <article className={`message-row ${isUser ? "message-user" : ""}`}>
      <div className={`message-avatar ${isUser ? "user-avatar" : ""}`}>
        {isUser ? "Y" : "c"}
      </div>
      <div className="message-content">
        <div className="message-meta">
          <strong>{isUser ? "You" : "camelAI"}</strong>
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        <div className="message-parts">
          {message.parts.map((part, index) => (
            <MessagePart
              key={
                "toolCallId" in part
                  ? `${part.type}-${part.toolCallId}`
                  : `${part.type}-${index}`
              }
              part={part}
            />
          ))}
        </div>
      </div>
    </article>
  );
}
