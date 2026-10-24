"use client"

import { useSettledFetcherResult } from "@/hooks/use-settled-fetcher-result";

import { useCallback, useEffect, useState } from "react"
import { Cable, CircleHelp, Clock, LayoutGrid, MessagesSquare, Plus, Sparkles } from "lucide-react"
import { Link, useFetcher, useLocation, useNavigate, useRevalidator, useRouteLoaderData } from "react-router"
import type { ChatGroupThreadSummary, ChatGroupView } from "@/types"

import { OpenAiSignInDialog } from "@/components/billing/openai-sign-in-dialog"
import { PlanUpgradeDialog } from "@/components/billing/plan-upgrade-dialog"
import {
  TopUpDialog,
  type TopUpDialogPack,
} from "@/components/billing/top-up-dialog"
import {
  getCloseGroupRedirect,
  getGroupLandingHref,
  useChatGroups,
} from "@/hooks/use-chat-groups"
import { useAuthData } from "@/hooks/use-auth-data"
import { GetHelpDialog } from "@/components/get-help-dialog"
import { ByokKeyDialog } from "@/components/onboarding/byok-key-dialog"
import { ChatGroupsList } from "@/components/sidebar/chat-groups-list"
import { NavUser } from "@/components/sidebar/nav-user"
import { WorkspaceSwitcher } from "@/components/sidebar/workspace-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import type { OnboardingByokProvider } from "@/lib/byok-providers"
import {
  EMPTY_BYOK_CREDENTIAL,
  resolveOrgScopedByokApiKey,
  type OrgScopedByokCredential,
} from "@/lib/byok-credential-state"
import { saveChatGroupPinned } from "@/lib/chat-group-pin.client"
import {
  saveChatGroupRename,
  type ChatGroupRenameInput,
} from "@/lib/chat-group-rename.client"
import { useBillingDialogPresence } from "@/hooks/use-billing-dialog-presence"

type BillingAccessMode =
  | "enterprise"
  | "subscription"
  | "byok"
  | "credits"
  | "selfhost"
  | "camel_free"

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  billingAccessMode?: BillingAccessMode | null
  isOrgAdmin?: boolean
  orgId?: string | null
}

interface CreditPacksResourceData {
  packs: TopUpDialogPack[]
  canTopUp: boolean
  unavailableReason?: string | null
}

interface AppSidebarLoaderData {
  pinnedGroupCountHint?: number
}

export function resolveChatGroupSidebarSections(
  groups: ChatGroupView[],
  isLoading: boolean,
  pinnedGroupCountHint: number,
) {
  const pinnedGroups = groups
    .filter((group) => group.pinned_at !== null)
    .sort((left, right) => (left.pinned_at ?? 0) - (right.pinned_at ?? 0))
  const recentGroups = groups.filter((group) => group.pinned_at === null)
  const pinnedSkeletonCount = Math.min(
    Math.max(0, pinnedGroupCountHint),
    20,
  )
  return {
    pinnedGroups,
    recentGroups,
    pinnedSkeletonCount,
    showPinnedSection:
      pinnedGroups.length > 0 ||
      (isLoading && groups.length === 0 && pinnedSkeletonCount > 0),
    showRecentsSection:
      recentGroups.length > 0 || pinnedGroups.length === 0,
  }
}

// Collapsed-rail section separator. A constant-height in-flow hairline: it
// occupies the same 1px in both sidebar states, so toggling the rail never
// shifts content — only opacity animates. Sitting between the two sections'
// 4px paddings, it gets equal space above and below. Fixed w-8 (the collapsed
// icon-column width) so it never paints wide mid-collapse. shrink-0 is
// load-bearing: SidebarContent is a flex column, and when it overflows, a
// shrinkable empty div's min-content height is 0 — the line would vanish.
// Expanded mode still delineates sections with the group headers.
function CollapsedRailSeparator() {
  return (
    <div
      aria-hidden
      className="ml-2 h-px w-8 shrink-0 bg-sidebar-border opacity-0 transition-opacity duration-150 ease-linear group-data-[collapsible=icon]:opacity-100 group-data-[collapsible=icon]:delay-100 motion-reduce:transition-none"
    />
  );
}

