import { useState } from "react";
import type { Conversation } from "../../lib/api/slack-channels";
import {
  createSection,
  deleteSection,
  moveChannelToSection,
  moveSection,
  renameSection,
  setChannelsHidden,
  sidebarGroups,
  useHiddenChannels,
  useChannelSections,
  type ChannelSection,
  type SidebarGroup,
} from "../../lib/channel-sections";
import { useChannelDrafts } from "../../lib/channel-drafts";
import { cn } from "../../ui/cn";
import { useConfirm } from "../../ui/confirm";
import { ListRow } from "../../ui/list-row";
import { ContextMenu, MENU_ICON, Menu } from "../../ui/menu";
import { InlineAlert, ListSkeleton } from "../../ui/state";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconFolderPlus,
  IconHash,
  IconLock,
  IconMessages,
  IconPencil,
  IconSend,
  IconTrash,
  IconX,
} from "../icons";
import { RenameDialog } from "../RenameDialog";
import {
  SidebarToolRowBody,
  sidebarToolRowClass,
} from "../sidebar/SidebarToolsNav";
import { UserAvatar } from "../UserAvatar";

/** A conversation's leading mark: `#`, a lock, or the person's photo. */
export function ConversationGlyph({
  conversation,
  size = 22,
}: {
  conversation: Pick<Conversation, "kind" | "name" | "avatarUrl">;
  size?: number;
}) {
  if (conversation.kind === "dm")
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center"
        style={{ width: size, height: size }}
      >
        <UserAvatar
          name={conversation.name}
          image={conversation.avatarUrl}
          size={size - 2}
          className="rounded-sm"
        />
      </span>
    );
  if (conversation.kind === "group")
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-sm bg-hover text-meta font-semibold text-dim tabular-nums"
        style={{ width: size - 2, height: size - 2, margin: 1 }}
        aria-hidden
      >
        {conversation.name.split(",").length}
      </span>
    );
  const Glyph = conversation.kind === "private" ? IconLock : IconHash;
  return <Glyph size={size} className="shrink-0 text-faint" />;
}

const PAGES = [
  { id: "threads", label: "Threads", icon: <IconMessages /> },
  { id: "drafts", label: "Drafts & sent", icon: <IconSend /> },
] as const;

/** Threads and Drafts & sent, above the sections, as the tools sit above
 *  the session list. Drafts counts what is waiting to be sent. */
function PageRows({
  activeId,
  onOpen,
}: {
  activeId?: string;
  onOpen: (id: string) => void;
}) {
  const drafts = useChannelDrafts().length;
  return (
    <div className="flex flex-col gap-0.5 pb-3">
      {PAGES.map((page) => {
        const active = page.id === activeId;
        return (
          <ListRow
            key={page.id}
            className={cn(
              sidebarToolRowClass(active),
              active ? "hover:bg-selected" : "hover:bg-transparent",
            )}
            aria-current={active ? "page" : undefined}
            onClick={() => onOpen(page.id)}
          >
            <SidebarToolRowBody
              icon={page.icon}
              label={page.label}
              count={page.id === "drafts" ? drafts : undefined}
              active={active}
            />
          </ListRow>
        );
      })}
    </div>
  );
}

/** What the name dialog is doing: naming a new section (with the
 *  conversation it was asked for from), or renaming one. */
type Naming =
  | { mode: "new"; channelId?: string; draft: string }
  | { mode: "rename"; id: string; draft: string };

const SUB_ARROW = <IconChevronRight size={16} className="text-faint" />;

