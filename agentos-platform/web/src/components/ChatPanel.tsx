import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRivetChat } from "@client/use-rivet-chat";
import type { AskUserQuestionItem } from "@shared/index";
import { MessageBubble } from "./MessageBubble";

type ChatPanelProps = {
  chat: ReturnType<typeof useRivetChat>;
};

function selectedValues(value: string | undefined): string[] {
  return value ? value.split("\n").filter(Boolean) : [];
}

export function ChatPanel({ chat }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const messageEndRef = useRef<HTMLDivElement>(null);
  const pendingQuestion = chat.threadState.pendingQuestion;
  const isRunning =
    chat.turnStatus === "streaming" || chat.turnStatus === "recovering";

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [chat.messages]);

  useEffect(() => {
    setAnswers({});
  }, [pendingQuestion?.questionId]);

  async function submitMessage(event?: FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || chat.connStatus !== "connected") return;
    setDraft("");
    try {
      await chat.sendMessage(content);
    } catch {
      setDraft(content);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  }

  function toggleOption(question: AskUserQuestionItem, label: string) {
    setAnswers((current) => {
      if (!question.multiSelect) {
        return { ...current, [question.question]: label };
      }
      const selected = selectedValues(current[question.question]);
      const next = selected.includes(label)
        ? selected.filter((value) => value !== label)
        : [...selected, label];
      return { ...current, [question.question]: next.join("\n") };
    });
  }

  async function submitAnswers(event: FormEvent) {
    event.preventDefault();
    if (!pendingQuestion) return;
    await chat.answerQuestion(pendingQuestion.questionId, answers);
  }

  return (
    <section className="chat-panel" aria-label="Agent conversation">
      <div className="message-list" aria-live="polite">
        {chat.messages.length === 0 ? (
          <div className="empty-chat">
            <span className="empty-chat-mark">c</span>
            <h2>What should camelAI work on?</h2>
            <p>
              Describe a feature, bug, or investigation. The agent can inspect
              and modify this workspace.
            </p>
            {chat.connStatus === "connected" && (
              <div className="prompt-examples">
                <button
                  type="button"
                  onClick={() =>
                    setDraft("Inspect the project and summarize its architecture.")
                  }
                >
                  Summarize the architecture
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDraft("Find the highest-impact issue and propose a fix.")
                  }
                >
                  Find a high-impact issue
                </button>
              </div>
            )}
          </div>
        ) : (
          chat.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))
        )}
        <div ref={messageEndRef} />
      </div>

      {pendingQuestion && (
        <form className="question-card" onSubmit={submitAnswers}>
          <div className="question-card-header">
            <span className="agent-avatar">c</span>
            <div>
              <strong>Agent needs input</strong>
              <span>Choose an option to continue the turn.</span>
            </div>
          </div>

          {pendingQuestion.questions.map((question) => (
            <fieldset key={question.question}>
              <legend>
                <span>{question.header}</span>
                {question.question}
              </legend>
              <div className="question-options">
                {question.options.map((option) => {
                  const isSelected = selectedValues(
                    answers[question.question],
                  ).includes(option.label);
                  return (
                    <button
                      key={option.label}
                      className={isSelected ? "selected" : ""}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => toggleOption(question, option.label)}
                    >
                      <strong>{option.label}</strong>
                      {option.description && <span>{option.description}</span>}
                    </button>
                  );
                })}
              </div>
              {question.allowOther !== false && (
                <input
                  className="question-other"
                  value={
                    question.options.some((option) =>
                      selectedValues(answers[question.question]).includes(
                        option.label,
                      ),
                    )
                      ? ""
                      : (answers[question.question] ?? "")
                  }
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.question]: event.target.value,
                    }))
                  }
                  placeholder="Or type a custom answer"
                />
              )}
            </fieldset>
          ))}

          <div className="question-actions">
            <button
              className="button primary"
              type="submit"
              disabled={pendingQuestion.questions.some(
                (question) => !answers[question.question]?.trim(),
              )}
            >
              Continue
            </button>
          </div>
        </form>
      )}

      {chat.error && (
        <div className="error-banner" role="alert">
          <strong>Chat error</strong>
          <span>{chat.error.message}</span>
        </div>
      )}

      <form className="composer" onSubmit={submitMessage}>
        <textarea
          aria-label="Message camelAI"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposerKeyDown}
          placeholder={
            chat.connStatus === "connected"
              ? "Ask camelAI to build, debug, or explain…"
              : "Connecting to agentOS…"
          }
          rows={3}
          disabled={chat.connStatus !== "connected" || !!pendingQuestion}
        />
        <div className="composer-footer">
          <span>
            Enter to send <kbd>Shift</kbd> + <kbd>Enter</kbd> for newline
          </span>
          {isRunning ? (
            <button
              className="button stop"
              type="button"
              onClick={() => void chat.requestStop()}
            >
              <span className="stop-square" />
              Stop
            </button>
          ) : (
            <button
              className="button primary"
              type="submit"
              disabled={!draft.trim() || chat.connStatus !== "connected"}
            >
              Send
              <span aria-hidden="true">↵</span>
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
