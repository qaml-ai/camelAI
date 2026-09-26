"use client";

import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  normalizeAskUserQuestions,
  type NormalizedAskUserQuestion,
} from "@/lib/ask-user-question-normalization";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  MessageCircleQuestion,
  Send,
  ChevronUp,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

export type Question = Omit<NormalizedAskUserQuestion, "allowOther"> & {
  allowOther?: boolean;
};

export interface AskUserQuestionData {
  questionId: string;
  toolUseId?: string;
  questions: Question[];
}

interface AskUserQuestionProps {
  data: AskUserQuestionData;
  onSubmit: (answers: Record<string, string>) => void;
  className?: string;
}

interface QuestionState {
  selected: string[];
  otherText: string;
  isOther: boolean;
}

function questionAllowsOther(question: Question): boolean {
  return question.allowOther !== false;
}

const EMPTY_QUESTION: Question = {
  question: "",
  header: "",
  options: [],
  multiSelect: false,
};

const SHORTCUT_BADGE_CLASS_NAME = cn(
  "inline-flex h-5 w-5 shrink-0 self-center items-center justify-center rounded border border-border",
  "text-xs font-mono leading-none text-muted-foreground",
);

function createEmptyQuestionState(): QuestionState {
  return { selected: [], otherText: "", isOther: false };
}

function createInitialQuestionStates(
  questions: Question[],
): Record<string, QuestionState> {
  const initial: Record<string, QuestionState> = {};
  for (const question of questions) {
    initial[question.question] = createEmptyQuestionState();
  }
  return initial;
}

function ShortcutBadge({ label }: { label: string | null }) {
  if (!label) {
    return <span aria-hidden="true" className="inline-flex h-5 w-5 shrink-0" />;
  }

  return (
    <kbd aria-hidden="true" className={SHORTCUT_BADGE_CLASS_NAME}>
      {label}
    </kbd>
  );
}

function isEditableTarget(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }

  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element.isContentEditable ||
    Boolean(
      element.closest(
        '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
      ),
    )
  );
}

function isQuestionOtherInputTarget(element: HTMLElement | null): boolean {
  return (
    element instanceof HTMLInputElement &&
    element.dataset.askUserQuestionOtherInput === "true"
  );
}

