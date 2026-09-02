import React, { useEffect, useRef, useState } from "react";
import { useShortcutLabel } from "../hooks/useShortcutBindings";
import { Reorder, useReducedMotion } from "motion/react";
import type { UnifiedSession } from "../lib/types";
import { TAB_COLORS, colorHex } from "../lib/tab-colors";
import { Menu, ContextMenu, MENU_ICON } from "../ui/menu";
import { sessionPath, absoluteLink, copyToClipboard } from "../lib/share-link";
import { copySessionTranscript } from "../lib/transcript-copy";
import {
  IconChevronRight,
  IconCopy,
  IconFile,
  IconHistory,
  IconLink,
  IconListCircles,
  IconPencil,
  IconPlus,
  IconSidebarLeft,
  IconSidebarRight,
  IconTrash,
  IconX,
} from "./icons";
import { ArchivedSessionItems } from "./ArchivedSessionItems";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { useIsPhone } from "../hooks/useIsPhone";
import { UserAvatar } from "./UserAvatar";
import {
  PANEL_TAB_DOT,
  TAB_ACTIONS,
  TAB_DROP_SLOT,
  TAB_FACE,
  TAB_FACES,
  TAB_FACES_MORE,
  TAB_GROUP,
  TAB_HISTORY,
  TAB_ITEM,
  TAB_ITEM_DRAGGING,
  TAB_NEW,
  TAB_RENAME,
  TAB_SCROLL,
  TAB_STRIP,
  TAB_SWATCH,
  TAB_SWATCH_NONE,
  TAB_SWATCH_ON,
  TAB_TITLE,
  TAB_VICON,
  tabClass,
  tabCloseClass,
  tabDotClass,
} from "../lib/session-tab-classes";
import { cn } from "../ui/cn";
import {
  animateEmptyTabClose,
  animateEmptyTabOpen,
} from "./session-tabs/empty-tab-morph";
import { useTabReorder } from "./session-tabs/useTabReorder";
import { SessionDraftIndicator } from "./session-tabs/SessionDraftIndicator";
import { shouldShowTabStrip } from "../lib/split-tabs";
import type { SessionTabsProps, ViewTab } from "../lib/session-tabs-types";

interface SessionTabStyle extends React.CSSProperties {
  "--tab-color"?: string;
}

/**
 * The tab strip is scoped to ONE Workspace: it shows the sibling sessions of the
 * currently-open session (every session sharing its `workspaceId`/workspace). It
 * renders once a workspace has TWO or more sessions, or has a pane or a closed
 * session to offer. A lone session with nothing else needs no strip, so the
 * "+ New tab" affordance moves next to the session title in SessionViewer's
 * header instead (and ⌘⌥N does the same thing). A pre-migration standalone
 * session (empty list) likewise renders nothing.
 *
 * There is no pinning here anymore (pinning moved to the sidebar). Right-click
 * opens a context menu (rename / copy concise or full transcript / copy link /
 * tab color / close / delete); double-click the title also renames the session. The +
 * button starts a new session in this workspace sharing its worktree;
 * right-clicking + offers the other modes (stacked worktree / ask).
 *
 * Sessions and view panes (Review, Assets, …) are ONE draggable row: every tab is
 * a Reorder.Item, so a pane can be dragged among the sessions and the whole
 * arrangement is what the parent persists per workspace.
 */
/**
 * A non-session pane (Review, …) surfaced in the strip. It starts after the session
 * tabs and is draggable from there like any session tab.
 */
type TabMember =
  | { kind: "session"; id: string; session: UnifiedSession }
  | { kind: "view"; id: string; view: ViewTab };

