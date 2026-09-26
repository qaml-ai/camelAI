import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import { isLlmModelCoveredByOpenAiSubscription } from "@/lib/llm-provider-config";
import type { LlmModel } from "@/types";

export type UnlockPremiumModalVariant =
  | "unlock"
  | "payg_credits_exhausted"
  | "included_credits_exhausted"
  | "trial_credits_exhausted";

export interface UnlockPremiumModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerModel: LlmModel | null;
  isOrgAdmin: boolean;
  orgId: string;
  onSeePlans: () => void;
  onTopUp: () => void;
  onAddKey: () => void;
  onOpenAiSignIn: () => void;
  variant?: UnlockPremiumModalVariant;
}

function AdminAction({
  isOrgAdmin,
  label,
  onClick,
  recommended = false,
}: {
  isOrgAdmin: boolean;
  label: string;
  onClick: () => void;
  recommended?: boolean;
}) {
  return isOrgAdmin ? (
    <Button
      type="button"
      variant={recommended ? "default" : "outline"}
      size="sm"
      onClick={onClick}
    >
      {label}
    </Button>
  ) : (
    <span className="shrink-0 pt-1 text-xs text-muted-foreground">
      Ask an org admin
    </span>
  );
}

export function UnlockPremiumModal({
  open,
  onOpenChange,
  triggerModel,
  isOrgAdmin,
  orgId,
  onSeePlans,
  onTopUp,
  onAddKey,
  onOpenAiSignIn,
  variant = "unlock",
}: UnlockPremiumModalProps) {
  const isOpenAiSubscriptionTrigger = Boolean(
    triggerModel && isLlmModelCoveredByOpenAiSubscription(triggerModel),
  );
  const triggerLabel = triggerModel
    ? (MODEL_CATALOG[triggerModel]?.label ?? triggerModel)
    : "Claude and GPT";
  const dialogCopy = {
    unlock: {
      title: "Unlock premium models",
      description: (
        <>
          camelCode is always included. Premium models like {triggerLabel} need
          one of these:
        </>
      ),
    },
    payg_credits_exhausted: {
      title: "Out of credits",
      description: (
        <>
          You&apos;ve used all your camelAI credits. Add more to keep using
          premium models like {triggerLabel}.
        </>
      ),
    },
    included_credits_exhausted: {
      title: "Monthly credits used",
      description: (
        <>
          You&apos;ve used this month&apos;s included credits. They reset when
          your plan renews. Add credits to keep using {triggerLabel} now.
        </>
      ),
    },
    trial_credits_exhausted: {
      title: "Trial credits used",
      description: (
        <>
          You&apos;ve used your trial credits. Subscribe or add credits to keep
          using premium models like {triggerLabel}.
        </>
      ),
    },
  }[variant];
  const subscribeMethod = {
    testId: "unlock-method-subscribe",
    title:
      variant === "included_credits_exhausted" ? "Upgrade plan" : "Subscribe",
    meta:
      variant === "included_credits_exhausted" ? null : "from $10/mo",
    description:
      variant === "included_credits_exhausted"
        ? "Higher plans include more monthly credits."
        : "Monthly model credits matching your plan price, plus more apps, automations, and storage.",
    label: "See plans",
    onClick: onSeePlans,
  };
  const creditsMethod = {
    testId: "unlock-method-credits",
    title: "Buy credits",
    meta: null,
    description:
      variant === "included_credits_exhausted"
        ? "Extra credits on top of your plan. Available immediately."
        : "Prepaid, pay as you go. No subscription.",
    label: "Top up",
    onClick: onTopUp,
  };
  const creditsRecommended =
    variant === "payg_credits_exhausted" ||
    variant === "included_credits_exhausted";
  const recommendedMethod = creditsRecommended
    ? creditsMethod
    : subscribeMethod;
  const otherMethod = creditsRecommended ? subscribeMethod : creditsMethod;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{dialogCopy.title}</DialogTitle>
          <DialogDescription>
            {dialogCopy.description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6" data-org-id={orgId}>
          <div className="space-y-4">
            <span className="inline-block rounded-none bg-primary/10 px-2 py-1 text-xs font-medium uppercase tracking-wide text-primary">
              Pay through camelAI
            </span>
            <div className="relative">
              <Badge
                variant="default"
                className="absolute top-0 left-4 z-10 -translate-y-1/2"
              >
                Recommended
              </Badge>
              <Card
                className="py-0 ring-2 ring-primary"
                data-testid={recommendedMethod.testId}
              >
                <CardContent className="flex items-start gap-3 p-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">
                        {recommendedMethod.title}
                      </p>
                      {recommendedMethod.meta ? (
                        <span className="text-xs text-muted-foreground">
                          {recommendedMethod.meta}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {recommendedMethod.description}
                    </p>
                  </div>
                  <AdminAction
                    isOrgAdmin={isOrgAdmin}
                    label={recommendedMethod.label}
                    onClick={recommendedMethod.onClick}
                    recommended
                  />
                </CardContent>
              </Card>
            </div>

            <div
              className="flex items-start justify-between gap-3 px-1"
              data-testid={otherMethod.testId}
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{otherMethod.title}</p>
                  {otherMethod.meta ? (
                    <span className="text-xs text-muted-foreground">
                      {otherMethod.meta}
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  {otherMethod.description}
                </p>
              </div>
              <AdminAction
                isOrgAdmin={isOrgAdmin}
                label={otherMethod.label}
                onClick={otherMethod.onClick}
              />
            </div>
          </div>

          <div className="space-y-3 pt-1">
            <span className="inline-block rounded-none bg-primary/10 px-2 py-1 text-xs font-medium uppercase tracking-wide text-primary">
              Use what you already pay for
            </span>
            <div
              className="flex items-start justify-between gap-3 px-1"
              data-testid="unlock-method-openai"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">Sign in with OpenAI</p>
                  {isOpenAiSubscriptionTrigger ? (
                    <Badge variant="secondary">Best value for GPT models</Badge>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  Use your ChatGPT plan&apos;s allowance — no extra cost.
                </p>
              </div>
              <AdminAction
                isOrgAdmin={isOrgAdmin}
                label="Sign in"
                onClick={onOpenAiSignIn}
              />
            </div>

            <Separator />

            <div
              className="flex items-start justify-between gap-3 px-1"
              data-testid="unlock-method-key"
            >
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">Use your own API key</p>
                <p className="text-sm text-muted-foreground">
                  Anthropic, OpenAI, OpenRouter, Requesty, Bedrock, or a custom endpoint.
                </p>
              </div>
              <AdminAction
                isOrgAdmin={isOrgAdmin}
                label="Add key"
                onClick={onAddKey}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
