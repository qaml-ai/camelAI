import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import {
  ChatTabBar,
  MAX_OPEN_CHAT_TABS_PER_GROUP,
  TabRightSlot,
} from "@/components/chat-tab-bar";
import { ChatGroupAvatar } from "@/components/avatar/chat-group-avatar";
import { RenameChatGroupDialog } from "@/components/avatar/rename-chat-group-dialog";
import {
  ChatGroupCollapsedIcon,
  ChatGroupIcon,
  ChatGroupRightSlot,
  ChatGroupsList,
} from "@/components/sidebar/chat-groups-list";
import { CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY } from "@/components/close-chat-group-dialog";
import { resolveChatGroupSidebarSections } from "@/components/sidebar/app-sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  applyLocalGroupPinnedPatches,
  applyLiveRunningStatuses,
  ChatGroupsProvider,
  getThreadIdsRequiringSnapshotRevalidation,
  getCloseGroupRedirect,
  getGroupLandingHref,
  hasPendingCompletionSummaries,
  mergeLiveAndLocalThreadStatuses,
  mergeThreadMetadata,
  mergeActiveChatGroup,
  LOCAL_GROUP_AVATAR_PENDING_TIMEOUT_MS,
  PENDING_GROUP_AVATAR_REVALIDATE_MAX_MS,
  reconcileLocalThreadStatusesWithSnapshot,
  reconcileGroupAvatarPatchesWithGroups,
  reconcileThreadSummaryPatchesWithGroups,
  shouldMarkActiveIdleThreadViewed,
  shouldMarkActiveUnreadThreadViewed,
  shouldRevalidateThreadStatusUpdate,
  useChatGroups,
  workspaceStatusStream,
  type WorkspaceStatusStreamOptions,
} from "@/hooks/use-chat-groups";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { ChatGroup, ChatGroupThreadSummary, ChatGroupView } from "@/types";

const moveGroups: ChatGroup[] = [
  {
    id: "group_1",
    org_id: "org_1",
    workspace_id: "workspace_1",
    name: "Launch",
    avatar: { color: "#4F46E5", content: "💬" },
    pinned_at: null,
    last_active_thread_id: null,
    created_at: 1,
    updated_at: 1,
  },
];

function makeThreadSummary(
  overrides: Partial<ChatGroupThreadSummary> &
    Pick<ChatGroupThreadSummary, "id" | "title">,
): ChatGroupThreadSummary {
  const updatedAt = overrides.updated_at ?? 1;
  return {
    model: "sonnet",
    updated_at: updatedAt,
    status: "idle",
    membership: "open",
    last_active_at: updatedAt,
    first_user_message: null,
    latest_user_message: null,
    latest_user_message_at: null,
    running_activity_text: null,
    running_activity_at: null,
    last_assistant_completed_at: null,
    last_assistant_summary: null,
    last_assistant_summary_status: null,
    running_started_at: null,
    ...overrides,
  };
}

const groupView: ChatGroupView = {
  ...moveGroups[0],
  open_thread_ids: ["thread_1"],
  closed_thread_ids: [],
  open_threads: [
    makeThreadSummary({
      id: "thread_1",
      title: "API plan",
      updated_at: 1,
      status: "idle",
    }),
  ],
  closed_threads: [],
  member_count: 1,
  status: "idle",
};

const multiChatGroupView: ChatGroupView = {
  ...groupView,
  id: "group_multi",
  open_thread_ids: ["thread_1", "thread_2"],
  open_threads: [
    ...groupView.open_threads,
    makeThreadSummary({
      id: "thread_2",
      title: "UI polish",
      updated_at: 2,
      status: "idle",
    }),
  ],
  member_count: 2,
};

const chatGroupListActionProps = {
  onTogglePinGroup: vi.fn(),
  onRenameGroup: vi.fn(),
  openHoverGroupId: null,
  onOpenHoverGroupIdChange: vi.fn(),
  openMenuGroupId: null,
  onOpenMenuGroupIdChange: vi.fn(),
};

function CoordinatedChatGroupsListsFixture() {
  const [openHoverGroupId, setOpenHoverGroupId] = useState<string | null>(
    "group_pinned",
  );
  const [openMenuGroupId, setOpenMenuGroupId] = useState<string | null>(null);
  const coordinatedSurfaceProps = {
    openHoverGroupId,
    onOpenHoverGroupIdChange: setOpenHoverGroupId,
    openMenuGroupId,
    onOpenMenuGroupIdChange: setOpenMenuGroupId,
  };
  const pinnedGroup = {
    ...groupView,
    id: "group_pinned",
    name: "Pinned",
    pinned_at: 123,
  };
  const recentGroup = {
    ...groupView,
    id: "group_recent",
    name: "Recent",
  };

  return (
    <SidebarProvider>
      <ChatGroupsList
        {...chatGroupListActionProps}
        {...coordinatedSurfaceProps}
        groups={[pinnedGroup]}
        activeGroupId={null}
        onSelectGroup={vi.fn()}
        onCloseGroup={vi.fn()}
      />
      <ChatGroupsList
        {...chatGroupListActionProps}
        {...coordinatedSurfaceProps}
        groups={[recentGroup]}
        activeGroupId={null}
        onSelectGroup={vi.fn()}
        onCloseGroup={vi.fn()}
      />
    </SidebarProvider>
  );
}

function groupViewWithThreadRevision(
  title: string,
  updatedAt: number,
): ChatGroupView {
  return {
    ...groupView,
    open_threads: [
      {
        ...groupView.open_threads[0],
        title,
        updated_at: updatedAt,
      },
    ],
  };
}

function ChatGroupsProviderProbe({ threadId = "thread_1" }: { threadId?: string }) {
  const { groups, isLoading } = useChatGroups();
  const thread = groups
    .flatMap((group) => [...group.open_threads, ...group.closed_threads])
    .find((candidate) => candidate.id === threadId);
  const group = groups.find((candidate) =>
    [...candidate.open_threads, ...candidate.closed_threads].some(
      (candidateThread) => candidateThread.id === threadId,
    ),
  );
  return (
    <>
      <div data-testid="thread-title">
        {thread?.title ?? ""}
      </div>
      <div data-testid="group-name">
        {group?.name ?? ""}
      </div>
      <div data-testid="group-avatar">
        {group?.avatar.content ?? ""}
      </div>
      <div data-testid="group-avatar-status">
        {group?.avatar.status ?? ""}
      </div>
      <div data-testid="group-pinned-at">
        {group?.pinned_at ?? "unpinned"}
      </div>
      <div data-testid="groups-loading">
        {isLoading ? "loading" : "loaded"}
      </div>
      <div data-testid="group-order">
        {groups.map((candidate) => candidate.id).join(",")}
      </div>
    </>
  );
}

function authLoaderState(chatGroups: ChatGroupView[] | Promise<ChatGroupView[]>) {
  return {
    authState: {
      user: { id: "user_1" },
      currentWorkspace: { id: "workspace_1" },
      currentOrg: { id: "org_1" },
      orgs: [],
    },
    chatGroups,
  };
}

// Captured before the per-test override below replaces it, so the transport's
// own reader/backoff loop stays testable.
const realStatusStreamOpen = workspaceStatusStream.open;

// The status transport in use-chat-groups is a fetch+reader SSE loop behind the
// module-level `workspaceStatusStream` seam, so swap `open` for a fake stream:
// the fake IS what the hook attaches, so `instances[0].emit(...)` drives its
// message callback directly, as the partysocket module mock used to.
class MockStatusStream {
  static instances: MockStatusStream[] = [];

  readonly url: string;
  closed = false;
  private readonly onMessage: (data: string) => void;

