import { useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useOutletContext,
} from "react-router";
import type { Route } from "./+types/_onboarding.welcome";
import { getAuthEnv, requireSession } from "@/lib/auth.server";
import { getOrgOnboardingWelcomeContext } from "@/lib/auth-do";
import { getEnv } from "@/lib/cloudflare.server";
import { OnboardingLayout } from "@/components/onboarding/onboarding-layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { OnboardingRouteContext } from "./_onboarding";

interface TeamContext {
  memberCount: number;
  appCount: number;
  integrations: string[];
}

interface WelcomeLoaderData {
  orgName: string;
  teamContext: TeamContext;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sessionContext = await requireSession(request, context);
  const url = new URL(request.url);
  const teamMode = url.searchParams.get("team") === "1";
  const orgId = sessionContext.session.org_id;
  const workspaceId = sessionContext.session.workspace_id;

  if (teamMode) {
    const env = getEnv(context);
    const welcomeContext = await getOrgOnboardingWelcomeContext(
      getAuthEnv(env),
      orgId,
      workspaceId ?? null,
    );

    return {
      orgName: welcomeContext.info?.name ?? "your team",
      teamContext: {
        memberCount: welcomeContext.memberCount,
        appCount: welcomeContext.appCount,
        integrations: welcomeContext.integrations,
      },
    } satisfies WelcomeLoaderData;
  }

  return {
    orgName: "camelAI",
    teamContext: {
      memberCount: 0,
      appCount: 0,
      integrations: [],
    },
  } satisfies WelcomeLoaderData;
}

export function meta() {
  return [
    { title: "Welcome - camelAI" },
    { name: "description", content: "Welcome to camelAI onboarding" },
  ];
}

function formatTeamSummary(teamContext: TeamContext): string {
  const parts = [
    `${teamContext.memberCount} team ${teamContext.memberCount === 1 ? "member" : "members"}`,
  ];

  if (teamContext.appCount > 0) {
    parts.push(`${teamContext.appCount} apps deployed`);
  }

  if (teamContext.integrations.length > 0) {
    parts.push(`Connected to ${teamContext.integrations.join(", ")}`);
  }

  return parts.join("  •  ");
}

export default function OnboardingWelcomeRoute() {
  const context = useOutletContext<OnboardingRouteContext>();
  const [error, setError] = useState<string | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);
  const completionStartedRef = useRef(false);
  const verificationFetcher = useFetcher<{
    success?: boolean;
    error?: string;
  }>();
  const { orgName, teamContext } =
    useLoaderData<typeof loader>() as WelcomeLoaderData;

  const isTeamWelcome = context.teamMode;
  const isTeamMemberAlreadyOnboarded =
    isTeamWelcome && context.onboardingComplete;
  const emailVerificationRequired =
    context.emailVerificationRequired && !context.emailVerified;
  const verificationSent =
    verificationFetcher.state === "idle" &&
    verificationFetcher.data?.success === true;
  const verificationError =
    verificationFetcher.state === "idle"
      ? verificationFetcher.data?.error
      : undefined;

  return (
    <OnboardingLayout>
      <div className="space-y-4">
        <div className="space-y-3 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            {isTeamWelcome ? `Welcome to ${orgName}` : "Welcome to camelAI"}
          </h1>
          {!isTeamWelcome ? (
            <>
              <p className="text-balance text-muted-foreground">
                camelAI is your AI software engineer. Your agents have a permanent
                computer here, so they can build, deploy, and maintain
                applications for you.
              </p>
              {emailVerificationRequired ? (
                <p className="text-muted-foreground">
                  Verify your email to get started.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-muted-foreground">
                You&apos;re joining a team that&apos;s already building.
              </p>
              <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
                {formatTeamSummary(teamContext)}
              </div>
              <p className="text-muted-foreground">
                Let&apos;s get you set up.
              </p>
            </>
          )}
        </div>

        {emailVerificationRequired ? (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-left">
            <p className="text-sm font-medium">Verify your email</p>
            <p className="text-sm text-muted-foreground">
              We sent a verification link to {context.userEmail}. You&apos;ll
              need to confirm it before continuing.
            </p>
            {verificationSent ? (
              <p className="text-sm text-muted-foreground">
                Verification email sent.
              </p>
            ) : null}
            {verificationError ? (
              <Alert variant="destructive">
                <AlertDescription>{verificationError}</AlertDescription>
              </Alert>
            ) : null}
            <verificationFetcher.Form
              method="post"
              action="/api/auth/verify-email/send"
            >
              <Button
                type="submit"
                variant="outline"
                disabled={verificationFetcher.state !== "idle"}
              >
                {verificationFetcher.state !== "idle"
                  ? "Sending..."
                  : verificationSent
                    ? "Resend verification email"
                    : "Send verification email"}
              </Button>
            </verificationFetcher.Form>
          </div>
        ) : null}

        {error ? (
          <Alert variant="destructive" className="text-left">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex justify-center pt-2">
          <Button
            type="button"
            size="lg"
            disabled={emailVerificationRequired || isCompleting}
            onClick={async () => {
              if (isTeamMemberAlreadyOnboarded) {
                context.skipToChat();
                return;
              }
              if (completionStartedRef.current) {
                return;
              }
              completionStartedRef.current = true;
              setIsCompleting(true);
              setError(null);
              try {
                await context.completeOnboarding();
              } catch (nextError) {
                completionStartedRef.current = false;
                setIsCompleting(false);
                setError(
                  nextError instanceof Error
                    ? nextError.message
                    : "Failed to complete onboarding",
                );
              }
            }}
          >
            {isCompleting ? "Opening chat..." : "Continue to chat"}
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