export function AskUserQuestion({
  data,
  onSubmit,
  className,
}: AskUserQuestionProps) {
  const questions = useMemo(
    () => normalizeAskUserQuestions(data.questions),
    [data.questions],
  );
  const [questionStates, setQuestionStates] = useState<
    Record<string, QuestionState>
  >(() => createInitialQuestionStates(questions));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);

  // Reset state when a new question payload arrives
  useLayoutEffect(() => {
    setCurrentQuestionIndex(0);
    setIsSubmitting(false);
    setQuestionStates(createInitialQuestionStates(questions));
  }, [data.questionId, questions]);

  useLayoutEffect(() => {
    setFocusedIndex(0);
  }, [data.questionId, currentQuestionIndex]);

  useEffect(() => {
    const focusWidgetIfNeeded = () => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const activeElement = document.activeElement;
      if (activeElement instanceof Element && container.contains(activeElement)) {
        return;
      }

      container.focus();
    };

    focusWidgetIfNeeded();
    const timer = window.setTimeout(focusWidgetIfNeeded, 100);
    return () => window.clearTimeout(timer);
  }, [data.questionId]);

  useEffect(() => {
    if (currentQuestionIndex === 0) {
      return;
    }

    const timer = window.setTimeout(() => containerRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [currentQuestionIndex]);

  const totalQuestions = questions.length;
  const hasQuestions = totalQuestions > 0;
  const hasMultipleQuestions = totalQuestions > 1;
  // Clamp index to valid range to handle transitional render before useEffect resets it
  const safeIndex = hasQuestions
    ? Math.min(currentQuestionIndex, totalQuestions - 1)
    : 0;
  const isLastQuestion = !hasQuestions || safeIndex === totalQuestions - 1;
  const currentQuestion = questions[safeIndex] ?? EMPTY_QUESTION;
  const currentState =
    questionStates[currentQuestion.question] ?? createEmptyQuestionState();
  const allowsOther = questionAllowsOther(currentQuestion);
  const otherOptionIndex = currentQuestion.options.length;
  const totalOptions = currentQuestion.options.length + (allowsOther ? 1 : 0);
  const keyboardHint = `# to pick · ↵ ${isLastQuestion ? "submit" : "next"}`;
  const keyboardHintId = `ask-user-question-hint-${data.questionId}-${safeIndex}`;

  const focusContainer = useCallback(() => {
    containerRef.current?.focus();
  }, []);

  const focusOtherInput = useCallback(() => {
    window.setTimeout(() => otherInputRef.current?.focus(), 0);
  }, []);

  const collapseWidget = useCallback(() => {
    setIsExpanded(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const handleExpandedChange = useCallback((open: boolean) => {
    setIsExpanded(open);
    if (open) {
      window.setTimeout(() => containerRef.current?.focus(), 0);
    }
  }, []);

  const updateQuestionState = useCallback(
    (questionText: string, update: Partial<QuestionState>) => {
      setQuestionStates((prev) => ({
        ...prev,
        [questionText]: {
          ...(prev[questionText] ?? createEmptyQuestionState()),
          ...update,
        },
      }));
    },
    [],
  );

  const handleSingleSelect = useCallback(
    (questionText: string, value: string) => {
      if (value === "__other__") {
        updateQuestionState(questionText, { selected: [], isOther: true });
      } else {
        updateQuestionState(questionText, {
          selected: [value],
          isOther: false,
        });
      }
    },
    [updateQuestionState],
  );

  const handleMultiSelect = useCallback(
    (questionText: string, value: string, checked: boolean) => {
      if (value === "__other__") {
        updateQuestionState(questionText, { isOther: checked });
      } else {
        setQuestionStates((prev) => {
          const current = prev[questionText] ?? createEmptyQuestionState();
          const newSelected = checked
            ? [...current.selected, value]
            : current.selected.filter((v) => v !== value);
          return {
            ...prev,
            [questionText]: { ...current, selected: newSelected },
          };
        });
      }
    },
    [updateQuestionState],
  );

  const handleOtherTextChange = useCallback(
    (questionText: string, text: string) => {
      updateQuestionState(questionText, { otherText: text });
    },
    [updateQuestionState],
  );

  const handleSubmitAll = useCallback(() => {
    setIsSubmitting(true);

    const answers: Record<string, string> = {};

    for (const q of questions) {
      const state = questionStates[q.question] ?? createEmptyQuestionState();

      if (state.isOther && state.otherText.trim()) {
        // User provided custom text
        if (q.multiSelect && state.selected.length > 0) {
          // Combine selected options with "Other" text
          answers[q.question] = [
            ...state.selected,
            state.otherText.trim(),
          ].join(", ");
        } else {
          answers[q.question] = state.otherText.trim();
        }
      } else if (state.selected.length > 0) {
        answers[q.question] = state.selected.join(", ");
      } else {
        // No selection - use empty string (SDK will handle)
        answers[q.question] = "";
      }
    }

    onSubmit(answers);
  }, [questions, questionStates, onSubmit]);

  const handleNextOrSubmit = useCallback(() => {
    if (isLastQuestion) {
      handleSubmitAll();
    } else {
      setCurrentQuestionIndex((prev) => prev + 1);
    }
  }, [isLastQuestion, handleSubmitAll]);

  // Validate only the current question
  const isCurrentValid =
    currentState.selected.length > 0 ||
    (currentState.isOther && currentState.otherText.trim());

  const selectByIndex = useCallback(
    (index: number) => {
      const isOtherIndex = allowsOther && index === otherOptionIndex;

      if (isOtherIndex) {
        if (currentQuestion.multiSelect) {
          const nextIsOther = !currentState.isOther;
          handleMultiSelect(currentQuestion.question, "__other__", nextIsOther);
          if (nextIsOther) {
            focusOtherInput();
            return true;
          }
        } else {
          handleSingleSelect(currentQuestion.question, "__other__");
          focusOtherInput();
          return true;
        }
        return false;
      }

      const option = currentQuestion.options[index];
      if (!option) {
        return false;
      }

      if (currentQuestion.multiSelect) {
        const isCurrentlySelected = currentState.selected.includes(
          option.label,
        );
        handleMultiSelect(
          currentQuestion.question,
          option.label,
          !isCurrentlySelected,
        );
      } else {
        handleSingleSelect(currentQuestion.question, option.label);
      }

      return false;
    },
    [
      currentQuestion,
      currentState.isOther,
      currentState.selected,
      focusOtherInput,
      handleMultiSelect,
      handleSingleSelect,
      allowsOther,
      otherOptionIndex,
    ],
  );

  const handleShortcutKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement> | KeyboardEvent) => {
      const target = event.target;
      const targetElement = target instanceof HTMLElement ? target : null;
      const isInOtherInput = isQuestionOtherInputTarget(targetElement);
      const isInOtherEditableTarget =
        isEditableTarget(targetElement) && !isInOtherInput;

      if (event.key === "Escape") {
        if (isInOtherInput) {
          event.preventDefault();
          focusContainer();
          return;
        }

        if (isInOtherEditableTarget) {
          return;
        }

        event.preventDefault();
        if (isExpanded) {
          collapseWidget();
        }
        return;
      }

      if (targetElement?.closest("[data-ask-user-question-control]")) {
        return;
      }

      if (!isExpanded || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      if (isInOtherEditableTarget) {
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (isCurrentValid && !isSubmitting) {
          handleNextOrSubmit();
        }
        return;
      }

      if (isInOtherInput) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocusedIndex((index) => (index + 1) % totalOptions);
        focusContainer();
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocusedIndex((index) => (index - 1 + totalOptions) % totalOptions);
        focusContainer();
        return;
      }

      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        const handledFocus = selectByIndex(focusedIndex);
        if (!handledFocus) {
          focusContainer();
        }
        return;
      }

      if (event.key >= "1" && event.key <= "9") {
        const index = Number(event.key) - 1;
        if (index < currentQuestion.options.length) {
          event.preventDefault();
          setFocusedIndex(index);
          const handledFocus = selectByIndex(index);
          if (!handledFocus) {
            focusContainer();
          }
        }
        return;
      }

      if (event.key === "0" && allowsOther) {
        event.preventDefault();
        setFocusedIndex(otherOptionIndex);
        const handledFocus = selectByIndex(otherOptionIndex);
        if (!handledFocus) {
          focusContainer();
        }
      }
    },
    [
      collapseWidget,
      allowsOther,
      currentQuestion.options.length,
      focusContainer,
      focusedIndex,
      handleNextOrSubmit,
      isCurrentValid,
      isExpanded,
      isSubmitting,
      otherOptionIndex,
      selectByIndex,
      totalOptions,
    ],
  );

  useEffect(() => {
    if (!hasQuestions || !isExpanded) {
      return;
    }

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }

      handleShortcutKey(event);
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [handleShortcutKey, hasQuestions, isExpanded]);

  const handlePointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target.closest("[data-ask-user-question-control]")
      ) {
        return;
      }

      window.setTimeout(() => containerRef.current?.focus(), 0);
    },
    [],
  );

  if (!hasQuestions) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleShortcutKey}
      onPointerDownCapture={handlePointerDownCapture}
      aria-label={currentQuestion.question}
      aria-describedby={keyboardHintId}
      data-ask-user-question-root="true"
      className={cn(
        "rounded-xl border border-border/50 bg-background/95 backdrop-blur-sm shadow-sm",
        "overflow-hidden outline-none",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
        className,
      )}
    >
      <Collapsible open={isExpanded} onOpenChange={handleExpandedChange}>
        {/* Header */}
        <CollapsibleTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            data-ask-user-question-control="toggle"
            className={cn(
              "flex w-full items-center gap-2 px-4 py-3 text-sm text-muted-foreground",
              "hover:bg-muted/30 transition-colors",
              "cursor-pointer",
            )}
          >
            <MessageCircleQuestion className="h-4 w-4 text-muted-foreground/60" />
            <span className="flex-1 text-left">The agent needs your input</span>
            {isExpanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground/40" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground/40" />
            )}
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent
          className={cn(
            "overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
            "motion-reduce:animate-none",
          )}
        >
          {/* Current Question */}
          <div className="px-4 pb-3 space-y-3">
            {/* Question header and text */}
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {currentQuestion.header}
              </span>
              <p className="text-sm text-foreground">
                {currentQuestion.question}
              </p>
            </div>

            {/* Options */}
            {currentQuestion.multiSelect ? (
              <div
                role="group"
                aria-label={currentQuestion.question}
                className="space-y-1"
              >
                {currentQuestion.options.map((opt, optIndex) => (
                  <label
                    key={`${opt.label}-${optIndex}`}
                    id={`ask-user-question-option-${data.questionId}-${safeIndex}-${optIndex}`}
                    onClick={() => setFocusedIndex(optIndex)}
                    className={cn(
                      "flex items-center gap-3 py-2 px-2 -mx-2 rounded-md cursor-pointer",
                      "transition-colors hover:bg-muted/20",
                      focusedIndex === optIndex &&
                        "ring-1 ring-ring/50 bg-muted/10",
                    )}
                  >
                    <ShortcutBadge
                      label={optIndex < 9 ? String(optIndex + 1) : null}
                    />
                    <Checkbox
                      checked={currentState.selected.includes(opt.label)}
                      onCheckedChange={(checked) =>
                        handleMultiSelect(
                          currentQuestion.question,
                          opt.label,
                          !!checked,
                        )
                      }
                      onFocus={() => setFocusedIndex(optIndex)}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground">
                        {opt.label}
                      </p>
                      {opt.description && (
                        <p className="text-xs text-muted-foreground">
                          {opt.description}
                        </p>
                      )}
                    </div>
                  </label>
                ))}

                {allowsOther ? (
                  <label
                    id={`ask-user-question-option-${data.questionId}-${safeIndex}-${otherOptionIndex}`}
                    onClick={() => setFocusedIndex(otherOptionIndex)}
                    className={cn(
                      "flex items-center gap-3 py-2 px-2 -mx-2 rounded-md cursor-pointer",
                      "transition-colors hover:bg-muted/20",
                      focusedIndex === otherOptionIndex &&
                        "ring-1 ring-ring/50 bg-muted/10",
                    )}
                  >
                    <ShortcutBadge label="0" />
                    <Checkbox
                      checked={currentState.isOther}
                      onCheckedChange={(checked) =>
                        handleMultiSelect(
                          currentQuestion.question,
                          "__other__",
                          !!checked,
                        )
                      }
                      onFocus={() => setFocusedIndex(otherOptionIndex)}
                    />
                    <div className="flex-1 min-w-0 space-y-2">
                      <p className="text-sm text-foreground">Other</p>
                      {currentState.isOther && (
                        <Input
                          ref={otherInputRef}
                          data-ask-user-question-other-input="true"
                          type="text"
                          placeholder="Type your answer..."
                          value={currentState.otherText}
                          onChange={(e) =>
                            handleOtherTextChange(
                              currentQuestion.question,
                              e.target.value,
                            )
                          }
                          onFocus={() => setFocusedIndex(otherOptionIndex)}
                          className="h-8 text-sm"
                          autoFocus
                        />
                      )}
                    </div>
                  </label>
                ) : null}
              </div>
            ) : (
              <RadioGroup
                aria-label={currentQuestion.question}
                value={
                  currentState.isOther
                    ? "__other__"
                    : currentState.selected[0] || ""
                }
                onValueChange={(value: string) =>
                  handleSingleSelect(currentQuestion.question, value)
                }
                className="space-y-1"
              >
                {currentQuestion.options.map((opt, optIndex) => (
                  <label
                    key={`${opt.label}-${optIndex}`}
                    id={`ask-user-question-option-${data.questionId}-${safeIndex}-${optIndex}`}
                    onClick={() => setFocusedIndex(optIndex)}
                    className={cn(
                      "flex items-center gap-3 py-2 px-2 -mx-2 rounded-md cursor-pointer",
                      "transition-colors hover:bg-muted/20",
                      focusedIndex === optIndex &&
                        "ring-1 ring-ring/50 bg-muted/10",
                    )}
                  >
                    <ShortcutBadge
                      label={optIndex < 9 ? String(optIndex + 1) : null}
                    />
                    <RadioGroupItem
                      value={opt.label}
                      onFocus={() => setFocusedIndex(optIndex)}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground">
                        {opt.label}
                      </p>
                      {opt.description && (
                        <p className="text-xs text-muted-foreground">
                          {opt.description}
                        </p>
                      )}
                    </div>
                  </label>
                ))}

                {allowsOther ? (
                  <label
                    id={`ask-user-question-option-${data.questionId}-${safeIndex}-${otherOptionIndex}`}
                    onClick={() => setFocusedIndex(otherOptionIndex)}
                    className={cn(
                      "flex items-center gap-3 py-2 px-2 -mx-2 rounded-md cursor-pointer",
                      "transition-colors hover:bg-muted/20",
                      focusedIndex === otherOptionIndex &&
                        "ring-1 ring-ring/50 bg-muted/10",
                    )}
                  >
                    <ShortcutBadge label="0" />
                    <RadioGroupItem
                      value="__other__"
                      onFocus={() => setFocusedIndex(otherOptionIndex)}
                    />
                    <div className="flex-1 min-w-0 space-y-2">
                      <p className="text-sm text-foreground">Other</p>
                      {currentState.isOther && (
                        <Input
                          ref={otherInputRef}
                          data-ask-user-question-other-input="true"
                          type="text"
                          placeholder="Type your answer..."
                          value={currentState.otherText}
                          onChange={(e) =>
                            handleOtherTextChange(
                              currentQuestion.question,
                              e.target.value,
                            )
                          }
                          onFocus={() => setFocusedIndex(otherOptionIndex)}
                          className="h-8 text-sm"
                          autoFocus
                        />
                      )}
                    </div>
                  </label>
                ) : null}
              </RadioGroup>
            )}
          </div>

          {/* Footer with counter and button */}
          <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-2">
            <span
              id={keyboardHintId}
              className="text-[10px] text-muted-foreground/30"
            >
              {keyboardHint}
            </span>
            <div className="flex items-center gap-3">
              {hasMultipleQuestions && (
                <span className="text-xs text-muted-foreground/50">
                  {currentQuestionIndex + 1} of {totalQuestions}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                data-ask-user-question-control="submit"
                onClick={handleNextOrSubmit}
                disabled={!isCurrentValid || isSubmitting}
                className="text-muted-foreground hover:text-foreground"
              >
                {isSubmitting ? (
                  <>Submitting...</>
                ) : isLastQuestion ? (
                  <>
                    Submit
                    <Send className="ml-2 h-3.5 w-3.5" />
                  </>
                ) : (
                  <>
                    Next
                    <ChevronRight className="ml-1 h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