export function AppSidebar({
  billingAccessMode = null,
  isOrgAdmin = false,
  orgId = null,
  ...props
}: AppSidebarProps) {
  const [helpOpen, setHelpOpen] = useState(false)
  const [planUpgradeOpen, setPlanUpgradeOpen] = useState(false)
  const [topUpOpen, setTopUpOpen] = useState(false)
  const [byokDialogOpen, setByokDialogOpen] = useState(false)
  const [openAiSignInOpen, setOpenAiSignInOpen] = useState(false)
  const [selectedProvider, setSelectedProvider] =
    useState<OnboardingByokProvider>("openrouter")
  const [providerCredential, setProviderCredential] =
    useState<OrgScopedByokCredential>(EMPTY_BYOK_CREDENTIAL)
  const providerApiKey = resolveOrgScopedByokApiKey(providerCredential, orgId)
  const [awsRegion, setAwsRegion] = useState("us-east-1")
  const [providerError, setProviderError] = useState<string | null>(null)
  const [openHoverGroupId, setOpenHoverGroupId] = useState<string | null>(null)
  const [openMenuGroupId, setOpenMenuGroupId] = useState<string | null>(null)
  const creditPacksFetcher = useFetcher<CreditPacksResourceData>()
  const providerFetcher = useFetcher<{ success?: boolean; error?: string }>()
  const location = useLocation()
  const { pathname } = location
  const navigate = useNavigate()
  const revalidator = useRevalidator()
  const { setSidebarBillingDialogOpen } = useBillingDialogPresence()
  const { currentWorkspace } = useAuthData()
  const { groups, activeGroupId, isLoading } = useChatGroups()
  const appLoaderData = useRouteLoaderData("routes/_app") as
    | AppSidebarLoaderData
    | undefined
  const {
    pinnedGroups,
    recentGroups,
    pinnedSkeletonCount,
    showPinnedSection,
    showRecentsSection,
  } = resolveChatGroupSidebarSections(
    groups,
    isLoading,
    appLoaderData?.pinnedGroupCountHint ?? 0,
  )
  const isHistory = pathname === "/history"
  const isConnections = pathname === "/connections"
  const isApps = pathname === "/apps"
  const isAutomations = pathname === "/automations"
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null
  const currentPath = `${location.pathname}${location.search}${location.hash}`

  const closeBillingDialogs = useCallback(() => {
    setPlanUpgradeOpen(false)
    setTopUpOpen(false)
    setByokDialogOpen(false)
    setOpenAiSignInOpen(false)
    setSidebarBillingDialogOpen(false)
    setProviderCredential(EMPTY_BYOK_CREDENTIAL)
    setProviderError(null)
  }, [setSidebarBillingDialogOpen])

  const openPlanUpgrade = useCallback(() => {
    closeBillingDialogs()
    setPlanUpgradeOpen(true)
    setSidebarBillingDialogOpen(true)
  }, [closeBillingDialogs, setSidebarBillingDialogOpen])

  const openTopUp = useCallback(() => {
    closeBillingDialogs()
    setTopUpOpen(true)
    setSidebarBillingDialogOpen(true)
    if (!creditPacksFetcher.data && creditPacksFetcher.state === "idle") {
      creditPacksFetcher.load("/api/billing/credit-packs")
    }
  }, [closeBillingDialogs, creditPacksFetcher, setSidebarBillingDialogOpen])

  const openByok = useCallback(() => {
    closeBillingDialogs()
    setProviderError(null)
    setByokDialogOpen(true)
    setSidebarBillingDialogOpen(true)
  }, [closeBillingDialogs, setSidebarBillingDialogOpen])

  const openOpenAiSignIn = useCallback(() => {
    closeBillingDialogs()
    setOpenAiSignInOpen(true)
    setSidebarBillingDialogOpen(true)
  }, [closeBillingDialogs, setSidebarBillingDialogOpen])

  useEffect(
    () => () => {
      setSidebarBillingDialogOpen(false)
    },
    [setSidebarBillingDialogOpen],
  )

  useEffect(() => {
    closeBillingDialogs()
  }, [closeBillingDialogs, orgId])

  useSettledFetcherResult(providerFetcher.state, providerFetcher.data, (result) => {
    if (result.error) {
      setProviderError(result.error)
      return
    }
    if (result.success) {
      closeBillingDialogs()
      revalidator.revalidate()
    }
  })

  const saveByokProvider = useCallback(() => {
    if (!orgId) {
      setProviderError("We couldn't identify the current organization.")
      return
    }
    if (!providerApiKey.trim()) {
      setProviderError("Enter an API key to continue.")
      return
    }
    const payload: Record<string, string> = {
      intent: "setProvider",
      provider: selectedProvider,
    }
    if (selectedProvider === "bedrock") {
      payload.bearer_token = providerApiKey.trim()
      payload.aws_region = awsRegion
    } else {
      payload.api_key = providerApiKey.trim()
    }
    setProviderError(null)
    providerFetcher.submit(payload, {
      method: "POST",
      action: `/api/orgs/${orgId}/llm-provider`,
      encType: "application/json",
    })
  }, [awsRegion, orgId, providerApiKey, providerFetcher, selectedProvider])

  const handleCloseGroup = async (groupId: string) => {
    const redirect = getCloseGroupRedirect(groups, activeGroupId, groupId)
    if (redirect) {
      navigate(redirect, { replace: true })
    }
    await fetch(`/api/chat-groups/${encodeURIComponent(groupId)}`, {
      method: "DELETE",
    })
    revalidator.revalidate()
  }

  const handleTogglePinGroup = async (group: ChatGroupView) => {
    const workspaceId = currentWorkspace?.id
    if (!workspaceId) return
    await saveChatGroupPinned({
      groupId: group.id,
      workspaceId,
      pinned: group.pinned_at === null,
      currentPinnedAt: group.pinned_at,
      currentPinnedCount: groups.filter(
        (entry) => entry.pinned_at !== null,
      ).length,
      revalidate: () => revalidator.revalidate(),
    })
  }

  const handleRenameGroup = async (
    groupId: string,
    next: ChatGroupRenameInput,
  ) => {
    await saveChatGroupRename(groupId, next, {
      revalidate: () => revalidator.revalidate(),
    })
  }

  const handleMoveThreadToGroup = async (threadId: string, targetGroupId: string) => {
    if (activeGroup?.id === targetGroupId) return
    const response = await fetch("/api/chat-groups/move-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, targetGroupId }),
    })
    if (response.ok) {
      revalidator.revalidate()
      navigate(`/chat/${threadId}`)
    }
  }

  const handleSelectThreadFromHover = async (
    groupId: string,
    thread: ChatGroupThreadSummary,
  ) => {
    const href = `/chat/${encodeURIComponent(thread.id)}?group=${encodeURIComponent(groupId)}`
    if (thread.membership === "open") {
      navigate(href)
      return
    }

    try {
      const response = await fetch(
        `/api/chat-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(thread.id)}/reopen`,
        { method: "POST" },
      )
      if (!response.ok) {
        console.error("Failed to reopen chat group member", await response.text())
        return
      }
    } catch (error) {
      console.error("Failed to reopen chat group member", error)
      return
    }

    revalidator.revalidate()
    navigate(href)
  }

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="[--safe-area-padding-left:0.5rem] [--safe-area-padding-right:0.5rem] pl-safe pr-safe">
        <WorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent className="pl-safe pr-safe">
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="New chat"
                className="font-medium"
                onClick={() => navigate("/chat")}
              >
                <Plus />
                <span>New chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <CollapsedRailSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Chat History" isActive={isHistory}>
                <Link to="/history">
                  <MessagesSquare />
                  <span>Chat History</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Connections" isActive={isConnections}>
                <Link to="/connections">
                  <Cable />
                  <span>Connections</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Apps" isActive={isApps}>
                <Link to="/apps">
                  <LayoutGrid />
                  <span>Apps</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Automations" isActive={isAutomations}>
                <Link to="/automations">
                  <Clock />
                  <span>Automations</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {(groups.length > 0 || isLoading) && <CollapsedRailSeparator />}
        {showPinnedSection ? (
          <>
            <SidebarGroup>
              <SidebarGroupLabel>Pinned</SidebarGroupLabel>
              <ChatGroupsList
                groups={pinnedGroups}
                activeGroupId={activeGroupId}
                isLoading={isLoading}
                skeletonCount={pinnedSkeletonCount}
                emptyState={null}
                onSelectGroup={(groupId) => {
                  const group = groups.find((entry) => entry.id === groupId)
                  navigate(group ? getGroupLandingHref(group) : "/chat")
                }}
                onCloseGroup={handleCloseGroup}
                onTogglePinGroup={handleTogglePinGroup}
                onRenameGroup={handleRenameGroup}
                openHoverGroupId={openHoverGroupId}
                onOpenHoverGroupIdChange={setOpenHoverGroupId}
                openMenuGroupId={openMenuGroupId}
                onOpenMenuGroupIdChange={setOpenMenuGroupId}
                onSelectThread={handleSelectThreadFromHover}
                onMoveThreadToGroup={handleMoveThreadToGroup}
              />
            </SidebarGroup>
            {showRecentsSection ? <CollapsedRailSeparator /> : null}
          </>
        ) : null}
        {showRecentsSection ? (
          <SidebarGroup>
            <SidebarGroupLabel>Chat Groups</SidebarGroupLabel>
            <ChatGroupsList
              groups={recentGroups}
              activeGroupId={activeGroupId}
              isLoading={isLoading}
              onSelectGroup={(groupId) => {
                const group = groups.find((entry) => entry.id === groupId)
                navigate(group ? getGroupLandingHref(group) : "/chat")
              }}
              onCloseGroup={handleCloseGroup}
              onTogglePinGroup={handleTogglePinGroup}
              onRenameGroup={handleRenameGroup}
              openHoverGroupId={openHoverGroupId}
              onOpenHoverGroupIdChange={setOpenHoverGroupId}
              openMenuGroupId={openMenuGroupId}
              onOpenMenuGroupIdChange={setOpenMenuGroupId}
              onSelectThread={handleSelectThreadFromHover}
              onMoveThreadToGroup={handleMoveThreadToGroup}
            />
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      <SidebarFooter className="[--safe-area-padding-left:0.5rem] [--safe-area-padding-right:0.5rem] [--safe-area-padding-bottom:0.5rem] pl-safe pr-safe pb-safe">
        <SidebarMenu>
          {billingAccessMode === "camel_free" && isOrgAdmin ? (
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Upgrade" onClick={openPlanUpgrade}>
                <Sparkles />
                <span>Upgrade</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Get Help"
              onClick={() => setHelpOpen(true)}
            >
              <CircleHelp />
              <span>Get Help</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <NavUser />
      </SidebarFooter>
      <GetHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <PlanUpgradeDialog
        open={planUpgradeOpen}
        onOpenChange={(open) => {
          if (!open) closeBillingDialogs()
        }}
        onTopUp={openTopUp}
        onAddKey={openByok}
        onOpenAiSignIn={openOpenAiSignIn}
      />
      <TopUpDialog
        open={topUpOpen}
        onOpenChange={(open) => {
          if (!open) closeBillingDialogs()
        }}
        packs={creditPacksFetcher.data?.packs ?? []}
        action="/api/billing/credit-packs"
        returnTo={currentPath}
        loading={
          topUpOpen && !creditPacksFetcher.data
            ? true
            : creditPacksFetcher.state !== "idle"
        }
        canTopUp={creditPacksFetcher.data?.canTopUp ?? isOrgAdmin}
        unavailableReason={creditPacksFetcher.data?.unavailableReason ?? null}
      />
      <ByokKeyDialog
        open={byokDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeBillingDialogs()
          }
        }}
        selectedProvider={selectedProvider}
        onProviderChange={(provider) => {
          setSelectedProvider(provider)
          setProviderError(null)
        }}
        apiKey={providerApiKey}
        onApiKeyChange={(key) => {
          setProviderCredential({ orgId, apiKey: key })
          setProviderError(null)
        }}
        awsRegion={awsRegion}
        onAwsRegionChange={(region) => {
          setAwsRegion(region)
          setProviderError(null)
        }}
        onSubmit={saveByokProvider}
        isSubmitting={providerFetcher.state !== "idle"}
        errorMessage={providerError}
      />
      {orgId ? (
        <OpenAiSignInDialog
          open={openAiSignInOpen}
          onOpenChange={(open) => {
            if (!open) closeBillingDialogs()
          }}
          orgId={orgId}
          onSuccess={() => revalidator.revalidate()}
        />
      ) : null}
      <SidebarRail />
    </Sidebar>
  )
}
