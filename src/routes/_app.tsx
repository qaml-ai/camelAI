import {
  Outlet,
  redirect,
  data,
  useLoaderData,
} from "react-router";
import type { Route } from "./+types/_app";
import { canUseSuperuserAccess, requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  createSessionCookieHeader,
  getRemainingSessionCookieMaxAge,
  getCookie,
} from "@/lib/cookies.server";
import {
  PaywallTakeover,
  type PaywallTakeoverContext,
} from "@/components/billing/paywall-takeover";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ChatGroupsProvider } from "@/hooks/use-chat-groups";
import { ChatThreadSnapshotsProvider } from "@/hooks/use-chat-thread-snapshots";
import { BillingDialogPresenceProvider } from "@/hooks/use-billing-dialog-presence";
import type { AuthState } from "@/types";
import type { ChatGroupView } from "@/types";
import { StreamPurchaseTracker } from "@/components/stream-purchase-tracker";
import {
  isOrgBillingAccessReady,
  resolveOrgBillingAccess,
} from "@/lib/billing.server";
import { listGroupsForWorkspace } from "@/lib/chat-groups.server";
import { getByokProviderLabel } from "@/lib/byok-providers";
import { getEffectiveLlmProviderConfig } from "@/lib/selfhost-ai-provider";
import { isConnectionsUiOnlySearchChange } from "@/lib/connections-route-revalidation";
import {
  PINNED_GROUPS_COOKIE_NAME,
  readPinnedGroupCountHint,
} from "@/lib/pinned-groups-cookie";

