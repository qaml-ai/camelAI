import {
  ArrowRight,
  CircleAlert,
  CreditCard,
  KeyRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { type ChatApiErrorPresentation } from "@/lib/chat-api-errors";
import { cn } from "@/lib/utils";

export function ChatApiErrorNotice({
  presentation,
  onDismiss,
  className,
}: {
  presentation: ChatApiErrorPresentation;
  onDismiss?: () => void;
  className?: string;
}) {
  if (
    presentation.kind === "billing_action" ||
    presentation.kind === "provider_auth_action"
  ) {
    const ActionIcon =
      presentation.kind === "billing_action" ? CreditCard : KeyRound;
    return (
      <Alert className={cn("px-3 py-2 text-sm", className)}>
        <ActionIcon className="h-4 w-4 text-muted-foreground" />
        <AlertTitle className="text-sm">{presentation.title}</AlertTitle>
        <AlertDescription className="space-y-2 text-sm text-muted-foreground">
          <p>{presentation.message}</p>
          <Button asChild size="sm" className="h-7">
            <a href={presentation.actionHref}>{presentation.actionLabel}</a>
          </Button>
        </AlertDescription>
        {onDismiss ? (
          <AlertAction>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              aria-label="Dismiss error"
              onClick={onDismiss}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    );
  }

  return (
    <Alert className={cn("px-3 py-2 text-sm", className)}>
      <CircleAlert className="h-4 w-4 text-muted-foreground" />
      {presentation.title ? (
        <AlertTitle className="text-sm">{presentation.title}</AlertTitle>
      ) : null}
      <AlertDescription className="space-y-2 text-sm text-muted-foreground">
        <p>{presentation.message}</p>
        {presentation.actionHref ? (
          <a
            href={presentation.actionHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {presentation.actionLabel ?? "Open documentation"}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </AlertDescription>
      {onDismiss ? (
        <AlertAction>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            aria-label="Dismiss error"
            onClick={onDismiss}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