function ConversationRow({
  conversation,
  active,
  sections,
  inSection,
  hidden,
  onOpen,
  onNewSection,
}: {
  conversation: Conversation;
  active: boolean;
  /** It sits under Hidden. */
  hidden: boolean;
  sections: readonly ChannelSection[];
  /** The section of your own it sits in. */
  inSection?: string;
  onOpen: (id: string) => void;
  onNewSection: (channelId: string) => void;
}) {
  const unread = !!conversation.unread;
  const targets = sections.filter((section) => section.id !== inSection);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <ListRow
            className={cn(
              sidebarToolRowClass(active),
              active ? "hover:bg-selected" : "hover:bg-transparent",
              unread && !active && "font-semibold text-fg",
            )}
            aria-current={active ? "page" : undefined}
            onClick={() => onOpen(conversation.id)}
          />
        }
      >
        <ConversationGlyph conversation={conversation} />
        <span className="min-w-0 flex-1 truncate">{conversation.name}</span>
        {!!conversation.unreadCount && (
          <span
            className="ml-auto rounded-full bg-accent px-1.5 text-meta leading-[18px] font-semibold text-on-accent tabular-nums"
            aria-label={`${conversation.unreadCount} unread`}
          >
            {conversation.unreadCount}
          </span>
        )}
      </ContextMenu.Trigger>
      <ContextMenu.Popup>
        <ContextMenu.SubmenuRoot>
          <ContextMenu.SubmenuTrigger>
            <IconFolderPlus size={20} className={MENU_ICON} />
            <span className="grow">Move to section</span>
            {SUB_ARROW}
          </ContextMenu.SubmenuTrigger>
          <Menu.Popup className="min-w-[180px]">
            {targets.map((section) => (
              <Menu.Item
                key={section.id}
                onClick={() =>
                  moveChannelToSection(conversation.id, section.id)
                }
              >
                <span className="grow truncate">
                  {section.emoji ? `${section.emoji} ` : ""}
                  {section.name}
                </span>
              </Menu.Item>
            ))}
            {targets.length > 0 && <Menu.Separator />}
            <Menu.Item onClick={() => onNewSection(conversation.id)}>
              <span className="grow">New section…</span>
            </Menu.Item>
          </Menu.Popup>
        </ContextMenu.SubmenuRoot>
        {inSection && (
          <ContextMenu.Item
            onClick={() => moveChannelToSection(conversation.id, null)}
          >
            <IconX size={20} className={MENU_ICON} />
            <span className="grow">Remove from section</span>
          </ContextMenu.Item>
        )}
        <ContextMenu.Separator />
        <ContextMenu.Item
          onClick={() => setChannelsHidden([conversation.id], !hidden)}
        >
          {hidden ? (
            <IconEye size={20} className={MENU_ICON} />
          ) : (
            <IconEyeOff size={20} className={MENU_ICON} />
          )}
          <span className="grow">{hidden ? "Show in sidebar" : "Hide"}</span>
        </ContextMenu.Item>
      </ContextMenu.Popup>
    </ContextMenu.Root>
  );
}