const SIDEBAR_COOKIE_NAME = "sidebar_state";

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formData,
  defaultShouldRevalidate,
}: {
  currentUrl?: URL;
  nextUrl?: URL;
  formData?: FormData;
  defaultShouldRevalidate: boolean;
}) {
  if (formData?.get("intent") === "createThreadAndStart") {
    return false;
  }

  if (
    !formData &&
    currentUrl &&
    nextUrl &&
    isConnectionsUiOnlySearchChange(currentUrl, nextUrl)
  ) {
    return false;
  }

  return defaultShouldRevalidate;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  // Auth check - redirects to /login if not authenticated
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const url = new URL(request.url);

  if (!authContext.onboarding?.completed_at) {
    throw redirect("/onboarding");
  }
  if (
    authContext.emailVerification.required &&
    !authContext.emailVerification.verified
  ) {
    throw redirect("/onboarding");
  }

  // Get sidebar state from cookies
  const sidebarValue = getCookie(request, SIDEBAR_COOKIE_NAME);
  let defaultSidebarOpen = true;
  if (sidebarValue === "false") {
    defaultSidebarOpen = false;
  }
  const currentWorkspaceId = authContext.currentWorkspace?.id ?? null;
  const pinnedGroupCountHint = currentWorkspaceId
    ? readPinnedGroupCountHint(
        getCookie(request, PINNED_GROUPS_COOKIE_NAME) ?? undefined,
        currentWorkspaceId,
      )
    : 0;

  const embedMode =
    /^\/chat\/[^/]+$/.test(url.pathname) &&
    url.searchParams.get("adminReadonly") === "1" &&
    url.searchParams.get("embed") === "1" &&
    canUseSuperuserAccess(authContext);

  if (embedMode) {
    const authState: AuthState = {
      user: authContext.user,
      currentOrg: authContext.currentOrg,
      currentWorkspace: authContext.currentWorkspace,
      orgs: authContext.orgs,
      onboarding: authContext.onboarding,
      workspaces: authContext.workspaces,
      allWorkspaces: authContext.allWorkspaces,
      orgWorkspaceCount: authContext.orgWorkspaceCount,
      loading: false,
      error: null,
    };
    const responseData = {
      authState,
      defaultSidebarOpen,
      pinnedGroupCountHint,
      showLegacyBanner: Promise.resolve(false),
      chatGroups: Promise.resolve([] as ChatGroupView[]),
      billingAccessReady: true,
      appRouteAccessible: true,
      billingAccessMode: null,
      isOrgAdmin: false,
      paywallContext: null,
      embedMode: true,
    };

    if (authContext.resignedSessionCookie) {
      return data(responseData, {
        headers: {
          "Set-Cookie": createSessionCookieHeader(
            authContext.resignedSessionCookie,
            request,
            getRemainingSessionCookieMaxAge(authContext.session),
          ),
        },
      });
    }

    return responseData;
  }

  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    authContext.currentOrgLlmProviderConfig,
  );
  const currentOrg = authContext.currentOrg;
  const billingAccess = resolveOrgBillingAccess({
    env,
    org: currentOrg,
    llmProviderConfig: effectiveLlmProviderConfig,
    pathname: url.pathname,
  });
  const billingAccessReady = isOrgBillingAccessReady(billingAccess);
  const appRouteAccessible =
    billingAccessReady || billingAccess.setupRouteAccessible;
  const billingAccessMode =
    billingAccess.kind === "ready" ? billingAccess.mode : null;
  const isOrgAdmin = authContext.orgs.some(
    (membership) =>
      membership.org_id === currentOrg.id &&
      (membership.role === "owner" || membership.role === "admin"),
  );
  const paywallContext: PaywallTakeoverContext | null = billingAccessReady
    ? null
    : {
        currentOrgName: currentOrg.name,
        multiOrg: authContext.orgs.length > 1,
        byokProviderLabel: getByokProviderLabel(effectiveLlmProviderConfig?.provider),
      };

  // Convert auth context to AuthState for the provider
  const authState: AuthState = {
    user: authContext.user,
    currentOrg,
    currentWorkspace: authContext.currentWorkspace,
    orgs: authContext.orgs,
    onboarding: authContext.onboarding,
    workspaces: authContext.workspaces,
    allWorkspaces: authContext.allWorkspaces,
    orgWorkspaceCount: authContext.orgWorkspaceCount,
    loading: false,
    error: null,
  };

  const actingUserId =
    authContext.user?.id ?? authContext.session?.user_id ?? null;
  const currentChatGroupsPromise: Promise<ChatGroupView[]> = currentWorkspaceId && actingUserId
    ? listGroupsForWorkspace(context, {
        userId: actingUserId,
        orgId: currentOrg.id,
        workspaceId: currentWorkspaceId,
      }).catch((error) => {
        console.error("Failed to load chat groups:", error);
        throw error;
      })
    : Promise.resolve([]);
  const responseData = {
    authState,
    defaultSidebarOpen,
    pinnedGroupCountHint,
    chatGroups: currentChatGroupsPromise,
    billingAccessReady,
    appRouteAccessible,
    billingAccessMode,
    isOrgAdmin,
    paywallContext,
    embedMode: false,
  };

  // Re-sign session cookie if workspace fell back (e.g. workspace removed/access revoked)
  if (authContext.resignedSessionCookie) {
    return data(responseData, {
      headers: {
        "Set-Cookie": createSessionCookieHeader(
          authContext.resignedSessionCookie,
          request,
          getRemainingSessionCookieMaxAge(authContext.session),
        ),
      },
    });
  }

  return responseData;
}

export default function AppLayout() {
  const {
    authState,
    defaultSidebarOpen,
    appRouteAccessible,
    billingAccessMode,
    isOrgAdmin,
    paywallContext,
    embedMode,
  } =
    useLoaderData<typeof loader>();
  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <ChatGroupsProvider disableLiveStatus={embedMode}>
        <BillingDialogPresenceProvider>
          <ChatThreadSnapshotsProvider>
            <StreamPurchaseTracker />
            {embedMode ? null : (
              <AppSidebar
                billingAccessMode={billingAccessMode}
                isOrgAdmin={isOrgAdmin}
                orgId={authState.currentOrg?.id ?? null}
              />
            )}
            <SidebarInset className="h-svh overflow-hidden flex flex-col">
              {embedMode || appRouteAccessible ? (
                <Outlet />
              ) : paywallContext ? (
                <PaywallTakeover paywallContext={paywallContext} />
              ) : null}
            </SidebarInset>
          </ChatThreadSnapshotsProvider>
        </BillingDialogPresenceProvider>
      </ChatGroupsProvider>
    </SidebarProvider>
  );
}
