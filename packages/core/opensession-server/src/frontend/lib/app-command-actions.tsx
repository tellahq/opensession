import type { CommandPaletteAction } from "../components/SessionSearch";
import type { useAuthStatus } from "../components/UserPicker";
import {
  IconArchive,
  IconBook,
  IconChart,
  IconChevronRight,
  IconCopy,
  IconDesk,
  IconFeed,
  IconFile,
  IconGear,
  IconInbox,
  IconListCircles,
  IconMail,
  IconMoon,
  IconPlus,
  IconPullRequest,
  IconSidebarLeft,
  IconStack,
  IconUnarchive,
  IconWrench,
} from "../components/icons";
import type { useAppRoute } from "../hooks/useAppRoute";
import type { useSessionTabs } from "../hooks/useSessionTabs";
import { PRODUCT_NAME } from "./brand";
import { settingsPaletteActions } from "./settings-sections";
import { absoluteLink, copyToClipboard } from "./share-link";
import { shortcutPrimaryKeys } from "./shortcuts";
import { setThemePref, type EffectiveTheme } from "./theme";
import { copySessionTranscript } from "./transcript-copy";
import type { UnifiedSession } from "./types";

interface BuildAppCommandActionsOptions {
  auth: ReturnType<typeof useAuthStatus>;
  currentSession: UnifiedSession | null;
  currentTheme: EffectiveTheme;
  copyLinkPath: string | null;
  isPhone: boolean;
  nextChatAvailable: boolean;
  openNextChat: () => void;
  restorableArchived: UnifiedSession[];
  sidebarCollapsed: boolean;
  navigate: ReturnType<typeof useAppRoute>["navigate"];
  openPalette: () => void;
  handleNewSession: ReturnType<typeof useSessionTabs>["handleNewSession"];
  closeSession: ReturnType<typeof useSessionTabs>["closeSession"];
  unarchiveSession: ReturnType<typeof useSessionTabs>["unarchiveSession"];
  reopenLastArchived: ReturnType<typeof useSessionTabs>["reopenLastArchived"];
  setDeskOverlay: (next: {
    open: boolean;
    origin: "center" | "bottom-right";
  }) => void;
  toggleSidebarCollapsed: () => void;
  showToast: (message: string) => void;
}

