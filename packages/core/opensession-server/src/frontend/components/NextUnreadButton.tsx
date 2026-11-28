import { useEffect, useRef, useState } from "react";
import { useNavigation } from "../hooks/useNavigation";
import { useShortcutKeys } from "../hooks/useShortcutBindings";
import { availableHeldChats, type UnreadChat } from "../lib/unread-chats";
import { LONG_PRESS_MS, LONG_PRESS_SLOP } from "../lib/sidebar-swipe";
import { cn } from "../ui/cn";
import { RepoTile } from "./RepoTile";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";
import { IconArrowRight, IconX } from "./icons";

export function NextUnreadButton({ phone = false }: { phone?: boolean }) {
  const { unreadChats, allChatsRead, openNextChat } = useNavigation();
  const keys = useShortcutKeys("workspace-next-unread");
  const [open, setOpen] = useState(false);
  const [held, setHeld] = useState<readonly UnreadChat[] | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const suppressClick = useRef(false);
  const dismissed = useRef(false);
  const navigating = useRef(false);
  const chats = availableHeldChats(held, unreadChats);
  const next = chats[0];
  // Desktop: a glass pill of its own on the action row, the scroll arrow's
  // material. Phone: the last segment of the glass action bar, so it takes
  // the bar's 44px touch height and the bar supplies the glass.
  const surface = cn(
    "min-w-0 max-w-full justify-start text-left",
    phone ? "h-11 min-h-11 px-3" : "max-w-[min(20rem,100%)]",
  );
  const glass = (control: React.ReactNode) =>
    phone ? (
      control
    ) : (
      <span className="inline-flex min-w-0 max-w-full rounded-full bg-popup-glass [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-sm">
        {control}
      </span>
    );
  const repo = (name: string) => (
    <span aria-hidden>
      <RepoTile name={name} size={phone ? 18 : 16} />
    </span>
  );
  const arrow = <IconArrowRight size={20} aria-hidden />;

  useEffect(() => () => clearTimeout(longPress.current), []);

  function choose(id: string) {
    navigating.current = true;
    setOpen(false);
    setHeld(null);
    openNextChat(id);
  }

  function close() {
    setOpen(false);
    dismissed.current = true;
    setHeld(null);
  }

  function cancelPress() {
    clearTimeout(longPress.current);
    touch.current = null;
  }

  if (unreadChats.length === 0) {
    return allChatsRead
      ? glass(
          <span
            role="status"
            className={cn(
              "flex items-center px-3.5 text-label text-dim",
              phone ? "h-11" : "h-8",
            )}
          >
            All read
          </span>,
        )
      : null;
  }

  // If a held destination vanishes, wait until interaction ends rather than
  // silently substituting a newly arrived thread beneath an imminent click.
  if (!next)
    return glass(
      <Button
        aria-disabled="true"
        variant="ghost"
        size={phone ? "lg" : "md"}
        className={cn(surface, "active:scale-100")}
        onPointerLeave={() => setHeld(null)}
        onBlur={() => setHeld(null)}
        onClick={() => setHeld(null)}
      >
        No longer unread
      </Button>,
    );

  // Name the workspace it opens; a session without one falls back to its title.
  const nextLabel = next.workspace || next.title;

  return glass(
    <Popover.Root
      open={open}
      onOpenChange={(value, details) => {
        // The trigger navigates. Only hover, focus, or a deliberate long press
        // opens its chooser; Base UI must not turn a normal click into a toggle.
        if (details.reason === "trigger-press") {
          details.cancel();
          return;
        }
        setOpen(value);
        if (value) setHeld((current) => current ?? unreadChats);
        else {
          dismissed.current = true;
          if (!trigger.current?.matches(":hover, :focus")) setHeld(null);
        }
      }}
    >
      <Popover.Trigger
        ref={trigger}
        openOnHover
        delay={350}
        closeDelay={150}
        render={
          <Button
            variant="ghost"
            size={phone ? "lg" : "md"}
            icon={repo(next.repo)}
            iconTone="full"
            trailing={arrow}
          />
        }
        className={cn(surface, "active:scale-100")}
        aria-label={`Next unread: ${nextLabel}`}
        aria-description={
          phone
            ? "Tap to open. Hold to choose another unread session."
            : "Click to open. Hover or focus to choose another unread session."
        }
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") {
            dismissed.current = false;
            setHeld(unreadChats);
          }
        }}
        onPointerLeave={() => {
          cancelPress();
          if (!open && document.activeElement !== trigger.current)
            setHeld(null);
        }}
        onFocus={(event) => {
          setHeld((current) => current ?? unreadChats);
          if (
            !dismissed.current &&
            event.currentTarget.matches(":focus-visible")
          )
            setOpen(true);
        }}
        onBlur={() => {
          dismissed.current = false;
          if (!open) setHeld(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => {
            const buttons = list.current?.querySelectorAll<HTMLButtonElement>(
              "button[data-unread-destination]",
            );
            (event.key === "ArrowUp"
              ? buttons?.[buttons.length - 1]
              : buttons?.[0]
            )?.focus();
          });
        }}
        onPointerDown={(event) => {
          suppressClick.current = false;
          if (event.pointerType !== "touch") return;
          setHeld(unreadChats);
          touch.current = { x: event.clientX, y: event.clientY };
          longPress.current = setTimeout(() => {
            suppressClick.current = true;
            setOpen(true);
          }, LONG_PRESS_MS);
        }}
        onPointerMove={(event) => {
          if (
            touch.current &&
            Math.hypot(
              event.clientX - touch.current.x,
              event.clientY - touch.current.y,
            ) > LONG_PRESS_SLOP
          )
            cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(event) => {
          event.preventDefault();
          suppressClick.current = true;
          setHeld((current) => current ?? unreadChats);
          setOpen(true);
        }}
        onClick={(event) => {
          event.preventBaseUIHandler();
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          choose(next.id);
        }}
      >
        <span className="min-w-0 truncate">{nextLabel}</span>
      </Popover.Trigger>
      <Popover.Popup
        side="top"
        align="end"
        className="w-80 max-w-[calc(100vw-24px)] p-1.5"
        aria-label="Unread sessions"
        finalFocus={(interaction) =>
          !navigating.current && interaction === "keyboard"
            ? trigger.current
            : false
        }
      >
        <div className="flex min-h-9 items-center justify-between gap-3 px-2.5 text-xs text-faint">
          <span>Unread sessions · {chats.length}</span>
          {phone ? (
            <Button
              variant="ghost"
              className="size-11 min-h-11"
              aria-label="Close unread sessions"
              icon={<IconX size={20} />}
              onClick={close}
            />
          ) : (
            keys && (
              <span aria-label="Next unread shortcut">{keys.join(" ")}</span>
            )
          )}
        </div>
        <div
          ref={list}
          className="max-h-72 overflow-y-auto overscroll-contain"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button[data-unread-destination]",
              ),
            );
            const index = buttons.findIndex(
              (button) => button === document.activeElement,
            );
            const target =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      buttons.length) %
                    buttons.length;
            event.preventDefault();
            buttons[target]?.focus();
          }}
        >
          {chats.map((chat) => (
            <Button
              size="lg"
              key={chat.id}
              data-unread-destination
              variant="ghost"
              className="w-full justify-start gap-2 whitespace-normal px-2.5 py-2 text-left text-sm"
              onClick={() => choose(chat.id)}
              aria-label={`Open unread session: ${chat.title}`}
            >
              <span aria-hidden>
                <RepoTile name={chat.repo} size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-fg">{chat.title}</span>
                {chat.workspace && chat.workspace !== chat.title && (
                  <span className="block truncate text-xs text-faint">
                    {chat.workspace}
                  </span>
                )}
              </span>
            </Button>
          ))}
        </div>
      </Popover.Popup>
    </Popover.Root>,
  );
}