  constructor(options: WorkspaceStatusStreamOptions) {
    this.url = options.url;
    this.onMessage = options.onMessage;
    MockStatusStream.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(payload: unknown) {
    if (this.closed) return;
    this.onMessage(JSON.stringify(payload));
  }
}

beforeEach(() => {
  MockStatusStream.instances = [];
  workspaceStatusStream.open = (options) => new MockStatusStream(options);
  window.localStorage.removeItem(CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY);
  window.localStorage.removeItem(
    "camelai:close-chat-group-confirmation-suppressed",
  );
  document.cookie = "pinned_groups=; path=/; max-age=0";
});

function renderTabBar(overrides: Partial<React.ComponentProps<typeof ChatTabBar>> = {}) {
  const props: React.ComponentProps<typeof ChatTabBar> = {
    groupId: "group_1",
    groupName: "Launch",
    groupAvatar: moveGroups[0].avatar,
    groupPinnedAt: null,
    groupMemberCount: 1,
    openTabs: [
      { threadId: "thread_1", title: "API plan", model: "sonnet", status: "idle" },
      {
        threadId: "thread_2",
        title: "UI polish",
        model: "sonnet",
        status: "running",
      },
    ],
    closedTabs: [
      {
        threadId: "thread_3",
        title: "Archived idea",
        model: "sonnet",
        status: "idle",
      },
    ],
    activeThreadId: "thread_1",
    moveGroups,
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onRenameTab: vi.fn(),
    onReorderTabs: vi.fn(),
    onNewTab: vi.fn(),
    onReopenClosedTab: vi.fn(),
    onRenameGroup: vi.fn(),
    onTogglePin: vi.fn(),
    onCloseGroup: vi.fn(),
    onMoveTabToGroup: vi.fn(),
    ...overrides,
  };

  const result = render(
    <MemoryRouter>
      <SidebarProvider>
        <ChatTabBar {...props} />
      </SidebarProvider>
    </MemoryRouter>,
  );
  return { ...props, ...result };
}

describe("Avatar chips", () => {
  it("keeps circle avatars as the default and applies rounded chip shape on request", () => {
    const { container, rerender } = render(
      <Avatar>
        <AvatarFallback content="AB">AB</AvatarFallback>
      </Avatar>,
    );

    expect(container.querySelector('[data-slot="avatar"]')).toHaveClass(
      "rounded-full",
    );
    expect(container.querySelector('[data-slot="avatar-fallback"]')).toHaveClass(
      "rounded-full",
    );

    rerender(
      <Avatar shape="rounded">
        <AvatarFallback content="🌊">🌊</AvatarFallback>
      </Avatar>,
    );

    expect(container.querySelector('[data-slot="avatar"]')).toHaveAttribute(
      "data-shape",
      "rounded",
    );
    expect(container.querySelector('[data-slot="avatar"]')).toHaveClass(
      "rounded-[28%]",
    );
    expect(container.querySelector('[data-slot="avatar-fallback"]')).toHaveClass(
      "rounded-[28%]",
    );
  });

  it("renders a Lucide icon with no background or outline instead of a colored emoji", () => {
    const { container, rerender } = render(
      <ChatGroupAvatar
        avatar={{ color: "#e0476b", content: "bar-chart-3" }}
        fallbackName="Launch"
      />,
    );

    const fallback = container.querySelector('[data-slot="avatar-fallback"]');
    expect(container.querySelector('[data-slot="avatar"]')).toHaveAttribute(
      "data-shape",
      "rounded",
    );
    // The Lucide symbol renders through the shared sprite; the per-group
    // background color is gone.
    expect(fallback?.querySelector("svg")).not.toBeNull();
    expect(fallback?.querySelector("use")?.getAttribute("href")).toMatch(
      /#bar-chart-3$/,
    );
    expect(fallback).not.toHaveStyle({ backgroundColor: "#e0476b" });
    expect(fallback).toHaveClass("bg-transparent");
    expect(fallback).not.toHaveClass("border");

    // Legacy emoji / unknown content falls back to the default chat icon.
    rerender(
      <ChatGroupAvatar
        avatar={{ color: "not-a-color", content: "🌊" }}
        fallbackName="Launch"
      />,
    );

    expect(
      container
        .querySelector('[data-slot="avatar-fallback"] use')
        ?.getAttribute("href"),
    ).toMatch(/#messages-square$/);
  });

  it("skeletonizes the icon while an avatar is pending", () => {
    const { container } = render(
      <ChatGroupAvatar
        avatar={{ color: "#7C3AED", content: "messages-square", status: "pending" }}
        fallbackName="Launch"
      />,
    );

    const fallback = container.querySelector('[data-slot="avatar-fallback"]');
    expect(fallback).not.toBeNull();
    // No colored fill; the pending state shows a pulse placeholder, not the icon.
    expect(fallback).not.toHaveStyle({ backgroundColor: "#7C3AED" });
    expect(fallback?.querySelector("svg")).toBeNull();
    expect(fallback?.querySelector(".animate-pulse")).not.toBeNull();
  });
});

describe("ChatTabBar", () => {
  it("selects existing tabs and opens a new tab", () => {
    const onSelectTab = vi.fn();
    const onNewTab = vi.fn();
    renderTabBar({ onSelectTab, onNewTab });

    fireEvent.click(screen.getByRole("button", { name: "Open UI polish" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat in this group" }));

    expect(onSelectTab).toHaveBeenCalledWith("thread_2");
    expect(onNewTab).toHaveBeenCalledTimes(1);
  });

  it("soft-disables new tabs at ten open chats without a tooltip", async () => {
    const user = userEvent.setup();
    const onNewTab = vi.fn();
    renderTabBar({
      onNewTab,
      openTabs: Array.from({ length: MAX_OPEN_CHAT_TABS_PER_GROUP }, (_, index) => ({
        threadId: `thread_${index + 1}`,
        title: `Open chat ${index + 1}`,
        model: "sonnet",
        status: "idle",
      })),
      closedTabs: [
        {
          threadId: "thread_closed",
          title: "Archived idea",
          model: "sonnet",
          status: "idle",
        },
      ],
      activeThreadId: "thread_1",
    });

    const newChatButton = screen.getByRole("button", {
      name: "New chat in this group",
    });
    expect(newChatButton).toBeDisabled();
    expect(newChatButton).toHaveClass("disabled:pointer-events-none");

    await user.hover(newChatButton);
    expect(screen.queryByText("New chat")).not.toBeInTheDocument();
    await user.click(newChatButton);
    expect(onNewTab).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Closed chat tabs" }));
    expect(await screen.findByText("Archived idea")).toBeInTheDocument();
  });

  it("reopens closed tabs from the overflow menu", async () => {
    const onReopenClosedTab = vi.fn();
    renderTabBar({ onReopenClosedTab });

    fireEvent.click(screen.getByRole("button", { name: "Closed chat tabs" }));
    fireEvent.click(await screen.findByText("Archived idea"));

    expect(onReopenClosedTab).toHaveBeenCalledWith("thread_3");
  });

  it("loads the rename group dialog when the group option is selected", async () => {
    const user = userEvent.setup();
    renderTabBar();

    expect(screen.queryByText("Rename chat group")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Group options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename group" }));

    expect(await screen.findByText("Rename chat group")).toBeInTheDocument();
    expect(screen.getByLabelText("Search icons")).toBeInTheDocument();
  });

  it("toggles the pin menu label and handler from group state", async () => {
    const user = userEvent.setup();
    const onPin = vi.fn();
    const pinnedRender = renderTabBar({ onTogglePin: onPin });

    await user.click(screen.getByRole("button", { name: "Group options" }));
    const pinItem = await screen.findByRole("menuitem", { name: "Pin group" });
    expect(pinItem.querySelector(".lucide-pin")).not.toBeNull();
    await user.click(pinItem);
    expect(onPin).toHaveBeenCalledTimes(1);

    pinnedRender.unmount();
    const onUnpin = vi.fn();
    renderTabBar({ groupPinnedAt: 123, onTogglePin: onUnpin });
    await user.click(screen.getByRole("button", { name: "Group options" }));
    const unpinItem = await screen.findByRole("menuitem", {
      name: "Unpin group",
    });
    expect(unpinItem.querySelector(".lucide-pin-off")).not.toBeNull();
    await user.click(unpinItem);
    expect(onUnpin).toHaveBeenCalledTimes(1);
  });

  it("orders group options as pin, rename, then close", async () => {
    const user = userEvent.setup();
    renderTabBar();

    await user.click(screen.getByRole("button", { name: "Group options" }));
    await screen.findByRole("menuitem", { name: "Pin group" });

    expect(
      screen
        .getAllByRole("menuitem")
        .map((menuItem) => menuItem.textContent?.trim()),
    ).toEqual(["Pin group", "Rename group", "Close group"]);
  });

  it("confirms closing a group from the group options menu", async () => {
    const user = userEvent.setup();
    const onCloseGroup = vi.fn();
    renderTabBar({
      groupMemberCount: 2,
      onCloseGroup,
    });

    await user.click(screen.getByRole("button", { name: "Group options" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Close group" }),
    );

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/Its 2 chats will be removed/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close group" }));

    expect(onCloseGroup).toHaveBeenCalledTimes(1);
  });

  it("closes a group from the tab bar without a dialog when confirmation is suppressed", async () => {
    const user = userEvent.setup();
    const onCloseGroup = vi.fn();
    window.localStorage.setItem(
      CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      "true",
    );
    renderTabBar({ onCloseGroup });

    await user.click(screen.getByRole("button", { name: "Group options" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Close group" }),
    );

    expect(onCloseGroup).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("closes the move-to-group context submenu immediately after selecting a group", async () => {
    const onMoveTabToGroup = vi.fn();
    renderTabBar({
      onMoveTabToGroup,
      moveGroups: [
        ...moveGroups,
        {
          id: "group_2",
          org_id: "org_1",
          workspace_id: "workspace_1",
          name: "Research",
          avatar: { color: "#7C3AED", content: "🔍" },
          pinned_at: null,
          last_active_thread_id: null,
          created_at: 2,
          updated_at: 2,
        },
      ],
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open API plan" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to group" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Research" }));

    expect(onMoveTabToGroup).toHaveBeenCalledWith("thread_1", "group_2");
    expect(screen.queryByRole("menuitem", { name: "Research" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Move to group" })).not.toBeInTheDocument();
  });

  it("renders stable right slots for idle, running, and unread tabs", () => {
    const { rerender } = render(<TabRightSlot status="idle" model="sonnet" />);
    expect(screen.getByAltText("claude")).toBeInTheDocument();

    rerender(<TabRightSlot status="running" model="sonnet" />);
    expect(screen.getByLabelText("Agent is working")).toHaveAttribute("width", "16");

    rerender(<TabRightSlot status="unread" model="sonnet" />);
    expect(screen.getByLabelText("Awaiting your review")).toHaveClass("bg-amber-500");
  });

  it("allows spaces while renaming a chat tab", () => {
    renderTabBar();

    fireEvent.click(screen.getByLabelText("Rename API plan"));
    const input = screen.getByDisplayValue("API plan");
    fireEvent.keyDown(input, { key: " ", code: "Space" });
    fireEvent.change(input, { target: { value: "API plan v2" } });

    expect(input).toHaveValue("API plan v2");
  });

  it("focuses the rename input when renaming from the context menu", async () => {
    const user = userEvent.setup();
    renderTabBar();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open API plan" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename chat" }));

    const input = await screen.findByDisplayValue("API plan");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("never renders the active tab as unread", () => {
    renderTabBar({
      activeThreadId: "thread_1",
      openTabs: [
        {
          threadId: "thread_1",
          title: "API plan",
          model: "sonnet",
          status: "unread",
        },
      ],
      closedTabs: [],
    });

    const tab = screen.getByRole("button", { name: "Open API plan" });
    expect(within(tab).queryByLabelText("Awaiting your review")).not.toBeInTheDocument();
    expect(within(tab).getByAltText("claude")).toBeInTheDocument();
  });

  it("keeps hover actions overlaid without changing tab width classes", () => {
    const onCloseTab = vi.fn();
    renderTabBar({ onCloseTab });

    const tab = screen.getByRole("button", { name: "Open API plan" });
    expect(tab).toHaveClass("w-44");
    expect(screen.getByLabelText("Rename API plan")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Close API plan"));

    expect(tab).toHaveClass("w-44");
    expect(onCloseTab).toHaveBeenCalledWith("thread_1");
  });

  it("renders the indicator before the title and shows empty titles as New chat", () => {
    renderTabBar({
      openTabs: [
        { threadId: "thread_1", title: "", model: "sonnet", status: "idle" },
      ],
      closedTabs: [],
    });

    const tab = screen.getByRole("button", { name: "Open New chat" });
    const title = within(tab).getByText("New chat");
    const logo = within(tab).getByAltText("claude");

    expect(
      Boolean(tab.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(logo.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("uses a gradient fade on hover actions and the closed-tabs icon", () => {
    renderTabBar();

    const tab = screen.getByRole("button", { name: "Open API plan" });
    const fade = tab.querySelector("[aria-hidden='true'].bg-gradient-to-l");
    expect(fade).toBeTruthy();
    expect(fade).not.toHaveClass("ring-1");
    expect(document.querySelector(".lucide-circle-fading-plus")).toBeTruthy();
    expect(document.querySelector(".lucide-chevron-down")).toBeNull();
  });

  it("layers a solid hover overlay matching the tab background under a thin feather", () => {
    renderTabBar();

    const activeTab = screen.getByRole("button", { name: "Open API plan" });
    const inactiveTab = screen.getByRole("button", { name: "Open UI polish" });

    const activeOverlays = activeTab.querySelectorAll("[aria-hidden='true']");
    const inactiveOverlays = inactiveTab.querySelectorAll("[aria-hidden='true']");

    expect(activeOverlays[0]).toHaveClass("bg-background");
    expect(activeOverlays[0]).not.toHaveClass("bg-gradient-to-l");
    expect(activeOverlays[1]).toHaveClass("bg-gradient-to-l");
    expect(activeOverlays[1]).toHaveClass("from-background");
    expect(activeOverlays[1]).toHaveClass("w-2.5");

    expect(inactiveOverlays[0].className).toMatch(/bg-\[color-mix\(/);
    expect(inactiveOverlays[1]).toHaveClass("bg-gradient-to-l");
    expect(inactiveOverlays[1].className).toMatch(/from-\[color-mix\(/);
  });

  it("anchors active and inactive tab titles to the same baseline", () => {
    renderTabBar();

    const activeTab = screen.getByRole("button", { name: "Open API plan" });
    const inactiveTab = screen.getByRole("button", { name: "Open UI polish" });

    expect(activeTab).toHaveClass("pb-0.5");
    expect(inactiveTab).toHaveClass("pb-0.5");
    expect(activeTab).toHaveClass("items-center");
    expect(inactiveTab).toHaveClass("items-center");
  });

  it("renders a mobile sidebar trigger in the tab bar", () => {
    renderTabBar();

    const triggerWrapper = screen.getByRole("button", {
      name: "Toggle Sidebar",
    }).parentElement;
    expect(triggerWrapper).not.toBeNull();
    expect(triggerWrapper!).toHaveClass("md:hidden");
  });

  it("renames groups through a dialog with synced draft state", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <RenameChatGroupDialog
        open={true}
        onOpenChange={vi.fn()}
        initialName="Launch"
        initialAvatar={moveGroups[0].avatar}
        onSubmit={onSubmit}
      />,
    );

    const input = screen.getByLabelText("Name");
    expect(input).toHaveValue("Launch");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen
        .getByRole("button", { name: "Select Messages Square" })
        .querySelector("use")
        ?.getAttribute("href"),
    ).toMatch(/#messages-square$/);

    fireEvent.change(input, { target: { value: "  Planning  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Planning",
    });

    rerender(
      <RenameChatGroupDialog
        open={true}
        onOpenChange={vi.fn()}
        initialName="Follow-up"
        initialAvatar={moveGroups[0].avatar}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Follow-up");
  });

  it("preserves unsaved rename dialog edits across value-equivalent avatar rerenders", () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    const initialAvatar = { color: "#4F46E5", content: "💬" };
    const { rerender } = render(
      <RenameChatGroupDialog
        open={true}
        onOpenChange={onOpenChange}
        initialName="Launch"
        initialAvatar={initialAvatar}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Draft name" },
    });

    rerender(
      <RenameChatGroupDialog
        open={true}
        onOpenChange={onOpenChange}
        initialName="Launch"
        initialAvatar={{ ...initialAvatar }}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByLabelText("Name")).toHaveValue("Draft name");
  });
});

describe("ChatGroupsList", () => {
  it("renders the empty state", () => {
    render(
      <ChatGroupsList
        {...chatGroupListActionProps}
        groups={[]}
        activeGroupId={null}
        onSelectGroup={vi.fn()}
        onCloseGroup={vi.fn()}
      />,
    );

    expect(screen.getByText("No groups yet")).toBeInTheDocument();
  });

  it("renders skeleton rows while groups are loading", () => {
    render(
      <ChatGroupsList
        {...chatGroupListActionProps}
        groups={[]}
        activeGroupId={null}
        isLoading
        onSelectGroup={vi.fn()}
        onCloseGroup={vi.fn()}
      />,
    );

    expect(screen.queryByText("No groups yet")).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-sidebar="menu-skeleton"]')).toHaveLength(5);
  });

  it("supports section-specific skeleton counts and a suppressed empty state", () => {
    const { rerender } = render(
      <ChatGroupsList
        {...chatGroupListActionProps}
        groups={[]}
        activeGroupId={null}
        isLoading
        skeletonCount={2}
        emptyState={null}
        onSelectGroup={vi.fn()}
        onCloseGroup={vi.fn()}
      />,
    );

    expect(document.querySelectorAll('[data-sidebar="menu-skeleton"]')).toHaveLength(2);
    rerender(
      <ChatGroupsList
        {...chatGroupListActionProps}
        groups={[]}
        activeGroupId={null}
        emptyState={null}
        onSelectGroup={vi.fn()}
        onCloseGroup={vi.fn()}
      />,
    );
    expect(screen.queryByText("No groups yet")).not.toBeInTheDocument();
    expect(document.querySelector('[data-sidebar="menu"]')).toBeNull();
  });

  it("renders rows in the order of the groups prop", () => {
    const researchGroup: ChatGroupView = {
      ...groupView,
      id: "group_2",
      name: "Research",
    };
    const renderList = (groups: ChatGroupView[]) => (
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={groups}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={vi.fn()}
        />
      </SidebarProvider>
    );
    const rowIds = () =>
      Array.from(document.querySelectorAll("[data-flip-id]")).map((row) =>
        row.getAttribute("data-flip-id"),
      );

    const { rerender } = render(renderList([groupView, researchGroup]));
    expect(rowIds()).toEqual(["group_1", "group_2"]);

    rerender(renderList([researchGroup, groupView]));
    expect(rowIds()).toEqual(["group_2", "group_1"]);
  });

  it("renders count-only idle group slots and status icons for active groups", () => {
    const { container, rerender } = render(
      <ChatGroupRightSlot status="idle" count={3} />,
    );
    expect(screen.getByLabelText("3 open chats")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent is working")).not.toBeInTheDocument();

    rerender(<ChatGroupRightSlot status="running" count={3} />);
    const loader = screen.getByLabelText("Agent is working");
    expect(loader).toHaveAttribute("width", "16");
    expect(loader.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("3 open chats")).toHaveClass("tabular-nums");

    rerender(<ChatGroupRightSlot status="unread" count={3} />);
    const unreadDot = container.querySelector(".bg-amber-500");
    expect(unreadDot).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByLabelText("Awaiting your review")).not.toBeInTheDocument();
    expect(screen.getByLabelText("3 open chats")).toBeInTheDocument();
    const rightSlot = screen.getByLabelText("3 open chats").parentElement;
    expect(rightSlot).not.toBeNull();
    expect(screen.getByLabelText("3 open chats")).toHaveClass(
      "group-hover/menu-item:opacity-0",
    );
    expect(screen.getByLabelText("3 open chats")).toHaveClass(
      "group-has-[[data-state=open]]/menu-item:opacity-0",
    );
    expect(rightSlot!).not.toHaveClass("group-hover/menu-item:opacity-0");
  });

  it("counts visible open chats in the sidebar instead of closed tabs", () => {
    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[
            {
              ...groupView,
              member_count: 2,
              closed_thread_ids: ["thread_2"],
              closed_threads: [
                makeThreadSummary({
                  id: "thread_2",
                  title: "Dismissed",
                  updated_at: 1,
                  status: "idle",
                  membership: "closed",
                }),
              ],
            },
          ]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(screen.getByLabelText("1 open chat")).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Launch" })).toHaveClass("!pr-2");
    expect(screen.queryByLabelText("2 open chats")).not.toBeInTheDocument();
  });

  it("renders collapsed avatars as decorative rounded chips", () => {
    const { container } = render(<ChatGroupCollapsedIcon group={groupView} />);

    const collapsedIcon = container.querySelector('[data-slot="avatar"][data-shape="rounded"]');
    expect(collapsedIcon).not.toBeNull();
    expect(collapsedIcon).toHaveAttribute("aria-hidden", "true");
    expect(collapsedIcon).toHaveClass("select-none");
    expect(collapsedIcon?.querySelector("svg")).not.toBeNull();
  });

  it("keeps collapsed group identity visible while overlaying status", () => {
    const runningGroup: ChatGroupView = {
      ...groupView,
      status: "running",
      avatar: { color: "#7C3AED", content: "Rocket" },
    };
    const { container, rerender } = render(<ChatGroupIcon group={runningGroup} />);

    let collapsedChip = container.querySelector(
      '[data-slot="avatar"][data-shape="rounded"][data-size="md"]',
    );
    expect(collapsedChip).not.toBeNull();
    expect(collapsedChip?.querySelector("svg")).not.toBeNull();
    const loader = container.querySelector('svg[aria-label="Agent is working"]');
    expect(loader).not.toBeNull();
    expect(loader?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(within(container).getByRole("status")).toHaveTextContent(
      "Agent is working",
    );
    expect(loader?.parentElement).toHaveClass("bg-background/65");
    expect(loader?.parentElement).not.toHaveClass("backdrop-blur-[2px]");
    expect(loader?.parentElement).toHaveClass("text-foreground");
    expect(loader?.parentElement).toHaveClass("rounded-[28%]");

    rerender(
      <ChatGroupIcon
        group={{
          ...runningGroup,
          status: "unread",
        }}
      />,
    );

    collapsedChip = container.querySelector(
      '[data-slot="avatar"][data-shape="rounded"][data-size="md"]',
    );
    expect(collapsedChip).not.toBeNull();
    expect(collapsedChip?.querySelector("svg")).not.toBeNull();
    const unreadDot = container.querySelector(".ring-sidebar");
    expect(unreadDot).not.toBeNull();
    expect(unreadDot?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(within(container).getByRole("status")).toHaveTextContent(
      "Awaiting your review",
    );
  });

  it("exposes one semantic group status while keeping both visual layers decorative", () => {
    const runningGroup: ChatGroupView = {
      ...groupView,
      status: "running",
    };
    const renderList = (group: ChatGroupView) => (
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[group]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={vi.fn()}
        />
      </SidebarProvider>
    );
    const { rerender } = render(renderList(runningGroup));

    let row = screen.getByRole("button", { name: "Launch" });
    let statuses = within(row).getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent("Agent is working");
    const loaders = row.querySelectorAll('svg[role="status"]');
    expect(loaders).toHaveLength(2);
    for (const loader of loaders) {
      expect(loader.closest('[aria-hidden="true"]')).not.toBeNull();
    }

    rerender(renderList({ ...runningGroup, status: "unread" }));

    row = screen.getByRole("button", { name: "Launch" });
    statuses = within(row).getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent("Awaiting your review");
    const unreadDots = row.querySelectorAll(".bg-amber-500");
    expect(unreadDots).toHaveLength(2);
    for (const unreadDot of unreadDots) {
      expect(unreadDot.closest('[aria-hidden="true"]')).not.toBeNull();
    }

    rerender(renderList({ ...runningGroup, status: "idle" }));

    row = screen.getByRole("button", { name: "Launch" });
    expect(within(row).queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders options and close actions for every group row", () => {
    const researchGroup: ChatGroupView = {
      ...groupView,
      id: "group_2",
      name: "Research",
    };

    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[groupView, researchGroup]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Group options for Launch" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Group options for Research" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close Launch" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close Research" }),
    ).toBeInTheDocument();
  });

  it("closes a hover card in another section when a group menu opens", async () => {
    const user = userEvent.setup();
    render(<CoordinatedChatGroupsListsFixture />);

    expect(
      await screen.findByText("API plan"),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="hover-card-content"]'),
    ).not.toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Group options for Recent" }),
    );

    expect(
      await screen.findByRole("menuitem", { name: "Pin group" }),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="hover-card-content"]'),
      ).toBeNull();
    });
  });

  it("pins an unpinned group from the row options menu", async () => {
    const user = userEvent.setup();
    const onTogglePinGroup = vi.fn();

    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[groupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={vi.fn()}
          onTogglePinGroup={onTogglePinGroup}
        />
      </SidebarProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Group options for Launch" }),
    );
    const pinItem = await screen.findByRole("menuitem", {
      name: "Pin group",
    });

    expect(pinItem.querySelector(".lucide-pin")).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Rename group" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Close group" })).toBeVisible();

    await user.click(pinItem);

    expect(onTogglePinGroup).toHaveBeenCalledWith(groupView);
  });

  it("shows the unpin action for a pinned group", async () => {
    const user = userEvent.setup();
    const pinnedGroup = { ...groupView, pinned_at: 123 };

    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[pinnedGroup]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={vi.fn()}
        />
      </SidebarProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Group options for Launch" }),
    );
    const unpinItem = await screen.findByRole("menuitem", {
      name: "Unpin group",
    });

    expect(unpinItem.querySelector(".lucide-pin-off")).not.toBeNull();
  });

  it("renames a group from the row options menu", async () => {
    const user = userEvent.setup();
    const onRenameGroup = vi.fn();

    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[groupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={vi.fn()}
          onRenameGroup={onRenameGroup}
        />
      </SidebarProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Group options for Launch" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Rename group" }),
    );

    const nameInput = await screen.findByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Roadmap");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onRenameGroup).toHaveBeenCalledWith("group_1", {
      name: "Roadmap",
    });
  });

  it("confirms the default-styled close action from the row options menu", async () => {
    const user = userEvent.setup();
    const onCloseGroup = vi.fn();

    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Group options for Launch" }),
    );
    const closeItem = await screen.findByRole("menuitem", {
      name: "Close group",
    });
    expect(closeItem).not.toHaveAttribute("data-variant", "destructive");
    await user.click(closeItem);

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close group" }));

    expect(onCloseGroup).toHaveBeenCalledWith("group_multi");
  });

  it("closes from the row options menu without a dialog when confirmation is suppressed", async () => {
    const user = userEvent.setup();
    const onCloseGroup = vi.fn();
    window.localStorage.setItem(
      CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      "true",
    );

    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[groupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Group options for Launch" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Close group" }),
    );

    expect(onCloseGroup).toHaveBeenCalledWith("group_1");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("selects and opens close confirmation for a single-chat group by default", () => {
    const onSelectGroup = vi.fn();
    const onCloseGroup = vi.fn();

    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[groupView]}
          activeGroupId={null}
          onSelectGroup={onSelectGroup}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    const groupButton = screen.getByRole("button", { name: "Launch" });
    expect(groupButton).toHaveAttribute("data-size", "sm");
    expect(groupButton).toHaveClass(
      "group-data-[collapsible=icon]:[&_*]:pointer-events-none",
    );
    expect(groupButton).toHaveClass(
      "group-data-[collapsible=icon]:[&_*]:cursor-pointer",
    );
    expect(groupButton).toHaveClass(
      "group-hover/menu-item:bg-sidebar-accent",
    );
    expect(groupButton).toHaveClass(
      "group-hover/menu-item:text-sidebar-accent-foreground",
    );

    const closeButton = screen.getByRole("button", { name: "Close Launch" });
    expect(closeButton).not.toHaveClass("top-1/2");
    expect(closeButton).not.toHaveClass("-translate-y-1/2");

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(onSelectGroup).toHaveBeenCalledWith("group_1");
    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/Its 1 chat will be removed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close group" }));

    expect(onCloseGroup).toHaveBeenCalledWith("group_1");
  });

  it("opens close confirmation for a multi-chat group by default", () => {
    const onCloseGroup = vi.fn();
    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/Its 2 chats will be removed/)).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Do not show again" }),
    ).not.toBeChecked();
  });

  it("does not suppress future close group confirmations when confirming without the checkbox", () => {
    const onCloseGroup = vi.fn();
    const { rerender } = render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));
    fireEvent.click(screen.getByRole("button", { name: "Close group" }));

    expect(onCloseGroup).toHaveBeenCalledWith("group_multi");
    expect(
      window.localStorage.getItem(
        CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      ),
    ).toBeNull();

    onCloseGroup.mockClear();
    rerender(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[
            {
              ...multiChatGroupView,
              id: "group_follow_up",
              name: "Follow-up",
            },
          ]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Follow-up" }));

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("can suppress future close group confirmations after confirming with the checkbox", () => {
    const onCloseGroup = vi.fn();
    const { rerender } = render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Do not show again" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close group" }));

    expect(onCloseGroup).toHaveBeenCalledWith("group_multi");
    expect(
      window.localStorage.getItem(
        CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      ),
    ).toBe("true");

    onCloseGroup.mockClear();
    rerender(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[
            {
              ...multiChatGroupView,
              id: "group_follow_up",
              name: "Follow-up",
            },
          ]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Follow-up" }));

    expect(onCloseGroup).toHaveBeenCalledWith("group_follow_up");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("honors an existing saved close confirmation suppression preference", () => {
    const onCloseGroup = vi.fn();
    window.localStorage.setItem(
      CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      "true",
    );

    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(onCloseGroup).toHaveBeenCalledWith("group_multi");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("ignores stale unversioned close confirmation suppression preferences", () => {
    const onCloseGroup = vi.fn();
    window.localStorage.setItem(
      "camelai:close-chat-group-confirmation-suppressed",
      "true",
    );

    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("shows close confirmation when the saved preference cannot be read", () => {
    const onCloseGroup = vi.fn();
    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage unavailable");
      });

    try {
      render(
        <SidebarProvider>
          <ChatGroupsList
            {...chatGroupListActionProps}
            groups={[multiChatGroupView]}
            activeGroupId={null}
            onSelectGroup={vi.fn()}
            onCloseGroup={onCloseGroup}
          />
        </SidebarProvider>,
      );
    } finally {
      getItemSpy.mockRestore();
    }

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("keeps close group confirmation enabled when the checked dialog is canceled", () => {
    const onCloseGroup = vi.fn();
    render(
      <SidebarProvider>
        <ChatGroupsList
          {...chatGroupListActionProps}
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Do not show again" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem(
        CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      ),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Do not show again" }),
    ).not.toBeChecked();
  });
});

describe("chat group sidebar sections", () => {
  it("orders pins oldest-first and keeps recents in their input order", () => {
    const recent = { ...groupView, id: "recent", name: "Recent" };
    const newerPin = {
      ...groupView,
      id: "pin_newer",
      name: "Newer pin",
      pinned_at: 200,
    };
    const olderPin = {
      ...groupView,
      id: "pin_older",
      name: "Older pin",
      pinned_at: 100,
    };
    const sections = resolveChatGroupSidebarSections(
      [recent, newerPin, olderPin],
      false,
      0,
    );

    expect(sections.pinnedGroups.map((group) => group.id)).toEqual([
      "pin_older",
      "pin_newer",
    ]);
    expect(sections.recentGroups.map((group) => group.id)).toEqual(["recent"]);
    expect(sections.showPinnedSection).toBe(true);
    expect(sections.showRecentsSection).toBe(true);
  });

  it("hides empty/all-pinned sections and sizes loading pins from the hint", () => {
    const allPinned = resolveChatGroupSidebarSections(
      [{ ...groupView, pinned_at: 100 }],
      true,
      0,
    );
    expect(allPinned.showPinnedSection).toBe(true);
    expect(allPinned.showRecentsSection).toBe(false);

    const loading = resolveChatGroupSidebarSections([], true, 25);
    expect(loading.showPinnedSection).toBe(true);
    expect(loading.showRecentsSection).toBe(true);
    expect(loading.pinnedSkeletonCount).toBe(20);

    const empty = resolveChatGroupSidebarSections([], false, 0);
    expect(empty.showPinnedSection).toBe(false);
    expect(empty.showRecentsSection).toBe(true);
  });
});

describe("getCloseGroupRedirect", () => {
  it("navigates away before closing the active group so the thread route cannot recreate it", () => {
    expect(getCloseGroupRedirect([groupView], "group_1", "group_1")).toBe(
      "/chat",
    );
  });

  it("moves to another group when closing the active group and leaves inactive closes in place", () => {
    const nextGroup: ChatGroupView = {
      ...groupView,
      id: "group_2",
      name: "Research",
      last_active_thread_id: "thread_2",
      open_thread_ids: ["thread_2"],
      open_threads: [
        makeThreadSummary({
          id: "thread_2",
          title: "Research notes",
          updated_at: 2,
          status: "idle",
        }),
      ],
    };

    expect(
      getCloseGroupRedirect([groupView, nextGroup], "group_1", "group_1"),
    ).toBe("/chat/thread_2");
    expect(
      getCloseGroupRedirect([groupView, nextGroup], "group_1", "group_2"),
    ).toBeNull();
  });
});

describe("getGroupLandingHref", () => {
  it("opens the group landing page instead of a closed thread when no tabs are open", () => {
    expect(
      getGroupLandingHref({
        ...groupView,
        open_thread_ids: [],
        closed_thread_ids: ["thread_1"],
        open_threads: [],
        closed_threads: groupView.open_threads,
        member_count: 1,
      }),
    ).toBe("/chat?group=group_1");
  });
});

describe("mergeActiveChatGroup", () => {
  it("merges stale layout group data with the active route group", () => {
    const activeGroup: ChatGroupView = {
      ...groupView,
      open_thread_ids: ["thread_1", "thread_2"],
      open_threads: [
        ...groupView.open_threads,
        makeThreadSummary({
          id: "thread_2",
          title: "New tab",
          updated_at: 2,
          status: "running",
        }),
      ],
      member_count: 2,
      status: "running",
    };

    const merged = mergeActiveChatGroup([groupView], activeGroup);

    expect(merged).toHaveLength(1);
    expect(merged[0].open_thread_ids).toEqual(["thread_1", "thread_2"]);
    expect(merged[0].open_threads.map((thread) => thread.id)).toEqual([
      "thread_1",
      "thread_2",
    ]);
  });

  it("preserves existing tabs when the active route group is a lightweight fallback", () => {
    const activeGroup: ChatGroupView = {
      ...groupView,
      id: "group_multi",
      open_thread_ids: ["thread_new"],
      closed_thread_ids: [],
      open_threads: [
        makeThreadSummary({
          id: "thread_new",
          title: "New tab",
          updated_at: 3,
          status: "running",
        }),
      ],
      closed_threads: [],
      member_count: 1,
      status: "running",
      last_active_thread_id: "thread_new",
    };

    const merged = mergeActiveChatGroup([multiChatGroupView], activeGroup);

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("Launch");
    expect(merged[0].last_active_thread_id).toBe("thread_new");
    expect(merged[0].open_thread_ids).toEqual([
      "thread_1",
      "thread_2",
      "thread_new",
    ]);
    expect(merged[0].open_threads.map((thread) => thread.id)).toEqual([
      "thread_1",
      "thread_2",
      "thread_new",
    ]);
    expect(merged[0].member_count).toBe(3);
  });

  it("preserves a persisted avatar when merging a lightweight active fallback", () => {
    const persistedGroup: ChatGroupView = {
      ...groupView,
      avatar: { color: "#7C3AED", content: "🔍" },
    };
    const activeGroup: ChatGroupView = {
      ...groupView,
      avatar: { color: "#4F46E5", content: "💬" },
      open_threads: [
        makeThreadSummary({
          id: "thread_new",
          title: "New tab",
          updated_at: 3,
          status: "running",
        }),
      ],
      open_thread_ids: ["thread_new"],
      member_count: 1,
      status: "running",
      last_active_thread_id: "thread_new",
    };

    const merged = mergeActiveChatGroup([persistedGroup], activeGroup);

    expect(merged[0].avatar).toEqual({ color: "#7C3AED", content: "🔍" });
  });

  it("uses active route ordering when it has a complete group snapshot", () => {
    const activeGroup: ChatGroupView = {
      ...multiChatGroupView,
      open_thread_ids: ["thread_2", "thread_1"],
      open_threads: [
        multiChatGroupView.open_threads[1],
        multiChatGroupView.open_threads[0],
      ],
      last_active_thread_id: "thread_2",
    };

    const merged = mergeActiveChatGroup([multiChatGroupView], activeGroup);

    expect(merged[0].open_thread_ids).toEqual(["thread_2", "thread_1"]);
    expect(merged[0].open_threads.map((thread) => thread.id)).toEqual([
      "thread_2",
      "thread_1",
    ]);
  });

  it("adds an active group missing from the stale layout list", () => {
    const activeGroup: ChatGroupView = {
      ...groupView,
      id: "group_new",
      name: "New group",
    };

    const merged = mergeActiveChatGroup([groupView], activeGroup);

    expect(merged.map((group) => group.id)).toEqual(["group_new", "group_1"]);
  });

  it("keeps an active pinned group in one client-side partition", () => {
    const pinnedGroup = { ...groupView, pinned_at: 100 };
    const merged = mergeActiveChatGroup([pinnedGroup], pinnedGroup);
    const patched = applyLocalGroupPinnedPatches(
      merged,
      new Map([[pinnedGroup.id, 200]]),
    );
    const pinned = patched.filter((group) => group.pinned_at !== null);
    const recent = patched.filter((group) => group.pinned_at === null);

    expect(merged).toHaveLength(1);
    expect(pinned.map((group) => group.id)).toEqual([pinnedGroup.id]);
    expect(recent).toEqual([]);
  });
});

describe("hasPendingCompletionSummaries", () => {
  it("detects pending assistant summaries in open and closed threads", () => {
    expect(
      hasPendingCompletionSummaries([
        {
          ...groupView,
          open_threads: [
            makeThreadSummary({
              id: "thread_pending_open",
              title: "Pending open",
              last_assistant_summary_status: "pending",
            }),
          ],
        },
      ]),
    ).toBe(true);

    expect(
      hasPendingCompletionSummaries([
        {
          ...groupView,
          open_threads: [],
          closed_threads: [
            makeThreadSummary({
              id: "thread_pending_closed",
              title: "Pending closed",
              membership: "closed",
              last_assistant_summary_status: "pending",
            }),
          ],
        },
      ]),
    ).toBe(true);

    expect(hasPendingCompletionSummaries([groupView])).toBe(false);
  });
});

describe("shouldRevalidateThreadStatusUpdate", () => {
  it("keeps summary metadata-only frames eligible for fallback revalidation", () => {
    expect(shouldRevalidateThreadStatusUpdate("unread", true, true)).toBe(true);
    expect(shouldRevalidateThreadStatusUpdate("idle", true, false)).toBe(false);
    expect(shouldRevalidateThreadStatusUpdate("running", false, false)).toBe(true);
  });
});

describe("reconcileLocalThreadStatusesWithSnapshot", () => {
  it("clears stale local running statuses when the snapshot omits them", () => {
    const current = new Map<string, "idle" | "running" | "unread">([
      ["thread_1", "running"],
      ["thread_2", "unread"],
    ]);

    const next = reconcileLocalThreadStatusesWithSnapshot(current, new Set());

    expect(next).not.toBe(current);
    expect(Array.from(next.entries())).toEqual([["thread_2", "unread"]]);
  });

  it("clears stale active thread optimistic running status when the snapshot omits it", () => {
    const current = new Map<string, "idle" | "running" | "unread">([
      ["thread_1", "running"],
      ["thread_2", "unread"],
    ]);

    const next = reconcileLocalThreadStatusesWithSnapshot(current, new Set());

    expect(next).not.toBe(current);
    expect(Array.from(next.entries())).toEqual([["thread_2", "unread"]]);
  });

  it("lets snapshot running state win over stale local non-running statuses", () => {
    const current = new Map<string, "idle" | "running" | "unread">([
      ["thread_1", "idle"],
      ["thread_2", "unread"],
    ]);

    const next = reconcileLocalThreadStatusesWithSnapshot(
      current,
      new Set(["thread_1"]),
    );

    expect(Array.from(next.entries())).toEqual([["thread_2", "unread"]]);
  });

  it("clears stale local idle metadata when the snapshot says the thread is running", () => {
    const current = new Map([
      [
        "thread_1",
        {
          status: "idle" as const,
          latestUserMessage: "optimistic prompt",
          runningActivityText: "optimistic prompt",
        },
      ],
    ]);

    const next = reconcileLocalThreadStatusesWithSnapshot(
      current,
      new Set(["thread_1"]),
    );

    expect(Array.from(next.entries())).toEqual([]);
  });

  it("keeps a local idle written after the snapshot run started (stale server row)", () => {
    const current = new Map([
      ["thread_1", { status: "idle" as const, statusChangedAt: 2_000 }],
    ]);

    const next = reconcileLocalThreadStatusesWithSnapshot(
      current,
      new Set(["thread_1"]),
      new Map([["thread_1", 1_000]]),
    );

    expect(next).toBe(current);
  });

  it("clears a local idle when the snapshot run started after it (genuinely new run)", () => {
    const current = new Map([
      ["thread_1", { status: "idle" as const, statusChangedAt: 1_000 }],
    ]);

    const next = reconcileLocalThreadStatusesWithSnapshot(
      current,
      new Set(["thread_1"]),
      new Map([["thread_1", 2_000]]),
    );

    expect(Array.from(next.entries())).toEqual([]);
  });

  it("clears a local idle when the snapshot run has no started-at metadata", () => {
    const current = new Map([
      ["thread_1", { status: "idle" as const, statusChangedAt: 2_000 }],
    ]);

    const next = reconcileLocalThreadStatusesWithSnapshot(
      current,
      new Set(["thread_1"]),
      new Map([["thread_1", null]]),
    );

    expect(Array.from(next.entries())).toEqual([]);
  });
});

describe("mergeLiveAndLocalThreadStatuses", () => {
  it("keeps fresher live running state over an older local idle overlay", () => {
    const merged = mergeLiveAndLocalThreadStatuses(
      new Map([
        [
          "thread_1",
          {
            status: "running",
            statusChangedAt: 2_000,
            runningActivityText: "Running typecheck...",
          },
        ],
      ]),
      new Map([
        [
          "thread_1",
          {
            status: "idle",
            statusChangedAt: 1_000,
            latestUserMessage: "local prompt",
          },
        ],
      ]),
    );

    expect(merged.get("thread_1")).toEqual({
      status: "running",
      statusChangedAt: 2_000,
      runningActivityText: "Running typecheck...",
    });
  });

  it("lets a newer local idle beat a stale live running entry", () => {
    const merged = mergeLiveAndLocalThreadStatuses(
      new Map([
        [
          "thread_1",
          {
            status: "running",
            statusChangedAt: 1_000,
            runningActivityText: "Running typecheck...",
          },
        ],
      ]),
      new Map([["thread_1", { status: "idle", statusChangedAt: 2_000 }]]),
    );

    expect(merged.get("thread_1")?.status).toBe("idle");
  });

  it("keeps the earlier start of a turn both sides see running", () => {
    // The page marked the turn at the click; the server's row started later.
    const merged = mergeLiveAndLocalThreadStatuses(
      new Map([["thread_1", { status: "running", runningStartedAt: 5_000 }]]),
      new Map([["thread_1", { status: "running", runningStartedAt: 3_000 }]]),
    );
    expect(merged.get("thread_1")?.runningStartedAt).toBe(3_000);

    // A server frame for the same turn does not move the local start either.
    expect(
      mergeThreadMetadata(
        { status: "running", runningStartedAt: 3_000 },
        { status: "running", runningStartedAt: 5_000 },
      ).runningStartedAt,
    ).toBe(3_000);
    // A new turn after an idle starts at its own time.
    expect(
      mergeThreadMetadata(
        { status: "idle", runningStartedAt: 3_000 },
        { status: "running", runningStartedAt: 5_000 },
      ).runningStartedAt,
    ).toBe(5_000);
  });

  it("lets a local idle without timestamps beat an unstamped live running entry", () => {
    const merged = mergeLiveAndLocalThreadStatuses(
      new Map([["thread_1", { status: "running" }]]),
      new Map([["thread_1", { status: "idle" }]]),
    );

    expect(merged.get("thread_1")?.status).toBe("idle");
  });

  it("still lets local running overlay a live idle entry", () => {
    const merged = mergeLiveAndLocalThreadStatuses(
      new Map([["thread_1", { status: "idle", statusChangedAt: 2_000 }]]),
      new Map([
        ["thread_1", { status: "running", statusChangedAt: 1_000 }],
      ]),
    );

    expect(merged.get("thread_1")?.status).toBe("running");
  });
});

describe("reconcileThreadSummaryPatchesWithGroups", () => {
  it("keeps optimistic patches when refreshed group data is older", () => {
    const current = new Map([
      ["thread_1", { title: "Optimistic title", updatedAt: 5 }],
    ]);

    expect(reconcileThreadSummaryPatchesWithGroups(current, [groupView])).toBe(
      current,
    );
  });

  it("drops optimistic patches for threads present in matching-or-newer group data", () => {
    const current = new Map([
      ["thread_1", { title: "Optimistic title", updatedAt: 1 }],
      ["thread_missing", { title: "Drop me", updatedAt: 1 }],
    ]);

    const next = reconcileThreadSummaryPatchesWithGroups(current, [groupView]);

    expect(next).not.toBe(current);
    expect(next.has("thread_1")).toBe(false);
    expect(next.has("thread_missing")).toBe(false);
  });

  it("preserves patch identity when no refreshed thread matches", () => {
    const current = new Map([["thread_other", { title: "Pending", updatedAt: 5 }]]);

    expect(reconcileThreadSummaryPatchesWithGroups(current, undefined)).toBe(current);
  });

  it("clears all patches when fresh group data has no threads", () => {
    const current = new Map([["thread_1", { title: "Pending", updatedAt: 5 }]]);
    const emptyGroup: ChatGroupView = {
      ...groupView,
      open_thread_ids: [],
      closed_thread_ids: [],
      open_threads: [],
      closed_threads: [],
      member_count: 0,
      status: "idle",
    };

    expect(
      reconcileThreadSummaryPatchesWithGroups(current, [emptyGroup]).size,
    ).toBe(0);
  });
});

describe("reconcileGroupAvatarPatchesWithGroups", () => {
  it("clears pending avatar patches when refreshed group data has a final avatar", () => {
    const current = new Map([
      [
        "group_1",
        {
          avatar: { color: "#4F46E5", content: "💬", status: "pending" as const },
          updatedAt: 1_000,
        },
      ],
    ]);
    const refreshedGroup: ChatGroupView = {
      ...groupView,
      avatar: { color: "#7C3AED", content: "🧠", status: "generated" },
    };

    const next = reconcileGroupAvatarPatchesWithGroups(
      current,
      [refreshedGroup],
      2_000,
    );

    expect(next).not.toBe(current);
    expect(next.size).toBe(0);
  });

  it("expires pending avatar patches when no final event arrives", () => {
    const current = new Map([
      [
        "group_1",
        {
          avatar: { color: "#4F46E5", content: "💬", status: "pending" as const },
          updatedAt: 1_000,
        },
      ],
    ]);

    const next = reconcileGroupAvatarPatchesWithGroups(
      current,
      undefined,
      1_000 + LOCAL_GROUP_AVATAR_PENDING_TIMEOUT_MS,
    );

    expect(next).not.toBe(current);
    expect(next.size).toBe(0);
  });

  it("drops user avatar patches once matching server data arrives", () => {
    const userAvatar = {
      color: "#7C3AED",
      content: "🌊",
      status: "user" as const,
    };
    const current = new Map([
      ["group_1", { avatar: userAvatar, updatedAt: 1_000 }],
    ]);
    const matchingGroup: ChatGroupView = {
      ...groupView,
      avatar: userAvatar,
    };

    const reconciled = reconcileGroupAvatarPatchesWithGroups(
      current,
      [matchingGroup],
      2_000,
    );
    expect(reconciled.size).toBe(0);

    const changedGroup: ChatGroupView = {
      ...groupView,
      avatar: { color: "#0F766E", content: "⚙️", status: "generated" },
    };
    const later = reconcileGroupAvatarPatchesWithGroups(
      reconciled,
      [changedGroup],
      3_000,
    );
    expect(later.size).toBe(0);
  });
});

describe("ChatGroupsProvider summary patches", () => {
  it("drops unconfirmed optimistic recency on the next loader snapshot", async () => {
    const newerGroup: ChatGroupView = {
      ...groupView,
      id: "group_newer",
      name: "Newer",
      updated_at: 200,
      open_thread_ids: ["thread_newer"],
      open_threads: [
        makeThreadSummary({
          id: "thread_newer",
          title: "Newer thread",
          updated_at: 200,
          last_active_at: 200,
        }),
      ],
    };
    const optimisticGroup: ChatGroupView = {
      ...groupView,
      id: "group_optimistic",
      name: "Optimistic",
      updated_at: 100,
      open_thread_ids: ["thread_optimistic"],
      open_threads: [
        makeThreadSummary({
          id: "thread_optimistic",
          title: "Optimistic thread",
          updated_at: 100,
          last_active_at: 100,
          latest_user_message_at: 100,
          last_user_message_at: null,
        }),
      ],
    };
    let loaderState = authLoaderState([newerGroup, optimisticGroup]);
    const loader = vi.fn(() => loaderState);
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app",
          path: "/",
          loader,
          element: (
            <ChatGroupsProvider>
              <ChatGroupsProviderProbe />
            </ChatGroupsProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId("group-order")).toHaveTextContent(
      "group_newer,group_optimistic",
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("camelai:thread-status", {
          detail: {
            threadId: "thread_optimistic",
            status: "running",
            latestUserMessage: "optimistic prompt",
            latestUserMessageAt: 300,
          },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("group-order")).toHaveTextContent(
        "group_optimistic,group_newer",
      );
    });

    loaderState = authLoaderState([
      { ...newerGroup },
      { ...optimisticGroup },
    ]);
    act(() => {
      void router.revalidate();
    });

    await waitFor(() => {
      expect(screen.getByTestId("group-order")).toHaveTextContent(
        "group_newer,group_optimistic",
      );
    });
  });

  it("does not suspend children while app chat groups are deferred", async () => {
    let resolveGroups: (groups: ChatGroupView[]) => void = () => {};
    const deferredGroups = new Promise<ChatGroupView[]>((resolve) => {
      resolveGroups = resolve;
    });
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app",
          path: "/",
          loader: () => authLoaderState(deferredGroups),
          element: (
            <ChatGroupsProvider>
              <ChatGroupsProviderProbe />
            </ChatGroupsProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("groups-loading")).toHaveTextContent(
      "loading",
    );
    expect(screen.getByTestId("thread-title")).toHaveTextContent("");

    await act(async () => {
      resolveGroups([groupView]);
      await deferredGroups;
    });

    await waitFor(() => {
      expect(screen.getByTestId("groups-loading")).toHaveTextContent("loaded");
    });
    expect(screen.getByTestId("thread-title")).toHaveTextContent("API plan");
  });

  it("keeps current groups visible while app chat groups revalidate", async () => {
    let loaderChatGroups: ChatGroupView[] | Promise<ChatGroupView[]> = [groupView];
    const loader = vi.fn(() => authLoaderState(loaderChatGroups));
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app",
          path: "/",
          loader,
          element: (
            <ChatGroupsProvider>
              <ChatGroupsProviderProbe />
            </ChatGroupsProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("groups-loading")).toHaveTextContent(
      "loaded",
    );
    expect(screen.getByTestId("thread-title")).toHaveTextContent("API plan");

    let resolveRefresh: (groups: ChatGroupView[]) => void = () => {};
    const refreshPromise = new Promise<ChatGroupView[]>((resolve) => {
      resolveRefresh = resolve;
    });
    loaderChatGroups = refreshPromise;

    act(() => {
      void router.revalidate();
    });

    await waitFor(() => {
      expect(screen.getByTestId("groups-loading")).toHaveTextContent("loading");
    });
    expect(screen.getByTestId("thread-title")).toHaveTextContent("API plan");

    await act(async () => {
      resolveRefresh([groupViewWithThreadRevision("Updated plan", 2)]);
      await refreshPromise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("groups-loading")).toHaveTextContent("loaded");
    });
    expect(screen.getByTestId("thread-title")).toHaveTextContent("Updated plan");
  });

  it("keeps current groups visible when same-workspace chat group refresh rejects", async () => {
    let loaderChatGroups: ChatGroupView[] | Promise<ChatGroupView[]> = [groupView];
    const loader = vi.fn(() => authLoaderState(loaderChatGroups));
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app",
          path: "/",
          loader,
          element: (
            <ChatGroupsProvider>
              <ChatGroupsProviderProbe />
            </ChatGroupsProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("groups-loading")).toHaveTextContent(
      "loaded",
    );
    expect(screen.getByTestId("thread-title")).toHaveTextContent("API plan");

    let rejectRefresh: (error: Error) => void = () => {};
    const refreshPromise = new Promise<ChatGroupView[]>((_, reject) => {
      rejectRefresh = reject;
    });
    loaderChatGroups = refreshPromise;

    act(() => {
      void router.revalidate();
    });

    await waitFor(() => {
      expect(screen.getByTestId("groups-loading")).toHaveTextContent("loading");
    });
    expect(screen.getByTestId("thread-title")).toHaveTextContent("API plan");

    await act(async () => {
      rejectRefresh(new Error("chat group refresh failed"));
      await refreshPromise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(screen.getByTestId("groups-loading")).toHaveTextContent("loaded");
    });
    expect(screen.getByTestId("thread-title")).toHaveTextContent("API plan");
    expect(screen.getByTestId("group-name")).toHaveTextContent("Launch");
  });

  it("keeps newer local title patches over older loader group data", async () => {
    let loaderState = authLoaderState([
      {
        ...groupViewWithThreadRevision("API plan", 1),
        name: "New Chat",
      },
    ]);
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app",
          path: "/",
          loader: () => loaderState,
          element: (
            <ChatGroupsProvider>
              <ChatGroupsProviderProbe />
            </ChatGroupsProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    try {
      render(<RouterProvider router={router} />);

      expect(await screen.findByTestId("thread-title")).toHaveTextContent(
        "API plan",
      );

      await waitFor(() => {
        expect(addEventListenerSpy).toHaveBeenCalledWith(
          "camelai:thread-status",
          expect.any(Function),
        );
      });

      act(() => {
        window.dispatchEvent(
          new CustomEvent("camelai:thread-status", {
            detail: {
              threadId: "thread_1",
              title: "Optimistic title",
              updatedAt: 5,
            },
          }),
        );
      });
      await waitFor(() => {
        expect(screen.getByTestId("thread-title")).toHaveTextContent(
          "Optimistic title",
        );
      });
      expect(screen.getByTestId("group-name")).toHaveTextContent(
        "Optimistic title",
      );

      loaderState = authLoaderState([
        {
          ...groupViewWithThreadRevision("Old title", 1),
          name: "Old title",
        },
      ]);
      await act(async () => {
        await router.revalidate();
      });

      expect(screen.getByTestId("thread-title")).toHaveTextContent(
        "Optimistic title",
      );

      loaderState = authLoaderState([
        {
          ...groupViewWithThreadRevision("Server title", 6),
          name: "Server title",
        },
      ]);
      await act(async () => {
        await router.revalidate();
      });

      await waitFor(() => {
        expect(screen.getByTestId("thread-title")).toHaveTextContent(
          "Server title",
        );
      });
      expect(screen.getByTestId("group-name")).toHaveTextContent(
        "Server title",
      );
    } finally {
      addEventListenerSpy.mockRestore();
    }
  });

  it("applies generated avatar events without waiting for a loader refresh", async () => {
    const loader = vi.fn(() => authLoaderState([groupView]));
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app",
          path: "/",
          loader,
          element: (
            <ChatGroupsProvider>
              <ChatGroupsProviderProbe />
            </ChatGroupsProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("group-avatar")).toHaveTextContent("💬");
    await waitFor(() => {
      expect(addEventListenerSpy).toHaveBeenCalledWith(
        "camelai:chat-group-avatar",
        expect.any(Function),
      );
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent("camelai:chat-group-avatar", {
          detail: {
            groupId: "group_1",
            avatar: { color: "#4F46E5", content: "🧠", status: "generated" },
            updatedAt: 10,
          },
        }),
      );
    });

    expect(screen.getByTestId("group-avatar")).toHaveTextContent("🧠");
    expect(screen.getByTestId("group-avatar-status")).toHaveTextContent(
      "generated",
    );
    expect(loader).toHaveBeenCalledTimes(1);
    addEventListenerSpy.mockRestore();
  });

  it("applies pin events before revalidation and settles on loader state", async () => {
    let loaderState = authLoaderState([groupView]);
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app",
          path: "/",
          loader: () => loaderState,
          element: (
            <ChatGroupsProvider>
              <ChatGroupsProviderProbe />
            </ChatGroupsProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId("group-pinned-at")).toHaveTextContent(
      "unpinned",
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("camelai:chat-group-pinned", {
          detail: { groupId: "group_1", pinnedAt: 123 },
        }),
      );
    });
    expect(screen.getByTestId("group-pinned-at")).toHaveTextContent("123");

    loaderState = authLoaderState([{ ...groupView, pinned_at: 456 }]);
    await act(async () => {
      await router.revalidate();
    });
    await waitFor(() => {
      expect(screen.getByTestId("group-pinned-at")).toHaveTextContent("456");
    });
  });

  it("reconciles pending avatar events with generated loader data", async () => {
    let loaderState = authLoaderState([groupView]);
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app",
          path: "/",
          loader: () => loaderState,
          element: (
            <ChatGroupsProvider>
              <ChatGroupsProviderProbe />
            </ChatGroupsProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("group-avatar")).toHaveTextContent("💬");
    await waitFor(() => {
      expect(addEventListenerSpy).toHaveBeenCalledWith(
        "camelai:chat-group-avatar",
        expect.any(Function),
      );
    });

    act(() => {
      const updatedAt = Date.now();
      window.dispatchEvent(
        new CustomEvent("camelai:chat-group-avatar", {
          detail: {
            groupId: "group_1",
            avatar: { color: "#4F46E5", content: "💬", status: "pending" },
            updatedAt,
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("group-avatar-status")).toHaveTextContent(
        "pending",
      );
    });

    loaderState = authLoaderState([
      {
        ...groupView,
        avatar: { color: "#7C3AED", content: "🧠", status: "generated" },
      },
    ]);
    await act(async () => {
      await router.revalidate();
    });

    await waitFor(() => {
      expect(screen.getByTestId("group-avatar")).toHaveTextContent("🧠");
    });
    expect(screen.getByTestId("group-avatar-status")).toHaveTextContent(
      "generated",
    );
    addEventListenerSpy.mockRestore();
  });

  it("expires loader-returned pending avatars after the bounded polling window", async () => {
    vi.useFakeTimers();
    try {
      const loader = vi.fn(() =>
        authLoaderState([
          {
            ...groupView,
            avatar: { color: "#4F46E5", content: "💬", status: "pending" },
          },
        ]),
      );
      const router = createMemoryRouter(
        [
          {
            id: "routes/_app",
            path: "/",
            loader,
            element: (
              <ChatGroupsProvider>
                <ChatGroupsProviderProbe />
              </ChatGroupsProvider>
            ),
          },
        ],
        { initialEntries: ["/"] },
      );

      render(<RouterProvider router={router} />);

      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByTestId("group-avatar-status")).toHaveTextContent(
        "pending",
      );

      await act(async () => {
        vi.advanceTimersByTime(PENDING_GROUP_AVATAR_REVALIDATE_MAX_MS + 10);
        await Promise.resolve();
      });

      expect(screen.getByTestId("group-avatar-status")).toHaveTextContent(
        "default",
      );
      expect(loader.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes inactive thread metadata from status completions without broad revalidation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          thread: {
            id: "thread_2",
            title: "Generated UI polish",
            model: "sonnet",
            updated_at: 10,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const runningGroup: ChatGroupView = {
      ...multiChatGroupView,
      status: "running",
      open_threads: multiChatGroupView.open_threads.map((thread) =>
        thread.id === "thread_2"
          ? { ...thread, status: "running" as const }
          : thread,
      ),
    };
    const loader = vi.fn(() => authLoaderState([runningGroup]));
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app",
          path: "/",
          loader,
          element: (
            <ChatGroupsProvider>
              <ChatGroupsProviderProbe threadId="thread_2" />
            </ChatGroupsProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    try {
      render(<RouterProvider router={router} />);

      expect(await screen.findByTestId("thread-title")).toHaveTextContent(
        "UI polish",
      );
      await waitFor(() => {
        expect(MockStatusStream.instances).toHaveLength(1);
      });
      expect(MockStatusStream.instances[0].url).toBe(
        "/api/workspaces/workspace_1/status/stream",
      );

      act(() => {
        MockStatusStream.instances[0].emit({
          type: "thread_status",
          threadId: "thread_2",
          status: "unread",
          completedAt: 10,
        });
      });

      await waitFor(
        () => {
          expect(fetchMock).toHaveBeenCalledWith("/api/threads/thread_2");
        },
        { timeout: 1200 },
      );
      await waitFor(() => {
        expect(screen.getByTestId("thread-title")).toHaveTextContent(
          "Generated UI polish",
        );
      });
      expect(loader).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("workspace status stream transport", () => {
  function sseResponse(body: string) {
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("delivers data frames, ignores heartbeats, and reattaches when a stream ends", async () => {
    const bodies = [
      `:hb\n\ndata: {"type":"thread_status_snapshot","runningThreadIds":[]}\n\n`,
      `data: {"type":"thread_status","threadId":"thread_1","status":"idle"}\n\n`,
    ];
    const fetchMock = vi.fn(async () => sseResponse(bodies.shift() ?? ""));
    vi.stubGlobal("fetch", fetchMock);
    const messages: string[] = [];
    const stream = realStatusStreamOpen({
      url: "/api/workspaces/workspace_1/status/stream",
      onMessage: (data) => messages.push(data),
    });

    try {
      await waitFor(() => {
        expect(messages).toHaveLength(2);
      });
      expect(JSON.parse(messages[0]).type).toBe("thread_status_snapshot");
      expect(JSON.parse(messages[1]).threadId).toBe("thread_1");
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      stream.close();
      vi.unstubAllGlobals();
    }
  });

  it("stops reattaching once closed", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(`data: {"type":"thread_status_snapshot"}\n\n`),
    );
    vi.stubGlobal("fetch", fetchMock);
    const messages: string[] = [];
    const stream = realStatusStreamOpen({
      url: "/api/workspaces/workspace_1/status/stream",
      onMessage: (data) => messages.push(data),
    });

    try {
      await waitFor(() => {
        expect(messages.length).toBeGreaterThan(0);
      });
      stream.close();
      const callsAtClose = fetchMock.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetchMock.mock.calls.length).toBe(callsAtClose);
    } finally {
      stream.close();
      vi.unstubAllGlobals();
    }
  });

  it("retries a retryable attach failure without surfacing a frame", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Overloaded", { status: 503 }))
      .mockResolvedValue(
        sseResponse(`data: {"type":"thread_status_snapshot"}\n\n`),
      );
    vi.stubGlobal("fetch", fetchMock);
    const messages: string[] = [];
    const stream = realStatusStreamOpen({
      url: "/api/workspaces/workspace_1/status/stream",
      onMessage: (data) => messages.push(data),
    });

    try {
      await waitFor(() => {
        expect(messages).toHaveLength(1);
      });
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      stream.close();
      vi.unstubAllGlobals();
    }
  });

  // Regression: the retired status WebSocket retried a hard verdict forever
  // with no error surface, which is how a removed route turned into an
  // invisible permanent loop on stale tabs. A terminal attach status must stop
  // the transport instead.
  it.each([
    ["401", 401],
    ["403", 403],
    ["404", 404],
  ])("stops retrying after a terminal %s attach", async (_label, status) => {
    const streamUrl = "/api/workspaces/workspace_1/status/stream";
    // The telemetry beacon falls back to fetch, so count attach attempts by URL
    // rather than by total fetch calls.
    const attachCalls = () =>
      fetchMock.mock.calls.filter((call) => call[0] === streamUrl).length;
    const fetchMock = vi.fn(async (input: unknown) =>
      input === streamUrl
        ? new Response("nope", { status })
        : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const stream = realStatusStreamOpen({
      url: streamUrl,
      onMessage: () => {},
    });

    try {
      await waitFor(() => {
        expect(attachCalls()).toBeGreaterThanOrEqual(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(attachCalls()).toBe(1);
    } finally {
      stream.close();
      vi.unstubAllGlobals();
    }
  });

  it("reports every failed attach so the app shell can check for version skew", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Overloaded", { status: 503 }))
      .mockResolvedValueOnce(new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const failures: Array<number | null> = [];
    const stream = realStatusStreamOpen({
      url: "/api/workspaces/workspace_1/status/stream",
      onMessage: () => {},
      onAttachFailure: (status) => failures.push(status),
    });

    try {
      await waitFor(() => {
        expect(failures).toEqual([503, 404]);
      });
    } finally {
      stream.close();
      vi.unstubAllGlobals();
    }
  });

  it("reports a transport-level failure with no status", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const failures: Array<number | null> = [];
    const stream = realStatusStreamOpen({
      url: "/api/workspaces/workspace_1/status/stream",
      onMessage: () => {},
      onAttachFailure: (status) => failures.push(status),
    });

    try {
      // A transport failure has no status to classify, so it stays retryable —
      // only the report is asserted here.
      await waitFor(() => {
        expect(failures.length).toBeGreaterThanOrEqual(1);
      });
      expect(failures.every((status) => status === null)).toBe(true);
    } finally {
      stream.close();
      vi.unstubAllGlobals();
    }
  });
});

describe("applyLiveRunningStatuses", () => {
  it("preserves group and thread identities for no-op status frames", () => {
    const source = [groupView];
    const result = applyLiveRunningStatuses(
      source,
      new Set(),
      false,
      null,
      new Map([["thread_1", "idle"] as const]),
    );

    expect(result).toBe(source);
    expect(result[0]).toBe(groupView);
    expect(result[0].open_threads[0]).toBe(groupView.open_threads[0]);
  });

  it("clears loader-derived running state after the socket snapshot arrives", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          status: "running",
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 1,
              status: "running",
              is_unread: false,
            }),
          ],
        },
      ],
      new Set(),
      true,
    );

    expect(group.status).toBe("idle");
    expect(group.open_threads[0].status).toBe("idle");
  });

  it("does not convert the active thread to unread after running stops", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          status: "running",
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 2,
              status: "running",
              is_unread: true,
            }),
          ],
        },
      ],
      new Set(),
      true,
      "thread_1",
    );

    expect(group.status).toBe("idle");
    expect(group.open_threads[0].is_unread).toBe(false);
    expect(group.open_threads[0].status).toBe("idle");
  });

  it("identifies active unread completion frames as viewed work", () => {
    expect(
      shouldMarkActiveUnreadThreadViewed("unread", "thread_1", "thread_1"),
    ).toBe(true);
    expect(
      shouldMarkActiveUnreadThreadViewed("unread", "thread_1", "thread_2"),
    ).toBe(false);
    expect(
      shouldMarkActiveUnreadThreadViewed("idle", "thread_1", "thread_1"),
    ).toBe(false);
  });

  it("identifies active local idle completions as viewed work", () => {
    expect(
      shouldMarkActiveIdleThreadViewed("idle", "thread_1", "thread_1"),
    ).toBe(true);
    expect(
      shouldMarkActiveIdleThreadViewed("idle", "thread_1", "thread_2"),
    ).toBe(false);
    expect(
      shouldMarkActiveIdleThreadViewed("running", "thread_1", "thread_1"),
    ).toBe(false);
  });

  it("revalidates when a snapshot drops a background running thread", () => {
    expect(
      getThreadIdsRequiringSnapshotRevalidation(
        new Map([["thread_1", "running"] as const]),
        new Map([["thread_2", "running"] as const]),
        new Set(["thread_2"]),
        "thread_active",
      ),
    ).toEqual(["thread_1"]);
  });

  it("does not revalidate when a snapshot drops the active running thread", () => {
    expect(
      getThreadIdsRequiringSnapshotRevalidation(
        new Map([["thread_1", "running"] as const]),
        new Map(),
        new Set(),
        "thread_1",
      ),
    ).toEqual([]);
  });

  it("treats an explicit idle status frame as authoritative before a snapshot", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          status: "running",
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 2,
              status: "running",
              is_unread: false,
            }),
          ],
        },
      ],
      new Set(),
      false,
      null,
      new Map([["thread_1", "idle"] as const]),
    );

    expect(group.status).toBe("idle");
    expect(group.open_threads[0].status).toBe("idle");
  });

  it("treats an explicit idle status as authoritative over stale unread loader state", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          status: "unread",
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 2,
              status: "unread",
              is_unread: true,
            }),
          ],
        },
      ],
      new Set(),
      true,
      null,
      new Map([["thread_1", "idle"] as const]),
    );

    expect(group.status).toBe("idle");
    expect(group.open_threads[0].status).toBe("idle");
    expect(group.open_threads[0].is_unread).toBe(false);
  });

  it("marks a completed background thread unread from live status", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          open_thread_ids: ["thread_1", "thread_2"],
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 2,
              status: "running",
              is_unread: false,
            }),
            makeThreadSummary({
              id: "thread_2",
              title: "UI polish",
              updated_at: 2,
              status: "idle",
              is_unread: false,
            }),
          ],
        },
      ],
      new Set(),
      true,
      "thread_2",
      new Map([["thread_1", "unread"] as const]),
    );

    expect(group.status).toBe("unread");
    expect(group.open_threads[0].status).toBe("unread");
    expect(group.open_threads[1].status).toBe("idle");
  });

  it("applies local thread summary patches without status revalidation", () => {
    const [group] = applyLiveRunningStatuses(
      [groupView],
      new Set(),
      false,
      null,
      new Map(),
      new Map([["thread_1", { title: "Renamed thread", updatedAt: 2 }]]),
    );

    expect(group.open_threads[0].title).toBe("Renamed thread");
    expect(group.open_threads[0].status).toBe("idle");
  });

  it("overlays completion timestamps from live status metadata", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 10,
              last_active_at: 10,
              status: "running",
              is_unread: false,
            }),
          ],
        },
      ],
      new Set(),
      true,
      null,
      new Map([
        [
          "thread_1",
          {
            status: "unread",
            completedAt: 20,
            summaryStatus: "ready",
            summary: "Generated summary",
          },
        ],
      ]),
    );

    expect(group.status).toBe("unread");
    expect(group.open_threads[0].last_assistant_completed_at).toBe(20);
    expect(group.open_threads[0].last_assistant_summary).toBe("Generated summary");
    expect(group.open_threads[0].last_assistant_summary_status).toBe("ready");
    expect(group.open_threads[0].updated_at).toBe(20);
    expect(group.open_threads[0].last_active_at).toBe(20);
  });

  it("overlays optimistic latest user messages while running", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 10,
              last_active_at: 10,
              last_user_message_at: 10,
              status: "idle",
              latest_user_message: "stale prompt",
            }),
          ],
        },
      ],
      new Set(),
      true,
      null,
      new Map([
        [
          "thread_1",
          {
            status: "running",
            latestUserMessage: "fresh prompt",
            latestUserMessageAt: 20,
          },
        ],
      ]),
    );

    expect(group.status).toBe("running");
    expect(group.open_threads[0].status).toBe("running");
    expect(group.open_threads[0].latest_user_message).toBe("fresh prompt");
    expect(group.open_threads[0].latest_user_message_at).toBe(20);
    expect(group.open_threads[0].last_user_message_at).toBe(10);
  });

  it("overlays first user messages from live metadata without dropping latest message data", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 10,
              last_active_at: 10,
              status: "idle",
              first_user_message: "stale first prompt",
              latest_user_message: "stale latest prompt",
            }),
          ],
        },
      ],
      new Set(),
      true,
      null,
      new Map([
        [
          "thread_1",
          {
            status: "running",
            firstUserMessage: "fresh first prompt",
            latestUserMessage: "fresh latest prompt",
            latestUserMessageAt: 20,
          },
        ],
      ]),
    );

    expect(group.open_threads[0].first_user_message).toBe("fresh first prompt");
    expect(group.open_threads[0].latest_user_message).toBe("fresh latest prompt");
    expect(group.open_threads[0].latest_user_message_at).toBe(20);
  });

  it("overlays live running activity metadata while running", () => {
    const [group] = applyLiveRunningStatuses(
      [groupView],
      new Set(),
      true,
      null,
      new Map([
        [
          "thread_1",
          {
            status: "running",
            runningActivityText: "Running typecheck...",
            runningActivityAt: 40,
            runningStartedAt: 30,
          },
        ],
      ]),
    );

    expect(group.status).toBe("running");
    expect(group.open_threads[0].running_activity_text).toBe("Running typecheck...");
    expect(group.open_threads[0].running_activity_at).toBe(40);
    expect(group.open_threads[0].running_started_at).toBe(30);
    expect(group.open_threads[0].last_active_at).toBe(40);
  });
});