export function buildAppCommandActions({
  auth,
  currentSession,
  currentTheme,
  copyLinkPath,
  isPhone,
  nextChatAvailable,
  openNextChat,
  restorableArchived,
  sidebarCollapsed,
  navigate,
  openPalette,
  handleNewSession,
  closeSession,
  unarchiveSession,
  reopenLastArchived,
  setDeskOverlay,
  toggleSidebarCollapsed,
  showToast,
}: BuildAppCommandActionsOptions): CommandPaletteAction[] {
  return [
    {
      id: "new-session",
      label: "New session",
      description: "Start a new ask or code session",
      category: "Actions",
      keywords: ["create", "session", "workspace"],
      shortcut: shortcutPrimaryKeys("session-new") ?? undefined,
      icon: <IconPlus size={18} />,
      run: () => openPalette(),
    },
    ...(currentSession
      ? [
          ...(!currentSession.desk
            ? [
                {
                  id: "new-session-workspace",
                  label: "New session in this workspace",
                  description: "Share the current workspace and worktree",
                  category: "Actions" as const,
                  keywords: ["tab", "conversation", "sibling"],
                  shortcut:
                    shortcutPrimaryKeys("session-new-sibling") ?? undefined,
                  icon: <IconPlus size={18} />,
                  run: () => void handleNewSession("share"),
                },
              ]
            : []),
          ...(nextChatAvailable
            ? [
                {
                  id: "next-unread-workspace",
                  label: "Next chat",
                  description:
                    "Open the next chat, prioritizing work that needs attention",
                  category: "Navigate" as const,
                  keywords: ["next", "unread", "ready", "attention"],
                  shortcut:
                    shortcutPrimaryKeys("workspace-next-unread") ?? undefined,
                  icon: <IconChevronRight size={18} />,
                  run: openNextChat,
                },
              ]
            : []),
          {
            id: "copy-transcript",
            label: "Copy conversation",
            description: "Copy a concise version of the current transcript",
            category: "Actions" as const,
            keywords: ["transcript", "clipboard"],
            shortcut:
              shortcutPrimaryKeys("session-copy-transcript") ?? undefined,
            icon: <IconCopy size={18} />,
            run: () =>
              void copySessionTranscript(currentSession, "concise", showToast),
          },
          {
            id: currentSession.archived
              ? "unarchive-session"
              : "archive-session",
            label: currentSession.archived
              ? "Unarchive current session"
              : "Archive current session",
            description: currentSession.archived
              ? "Return this session to the active workspace"
              : "Close this session and keep it recoverable in Archived",
            category: "Actions" as const,
            keywords: currentSession.archived
              ? ["restore", "open"]
              : ["close", "remove"],
            shortcut: shortcutPrimaryKeys("session-archive") ?? undefined,
            icon: <IconArchive size={18} />,
            run: () =>
              void (currentSession.archived
                ? unarchiveSession(currentSession)
                : closeSession(currentSession)),
          },
        ]
      : []),
    ...(restorableArchived.length
      ? [
          {
            id: "reopen-archived",
            label: "Reopen closed session",
            description:
              restorableArchived.length > 1
                ? `Bring back the ${restorableArchived.length} sessions you just archived`
                : `Bring back "${restorableArchived[0].title || "the session you just archived"}"`,
            category: "Actions" as const,
            keywords: ["unarchive", "restore", "undo", "closed", "reopen"],
            shortcut: shortcutPrimaryKeys("session-reopen") ?? undefined,
            icon: <IconUnarchive size={18} />,
            run: () => void reopenLastArchived(),
          },
        ]
      : []),
    ...(copyLinkPath
      ? [
          {
            id: "copy-link",
            label: "Copy link to current view",
            description:
              "Copy a shareable link to this session, workspace, or PR",
            category: "Actions" as const,
            keywords: ["url", "share", "clipboard"],
            shortcut: shortcutPrimaryKeys("session-copy-link") ?? undefined,
            icon: <IconCopy size={18} />,
            run: () =>
              copyToClipboard(absoluteLink(copyLinkPath), () =>
                showToast("Link copied"),
              ),
          },
        ]
      : []),
    {
      id: "tasks",
      label: "Tasks",
      description: "Open your task list",
      category: "Actions",
      keywords: ["todos", "tasks"],
      icon: <IconListCircles size={18} />,
      run: () => navigate({ view: "tasks" }),
    },
    {
      id: "desk",
      label: "Open Desk",
      description: "Open the standing concierge session",
      category: "Actions",
      keywords: ["concierge", "assistant"],
      shortcut: shortcutPrimaryKeys("desk") ?? undefined,
      icon: <IconDesk size={18} />,
      run: () => setDeskOverlay({ open: true, origin: "center" }),
    },
    {
      id: "toggle-sidebar",
      label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
      description: "Toggle the workspace sidebar",
      category: "Actions",
      keywords: ["toggle", "panel", "navigation"],
      shortcut: shortcutPrimaryKeys("sidebar-toggle") ?? undefined,
      icon: <IconSidebarLeft size={18} />,
      run: toggleSidebarCollapsed,
    },
    {
      id: "toggle-theme",
      label: `Switch to ${currentTheme === "dark" ? "light" : "dark"} mode`,
      description: `Current appearance: ${currentTheme}`,
      category: "Actions",
      keywords: ["toggle", "theme", "appearance", "dark", "light"],
      icon: <IconMoon size={18} />,
      run: () => setThemePref(currentTheme === "dark" ? "light" : "dark"),
    },
    {
      id: "system-theme",
      label: "Use system appearance",
      description: "Match your device's light or dark mode",
      category: "Actions",
      keywords: ["system", "automatic", "theme", "appearance"],
      icon: <IconMoon size={18} />,
      run: () => setThemePref("system"),
    },
    {
      id: "prs",
      label: "Pull requests",
      description: "Open the pull request list",
      category: "Navigate",
      icon: <IconPullRequest size={18} />,
      run: () => navigate({ view: "prs" }),
    },
    {
      id: "feed",
      label: "Feed",
      description: "Open what the team has been shipping",
      category: "Navigate",
      icon: <IconFeed size={18} />,
      run: () => navigate({ view: "feed" }),
    },
    // Catch up is offered at phone widths only (lib/sidebar-tools.ts), so
    // the palette doesn't offer it where the sidebar doesn't.
    ...(isPhone
      ? ([
          {
            id: "catch-up",
            label: "Catch up",
            description: "Swipe through unread workspaces",
            category: "Navigate",
            keywords: ["unread", "inbox"],
            icon: <IconStack size={18} />,
            run: () => navigate({ view: "catchup" }),
          },
        ] satisfies CommandPaletteAction[])
      : []),
    ...(isPhone
      ? ([
          {
            id: "support-tinder",
            label: "Support Tinder",
            description: "Triage the Plain todo queue",
            category: "Navigate",
            keywords: ["tickets", "plain", "support"],
            icon: <IconInbox size={18} />,
            run: () => navigate({ view: "supporttinder" }),
          },
        ] satisfies CommandPaletteAction[])
      : []),
    {
      id: "support",
      label: "Support",
      description: "Read and answer Plain tickets",
      category: "Navigate",
      keywords: ["tickets", "plain", "inbox"],
      icon: <IconMail size={18} />,
      run: () => navigate({ view: "plain" }),
    },
    {
      id: "reports",
      label: "Reports",
      description: "Open recurring automation reports",
      category: "Navigate",
      icon: <IconFile size={18} />,
      run: () => navigate({ view: "reports" }),
    },
    {
      id: "analytics",
      label: "Analytics",
      description: "Sessions, tokens, models, and PRs over time",
      category: "Navigate",
      icon: <IconChart size={18} />,
      run: () => navigate({ view: "analytics" }),
    },
    {
      id: "reviews",
      label: "Reviews",
      description: "Open the pull request review queue",
      category: "Navigate",
      keywords: ["pull requests", "code review"],
      icon: <IconListCircles size={18} />,
      run: () => navigate({ view: "reviews" }),
    },
    {
      id: "automations",
      label: "Automations",
      description: "Manage scheduled and event-triggered routines",
      category: "Navigate",
      keywords: ["routines", "scheduled"],
      icon: <IconWrench size={18} />,
      run: () => navigate({ view: "automations" }),
    },
    {
      id: "goals",
      label: "Goals",
      description: "Manage long-running missions",
      category: "Navigate",
      icon: <IconListCircles size={18} />,
      run: () => navigate({ view: "goals" }),
    },
    {
      id: "security",
      label: "Security",
      description: "Open security scans and findings",
      category: "Navigate",
      icon: <IconBook size={18} />,
      run: () => navigate({ view: "security" }),
    },
    {
      id: "archived",
      label: "Archived",
      description: "Browse closed conversations",
      category: "Navigate",
      keywords: ["history", "closed"],
      icon: <IconArchive size={18} />,
      run: () => navigate({ view: "archived" }),
    },
    {
      id: "settings",
      label: "Settings",
      description: `Configure ${PRODUCT_NAME}`,
      category: "Navigate",
      keywords: ["preferences", "appearance", "connections"],
      icon: <IconGear size={18} />,
      run: () => navigate({ view: "settings" }),
    },
    // Every Settings section, straight from the nav's own table — the palette
    // used to reach three of them, and only because those three happen to have
    // their own top-level routes.
    ...settingsPaletteActions({ admin: auth?.admin !== false }).map(
      ({ section, ...action }) => ({
        ...action,
        run: () => navigate({ view: "settings", section }),
      }),
    ),
  ];
}