function Group({
  group,
  index,
  sectionCount,
  sections,
  activeId,
  onOpen,
  touch,
  onNewSection,
  onRename,
  onDelete,
}: {
  group: SidebarGroup;
  index: number;
  sectionCount: number;
  sections: readonly ChannelSection[];
  activeId?: string;
  onOpen: (id: string) => void;
  touch: boolean;
  onNewSection: (channelId?: string) => void;
  onRename: (section: ChannelSection) => void;
  onDelete: (section: ChannelSection) => void;
}) {
  // Hidden starts folded: it is there to find things, not to read.
  const [open, setOpen] = useState(group.key !== "hidden");
  const section = group.section;
  const ids = group.rows.map((row) => row.id);
  // A built-in group with nothing left in it has nothing to say; an empty
  // section of your own stays, so you can see where to move things.
  if (!group.rows.length && !section) return null;
  return (
    <div className="mt-3 first:mt-1">
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={
            <ListRow
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className={cn(
                // The session list's new-layout lane caption (LANE_NEW_LAYOUT
                // in sidebar-classes): the rows' size and weight, in muted ink.
                "items-center gap-1 py-0 px-[calc(var(--sidebar-icon-left,16px)-var(--sidebar-nav-x,10px))] text-body font-medium text-dim hover:bg-transparent hover:text-fg desktop:text-item-title",
                touch ? "min-h-11" : "h-[var(--sidebar-cap-h,28px)] min-h-0",
              )}
            />
          }
        >
          {group.emoji && <span aria-hidden>{group.emoji}</span>}
          <span className="min-w-0 truncate">{group.title}</span>
          {group.key === "hidden" && (
            <span className="font-normal text-faint tabular-nums">
              {ids.length}
            </span>
          )}
          <IconChevronDown
            size={16}
            className={cn(
              "shrink-0 text-faint transition-transform",
              !open && "-rotate-90",
            )}
          />
        </ContextMenu.Trigger>
        <ContextMenu.Popup>
          {section && (
            <>
              <ContextMenu.Item onClick={() => onRename(section)}>
                <IconPencil size={20} className={MENU_ICON} />
                <span className="grow">Rename section</span>
              </ContextMenu.Item>
              {index > 0 && (
                <ContextMenu.Item onClick={() => moveSection(section.id, -1)}>
                  <IconArrowUp size={20} className={MENU_ICON} />
                  <span className="grow">Move up</span>
                </ContextMenu.Item>
              )}
              {index < sectionCount - 1 && (
                <ContextMenu.Item onClick={() => moveSection(section.id, 1)}>
                  <IconArrowDown size={20} className={MENU_ICON} />
                  <span className="grow">Move down</span>
                </ContextMenu.Item>
              )}
            </>
          )}
          <ContextMenu.Item onClick={() => onNewSection()}>
            <IconFolderPlus size={20} className={MENU_ICON} />
            <span className="grow">New section…</span>
          </ContextMenu.Item>
          {group.key === "channels" && (
            <ContextMenu.Item onClick={() => setChannelsHidden(ids, true)}>
              <IconEyeOff size={20} className={MENU_ICON} />
              <span className="grow">Hide all {ids.length}</span>
            </ContextMenu.Item>
          )}
          {group.key === "hidden" && (
            <ContextMenu.Item onClick={() => setChannelsHidden(ids, false)}>
              <IconEye size={20} className={MENU_ICON} />
              <span className="grow">Show all in sidebar</span>
            </ContextMenu.Item>
          )}
          {section && (
            <>
              <ContextMenu.Separator />
              <ContextMenu.Item
                onClick={() => onDelete(section)}
                className="text-red data-[highlighted]:bg-red-soft"
              >
                <IconTrash size={20} className="text-red" />
                <span className="grow">Delete section</span>
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Popup>
      </ContextMenu.Root>
      {open && (
        <div className="flex flex-col gap-0.5">
          {group.rows.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === activeId}
              sections={sections}
              inSection={section?.id}
              hidden={group.key === "hidden"}
              onOpen={onOpen}
              onNewSection={onNewSection}
            />
          ))}
          {section && !group.rows.length && (
            <p className="px-[calc(var(--sidebar-icon-left,16px)-var(--sidebar-nav-x,10px))] py-1 text-meta text-faint">
              Right-click a channel to move it here
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A person's Slack sidebar: their own sections first (Start, Projects, ...),
 * then the other channels, then direct and group messages, with unread ones
 * in bold and a count on a direct message, as Slack shows them. Right-click a
 * row, or long-press it on a touch screen, to move it between sections.
 */
export function ConversationList({
  conversations,
  activeId,
  loading,
  error,
  onOpen,
  touch = false,
}: {
  conversations: readonly Conversation[];
  activeId?: string;
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
  /** Phone rows: 44px targets. */
  touch?: boolean;
}) {
  const sections = useChannelSections();
  const hidden = useHiddenChannels();
  const [naming, setNaming] = useState<Naming | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  if (loading)
    return (
      <div className="pb-4">
        <PageRows activeId={activeId} onOpen={onOpen} />
        <ListSkeleton rows={8} variant="bare" className="px-2" />
      </div>
    );
  if (error && !conversations.length)
    return (
      <div className="pb-4">
        <PageRows activeId={activeId} onOpen={onOpen} />
        <InlineAlert appearance="plain" className="mx-3 my-4">
          {error}
        </InlineAlert>
      </div>
    );
  const groups = sidebarGroups(conversations, sections, hidden, activeId);
  const commit = () => {
    if (!naming?.draft.trim()) return;
    if (naming.mode === "new") createSection(naming.draft, naming.channelId);
    else renameSection(naming.id, naming.draft);
    setNaming(null);
  };
  return (
    <div className="pb-4">
      <PageRows activeId={activeId} onOpen={onOpen} />
      {groups.map((group, index) => (
        <Group
          key={group.key}
          group={group}
          index={index}
          sectionCount={sections.length}
          sections={sections}
          activeId={activeId}
          onOpen={onOpen}
          touch={touch}
          onNewSection={(channelId) =>
            setNaming({ mode: "new", channelId, draft: "" })
          }
          onRename={(section) =>
            setNaming({ mode: "rename", id: section.id, draft: section.name })
          }
          onDelete={(section) =>
            confirm({
              title: `Delete ${section.name}?`,
              description:
                "Its channels go back under Channels and Direct messages.",
              confirmLabel: "Delete",
              destructive: true,
              onConfirm: () => deleteSection(section.id),
            })
          }
        />
      ))}
      <RenameDialog
        title={naming?.mode === "rename" ? "Rename section" : "New section"}
        submitLabel={naming?.mode === "rename" ? "Rename" : "Create"}
        placeholder="Projects"
        draft={naming?.draft ?? null}
        onDraftChange={(draft) => naming && setNaming({ ...naming, draft })}
        onCommit={commit}
        onCancel={() => setNaming(null)}
      />
      {confirmDialog}
    </div>
  );
}