function ReorderTabItem({
  tabKey,
  nextActive,
  draggable,
  dragging,
  onPointerDown,
  onDragStart,
  onDragEnd,
  onClickCapture,
  children,
}: {
  tabKey: string;
  nextActive: boolean;
  draggable: boolean;
  dragging: boolean;
  onPointerDown: (key: string, event: React.PointerEvent) => void;
  onDragStart: (key: string) => void;
  onDragEnd: (key: string) => void;
  onClickCapture: (event: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <Reorder.Item
      as="div"
      value={tabKey}
      data-tab-key={tabKey}
      data-next-active={nextActive ? "" : undefined}
      dragListener={draggable}
      onPointerDown={(event) => onPointerDown(tabKey, event)}
      onDragStart={() => onDragStart(tabKey)}
      onDragEnd={() => onDragEnd(tabKey)}
      whileDrag={{ scale: 1.02, zIndex: 3 }}
      onClickCapture={onClickCapture}
      className={dragging ? `${TAB_ITEM} ${TAB_ITEM_DRAGGING}` : TAB_ITEM}
    >
      {children}
    </Reorder.Item>
  );
}

/** Apply the edge fade only when the title is genuinely clipped. Keeping this
 * as a DOM attribute avoids rerendering the full tab strip for presentation. */
function TabTitle({
  children,
  onDoubleClick,
}: {
  children: React.ReactNode;
  onDoubleClick?: React.MouseEventHandler<HTMLSpanElement>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const title = ref.current;
    if (!title) return;
    const sync = () =>
      title.toggleAttribute(
        "data-overflow",
        title.scrollWidth - title.clientWidth > 1,
      );
    const observer = new ResizeObserver(sync);
    observer.observe(title);
    sync();
    return () => observer.disconnect();
  }, [children]);

  return (
    <span ref={ref} className={TAB_TITLE} onDoubleClick={onDoubleClick}>
      {children}
    </span>
  );
}

export function SessionTabs({
  content,
  layout = {},
  actions,
}: SessionTabsProps) {
  const {
    sessions: tabs,
    archivedSessions: archived,
    activeSessionId: activeId,
    colors,
    viewers,
    order: tabOrder,
    views: viewTabs,
  } = content;
  const {
    inSplit,
    showHistory = true,
    emptySessionId,
    morphingSessionId,
    morphOrigin,
    moveAcrossSide,
  } = layout;
  const {
    selectSession: onSelect,
    setColor: onSetColor,
    reorder: onReorderTabs,
    previewSplit: onSplitDrag,
    dropIntoSplit: onSplitDrop,
    moveAcross: onMoveAcross,
    selectView: onSelectView,
    closeView: onCloseView,
    newSession: onNewSession,
    rename: onRename,
    close: onClose,
    delete: onDelete,
    restore: onRestore,
    toast: onToast,
  } = actions;
  const copyTranscriptLabel = useShortcutLabel("session-copy-transcript");
  const closeLabel = useShortcutLabel("session-close");
  const reducedMotion = useReducedMotion();
  const [editKey, setEditKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<UnifiedSession | null>(null);
  const [deleting, setDeleting] = useState(false);
  // On phones the +/history controls ride INSIDE the scroll (see below) so the
  // tab strip claims the full width instead of losing it to pinned chrome; on
  // desktop they stay pinned after the last tab. Icons run a touch bigger on
  // touch for an easier hit.
  const isPhone = useIsPhone();
  const ctrlIconSize = isPhone ? 23 : 20;

  // A lone unsplit tab has nowhere to move. Split bars remain draggable so their
  // final tab can cross into the other column.
  const tabDragEnabled =
    !isPhone && (inSplit || tabs.length + viewTabs.length > 1);
  const {
    draftOrder,
    dropSlot,
    groupRef,
    handleReorder,
    handleItemPointerDown,
    handleItemDragStart,
    handleItemDragEnd,
    handleItemClickCapture,
  } = useTabReorder({
    enabled: tabDragEnabled,
    editingId: editKey,
    onReorder: onReorderTabs,
    onSplitDrag,
    onSplitDrop,
  });

  // Sessions and view panes are one draggable row: the same drag that moves a
  // session moves Review or Assets, and a pane can end up anywhere among the
  // sessions. Natural order (sessions, then panes in the order the parent built
  // them) is the fallback; the arrangement is the in-flight drag draft while
  // dragging, else the parent's saved `tabOrder`. A tab that arrives mid-drag
  // — or that no order mentions yet — keeps its natural place at the end
  // rather than being dropped.
  const members: TabMember[] = [
    ...tabs.map((session): TabMember => ({
      kind: "session",
      id: session.id,
      session,
    })),
    ...viewTabs.map((view): TabMember => ({ kind: "view", id: view.id, view })),
  ];
  const rank = new Map(
    (draftOrder ?? tabOrder).map((id, i) => [id, i] as const),
  );
  const orderedMembers = members
    .map((member, natural) => ({ member, natural }))
    .sort((a, b) => {
      const ra = rank.get(a.member.id);
      const rb = rank.get(b.member.id);
      if (ra === rb) return a.natural - b.natural;
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    })
    .map((entry) => entry.member);
  const orderedKeys = orderedMembers.map((member) => member.id);
  const activeTopId =
    activeId ?? viewTabs.find((tab) => tab.active)?.id ?? null;

  // With enough tabs the strip overflows and scrolls, so the tab that just
  // became active can sit outside the visible window — opening a Review pane
  // would foreground a tab you can't see. Nudge it just inside the edge (not
  // centered) so its neighbours stay as context. Keyed on the selection only:
  // re-running as sibling tabs come and go would yank the strip back while
  // someone is scrolled away reading it.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || !activeTopId) return;
    const tab = box.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!tab) return;
    const view = box.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    // Clear the edge fade so the tab doesn't come to rest under it.
    const pad = 28;
    const shortLeft = rect.left - (view.left + pad);
    const shortRight = rect.right - (view.right - pad);
    const by = shortLeft < 0 ? shortLeft : shortRight > 0 ? shortRight : 0;
    if (!by) return;
    box.scrollBy({
      left: by,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [activeTopId]);

  // Flag whether the strip actually has anywhere to scroll, which gates its
  // edge fades. Those are driven by a CSS scroll timeline, and a timeline that
  // goes INACTIVE (closing a tab, widening the pane until everything fits)
  // holds its last value instead of reverting — without this gate a strip that
  // no longer scrolls keeps a stale fade dimming its first tab. Written
  // straight to the DOM rather than through state: it's presentation only, and
  // re-rendering the strip on every step of a pane drag would be wasteful.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const sync = () =>
      box.toggleAttribute(
        "data-overflow",
        box.scrollWidth - box.clientWidth > 1,
      );
    // The box catches pane resizes; its children catch the content growing
    // (a tab added, or a title that got longer).
    const observer = new ResizeObserver(sync);
    observer.observe(box);
    for (const child of box.children) observer.observe(child);
    sync();
    return () => observer.disconnect();
  }, [tabs.length, viewTabs.length]);

  function commitRename() {
    if (editKey !== null) onRename(editKey, draft.trim());
    setEditKey(null);
  }

  async function deleteSession(cleanWorktree: boolean) {
    if (!deleteTarget || !onDelete || deleting) return;
    setDeleting(true);
    const deleted = await Promise.resolve()
      .then(() => onDelete(deleteTarget, cleanWorktree))
      .then(() => true)
      .catch((error) => {
        onToast(error instanceof Error ? error.message : "Delete failed");
        return false;
      });
    setDeleting(false);
    if (deleted) setDeleteTarget(null);
  }

  // Closed sessions of this workspace, if there are any to offer.
  const hasHistory = showHistory && archived.length > 0;

  // One tab of either kind → no strip. The pane header already names a lone
  // Chat, Review or other view, and carries the + that the hidden strip would
  // have owned. A session plus Review remains a real two-way choice.
  if (!shouldShowTabStrip(tabs.length + viewTabs.length, inSplit)) return null;

  function closeEmptySession(
    button: HTMLButtonElement,
    session: UnifiedSession,
  ) {
    if (!reducedMotion && !isPhone) animateEmptyTabClose(button);
    onClose(session);
  }

  // Plain-click shares the workspace worktree. The standard context menu owns
  // right-click positioning, dismissal, focus and keyboard behavior.
  const newTabButton = onNewSession && (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <button
            type="button"
            className={cn(TAB_NEW, "relative z-[1]")}
            aria-label="New session in this workspace"
            title="New session. Shares this workspace's worktree (right-click for options)"
            onClick={(event) => {
              const animate = event.detail > 0 && !reducedMotion && !isPhone;
              const rect = animate
                ? event.currentTarget.getBoundingClientRect()
                : null;
              onNewSession(
                "share",
                rect
                  ? {
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height,
                    }
                  : undefined,
              );
            }}
          />
        }
      >
        <IconPlus size={ctrlIconSize} />
      </ContextMenu.Trigger>
      <ContextMenu.Popup className="min-w-[250px]">
        <ContextMenu.Item onClick={() => onNewSession("share")}>
          New session · share worktree
        </ContextMenu.Item>
        <ContextMenu.Item onClick={() => onNewSession("stack")}>
          New session · stacked worktree
        </ContextMenu.Item>
        <ContextMenu.Item onClick={() => onNewSession("ask")}>
          New session · ask (no worktree)
        </ContextMenu.Item>
      </ContextMenu.Popup>
    </ContextMenu.Root>
  );

  // History: every archived (closed) session of this workspace, in one list.
  // Clicking a row opens the session read-only-ish (it gets a tab while viewed);
  // the ⟲ restores it into the strip for good.
  const historyMenu = hasHistory && (
    <Menu.Root>
      <Menu.Trigger
        className={TAB_HISTORY}
        aria-label="Archived sessions"
        title="Archived sessions"
      >
        <IconHistory size={ctrlIconSize} />
      </Menu.Trigger>
      <Menu.Popup
        align="end"
        sideOffset={4}
        className="min-w-[240px] max-w-[320px]"
      >
        <ArchivedSessionItems
          sessions={archived}
          onSelect={onSelect}
          onRestore={onRestore}
        />
      </Menu.Popup>
    </Menu.Root>
  );

  return (
    <div
      className={cn(TAB_STRIP, !inSplit && "desktop:-mt-[11px]")}
      role="tablist"
    >
      <div
        className={TAB_SCROLL}
        data-split={inSplit ? "" : undefined}
        ref={scrollRef}
      >
        <Reorder.Group
          as="div"
          axis="x"
          ref={groupRef}
          className={TAB_GROUP}
          values={orderedKeys}
          onReorder={handleReorder}
        >
          {/* First child so the tabs sliding over it paint on top. */}
          {dropSlot && (
            <div
              className={TAB_DROP_SLOT}
              style={{
                left: dropSlot.left,
                width: dropSlot.width,
              }}
              aria-hidden="true"
            />
          )}
          {orderedMembers.map((member, memberIndex) => {
            const key = member.id;
            // A separator belongs only between two inactive tabs. The active
            // surface supplies both of its own edges.
            const nextActive =
              orderedMembers[memberIndex + 1]?.id === activeTopId;
            // A view pane (Review, Assets, …): the same draggable item as a
            // session, minus the rename/color/transcript menu it has no use for.
            if (member.kind === "view") {
              const v = member.view;
              return (
                <ReorderTabItem
                  key={key}
                  tabKey={key}
                  nextActive={nextActive}
                  draggable={tabDragEnabled && editKey !== key}
                  dragging={dropSlot?.key === key}
                  onPointerDown={handleItemPointerDown}
                  onDragStart={handleItemDragStart}
                  onDragEnd={handleItemDragEnd}
                  onClickCapture={handleItemClickCapture}
                >
                  <div
                    role="tab"
                    aria-selected={v.active}
                    aria-label={v.icon ? v.label : undefined}
                    className={`session-tab-view group/tab ${tabClass({ active: v.active, waiting: false, colored: false })}`}
                    onClick={() => onSelectView(v.id)}
                    title={v.label}
                  >
                    {v.dotClass && (
                      <span className={`${PANEL_TAB_DOT} ${v.dotClass}`} />
                    )}
                    {v.icon ? (
                      <span
                        className={cn(
                          TAB_VICON,
                          v.closable !== false && "desktop:mr-3.5",
                        )}
                        aria-hidden="true"
                      >
                        {v.icon}
                      </span>
                    ) : (
                      <TabTitle>{v.label}</TabTitle>
                    )}
                    {v.closable !== false && (
                      <button
                        type="button"
                        className={tabCloseClass(isPhone)}
                        aria-label={`Close ${v.label}`}
                        title={`Close ${v.label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onCloseView(v.id);
                        }}
                      >
                        <IconX size={16} dense aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </ReorderTabItem>
              );
            }
            const session = member.session;
            const waiting = !!session.waitingForInput;
            const hex = colorHex(colors[key]);
            const empty = key === emptySessionId;
            const openingEmpty = key === morphingSessionId && !!morphOrigin;
            const emptyVisual = empty || openingEmpty;

            const titleContent =
              editKey === key ? (
                <input
                  className={TAB_RENAME}
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") setEditKey(null);
                    e.stopPropagation();
                  }}
                />
              ) : (
                <TabTitle
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setDraft(session.title);
                    setEditKey(key);
                  }}
                >
                  {session.title}
                </TabTitle>
              );
            const style: SessionTabStyle = {};
            if (hex) style["--tab-color"] = hex;
            if (emptyVisual) {
              style.overflow = "hidden";
              style.transition = "none";
            }
            return (
              <ReorderTabItem
                key={key}
                tabKey={key}
                nextActive={nextActive}
                draggable={tabDragEnabled && editKey !== key}
                dragging={dropSlot?.key === key}
                onPointerDown={handleItemPointerDown}
                onDragStart={handleItemDragStart}
                onDragEnd={handleItemDragEnd}
                onClickCapture={handleItemClickCapture}
              >
                <ContextMenu.Root>
                  <ContextMenu.Trigger
                    render={
                      <div
                        ref={(node) => {
                          if (!openingEmpty || !node || !morphOrigin) return;
                          animateEmptyTabOpen(node, morphOrigin);
                        }}
                        role="tab"
                        aria-selected={key === activeId}
                        className={cn(
                          "group/tab",
                          tabClass({
                            active: key === activeId,
                            waiting,
                            colored: !!hex,
                          }),
                          emptyVisual && "desktop:pr-7",
                        )}
                        style={style}
                        onClick={() => onSelect(session)}
                        title={session.title}
                      />
                    }
                  >
                    {waiting ? (
                      <span className={tabDotClass(true)} />
                    ) : (
                      session.isRunning && (
                        <span className={tabDotClass(false)} />
                      )
                    )}
                    {emptyVisual ? (
                      <span
                        className="inline-flex min-w-0"
                        data-empty-tab-title=""
                      >
                        {titleContent}
                      </span>
                    ) : (
                      titleContent
                    )}
                    {/* Who else is in this tab. The sidebar's workspace row shows
							    the same faces for the whole strip, which says a teammate
							    is in here somewhere; on the tab it says where. Shown on
							    the open tab too — being in the same session as someone is
							    exactly what you want to know. */}
                    {(() => {
                      const here = viewers?.[key] || [];
                      if (!here.length) return null;
                      const shown = here.slice(0, 2);
                      const rest = here.length - shown.length;
                      const label = `${here.join(", ")} ${here.length > 1 ? "are" : "is"} here`;
                      return (
                        <span
                          className={TAB_FACES}
                          aria-label={label}
                          title={label}
                        >
                          {shown.map((viewer) => (
                            <UserAvatar
                              key={viewer}
                              name={viewer}
                              size={14}
                              className={TAB_FACE}
                            />
                          ))}
                          {rest > 0 && (
                            <span className={TAB_FACES_MORE} aria-hidden="true">
                              +{rest}
                            </span>
                          )}
                        </span>
                      );
                    })()}
                    {/* Unsent draft in a sibling session (the active tab's draft is
							    already on screen in the composer — no pencil needed). */}
                    {key !== activeId && (
                      <SessionDraftIndicator sessionId={key} />
                    )}
                    <button
                      type="button"
                      className={tabCloseClass(isPhone)}
                      style={
                        emptyVisual && !isPhone
                          ? { opacity: 1, pointerEvents: "auto" }
                          : undefined
                      }
                      aria-label="Close session"
                      title="Close session"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (empty) closeEmptySession(e.currentTarget, session);
                        else onClose(session);
                      }}
                    >
                      {emptyVisual ? (
                        <span className="inline-flex" data-empty-tab-glyph="">
                          <IconX size={16} dense aria-hidden="true" />
                        </span>
                      ) : (
                        <IconX size={16} dense aria-hidden="true" />
                      )}
                    </button>
                  </ContextMenu.Trigger>
                  {/* finalFocus=false: "Rename session" mounts the inline rename
							    input (autoFocus) — the closing menu must not steal focus
							    back to the tab. */}
                  <ContextMenu.Popup
                    className="min-w-[250px]"
                    finalFocus={false}
                  >
                    <ContextMenu.Item
                      onClick={() => {
                        setDraft(session.title);
                        setEditKey(key);
                      }}
                    >
                      <IconPencil size={20} className={MENU_ICON} />
                      <span className="grow">Rename session</span>
                    </ContextMenu.Item>
                    {/* The cross-bar drag, spelled out: a bar down to its last
								    tab has no room to show a drag, and this is also the
								    only way back for someone who never found the gesture. */}
                    {onMoveAcross && (
                      <ContextMenu.Item onClick={() => onMoveAcross(key)}>
                        {moveAcrossSide === "left" ? (
                          <IconSidebarLeft size={20} className={MENU_ICON} />
                        ) : (
                          <IconSidebarRight size={20} className={MENU_ICON} />
                        )}
                        <span className="grow">
                          Move to {moveAcrossSide} side
                        </span>
                      </ContextMenu.Item>
                    )}
                    <ContextMenu.Separator />
                    <ContextMenu.SubmenuRoot>
                      <ContextMenu.SubmenuTrigger>
                        <IconCopy size={20} className={MENU_ICON} />
                        <span className="grow">Copy transcript</span>
                        <IconChevronRight size={16} className="text-faint" />
                      </ContextMenu.SubmenuTrigger>
                      <Menu.Popup>
                        <Menu.Item
                          onClick={() =>
                            void copySessionTranscript(
                              session,
                              "concise",
                              onToast,
                            )
                          }
                        >
                          <IconListCircles size={20} className={MENU_ICON} />
                          <span className="grow">Concise</span>
                          {key === activeId && copyTranscriptLabel && (
                            <Menu.Shortcut>{copyTranscriptLabel}</Menu.Shortcut>
                          )}
                        </Menu.Item>
                        <Menu.Item
                          onClick={() =>
                            void copySessionTranscript(session, "full", onToast)
                          }
                        >
                          <IconFile size={20} className={MENU_ICON} />
                          <span className="grow">Full</span>
                        </Menu.Item>
                      </Menu.Popup>
                    </ContextMenu.SubmenuRoot>
                    <ContextMenu.Item
                      onClick={() =>
                        copyToClipboard(
                          absoluteLink(sessionPath(session)),
                          () => onToast("Link copied"),
                        )
                      }
                    >
                      <IconLink size={20} className={MENU_ICON} />
                      <span className="grow">Copy link</span>
                    </ContextMenu.Item>
                    <ContextMenu.Separator />
                    {/* Tab color. A swatch click bubbles to the Item, which
								    closes the menu — the Item itself does nothing. */}
                    <ContextMenu.Item className="data-[highlighted]:bg-transparent">
                      {TAB_COLORS.map((c) => (
                        <button
                          key={c.key}
                          type="button"
                          className={cn(
                            TAB_SWATCH,
                            colors[key] === c.key && TAB_SWATCH_ON,
                          )}
                          style={{ background: c.hex }}
                          aria-label={c.label}
                          title={c.label}
                          onClick={() => onSetColor(key, c.key)}
                        />
                      ))}
                      <button
                        type="button"
                        className={cn(TAB_SWATCH, TAB_SWATCH_NONE)}
                        aria-label="No color"
                        title="No color"
                        onClick={() => onSetColor(key, null)}
                      />
                    </ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item onClick={() => onClose(session)}>
                      <IconX size={20} className={MENU_ICON} />
                      <span className="grow">Close tab</span>
                      {key === activeId && closeLabel && (
                        <ContextMenu.Shortcut>
                          {closeLabel}
                        </ContextMenu.Shortcut>
                      )}
                    </ContextMenu.Item>
                    {onDelete && (
                      <ContextMenu.Item
                        className="text-red data-[highlighted]:bg-red-soft data-[highlighted]:text-red"
                        onClick={() => setDeleteTarget(session)}
                      >
                        <IconTrash size={20} />
                        <span className="grow">Delete session</span>
                      </ContextMenu.Item>
                    )}
                  </ContextMenu.Popup>
                </ContextMenu.Root>
              </ReorderTabItem>
            );
          })}
        </Reorder.Group>
        {/* Phone: the +/history controls scroll WITH the tabs so the strip
					    uses the full width — nothing pinned eating horizontal room. */}
        {isPhone && newTabButton}
        {isPhone && historyMenu}
      </div>
      {/* Desktop: the "+" sits OUTSIDE the scroll so it's pinned and always
				    visible — never scrolled off when the tabs overflow a narrow pane. */}
      {!isPhone && newTabButton}
      {!isPhone && <div className={TAB_ACTIONS}>{historyMenu}</div>}
      {deleteTarget && (
        <DeleteSessionDialog
          open
          onOpenChange={(open) => {
            if (!open && !deleting) setDeleteTarget(null);
          }}
          hasWorktree={Boolean(
            deleteTarget.worktreeDir && deleteTarget.mode !== "ask",
          )}
          deleting={deleting}
          onDelete={(cleanWorktree) => void deleteSession(cleanWorktree)}
        />
      )}
    </div>
  );
}
