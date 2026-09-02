import {
  CTX_ITEM_STYLE,
  CTX_MENU_STYLE,
  CTX_SEP_STYLE,
} from "../../lib/sidebar-ctx";
import { statusMenuIcon } from "../../lib/sidebar-lanes";
import { MINE_STATUS_META, type CtxEntry } from "../../lib/sidebar-types";
import { snoozePresets } from "../../lib/snoozes";
import { IconChevronRight, IconMoon, IconStatusRing } from "../icons";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MenuCheck, MenuShortcut } from "../../ui/menu";

function CtxItem({
  icon,
  label,
  shortcut,
  danger,
  trailing,
  onClick,
  onMouseEnter,
}: {
  icon?: React.ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  trailing?: React.ReactNode;
  onClick?: () => void;
  onMouseEnter?: (e: React.MouseEvent) => void;
}) {
  const style: React.CSSProperties = {
    ...CTX_ITEM_STYLE,
    display: "flex",
    alignItems: "center",
    gap: 11,
  };
  if (danger) style.color = "var(--red, #e5534b)";

  return (
    <button
      type="button"
      style={style}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      {icon !== undefined && (
        <span
          style={{
            width: 20,
            display: "inline-flex",
            justifyContent: "center",
            flexShrink: 0,
            color: danger ? "inherit" : "var(--text-dim)",
          }}
        >
          {icon}
        </span>
      )}
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </span>
      {shortcut && <MenuShortcut>{shortcut}</MenuShortcut>}
      {trailing}
    </button>
  );
}

/** A row that opens a hover flyout: the leading glyph, the label, what the
 *  choice currently says, and the chevron every submenu trigger wears. */
function CtxFlyoutRow({
  icon,
  label,
  value,
  onOpen,
  onLeave,
}: {
  icon?: React.ReactNode;
  label: string;
  value?: string;
  onOpen: (rect: DOMRect) => void;
  onLeave: () => void;
}) {
  return (
    <button
      type="button"
      style={{
        ...CTX_ITEM_STYLE,
        display: "flex",
        alignItems: "center",
        gap: 11,
      }}
      onMouseEnter={(e) => onOpen(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={onLeave}
      onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}
    >
      <span
        style={{
          width: 20,
          display: "inline-flex",
          justifyContent: "center",
          flexShrink: 0,
          color: "var(--text-dim)",
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {value && (
        <span className="text-faint" style={{ flexShrink: 0 }}>
          {value}
        </span>
      )}
      <IconChevronRight
        size={16}
        style={{ color: "var(--text-faint)", flexShrink: 0 }}
      />
    </button>
  );
}

// The popup surface, worn by the menu and by every flyout it opens.
const POPUP_CLASS =
  "smooth-shadow-ring-md [--smooth-ring-color:var(--popup-ring)] [corner-shape:squircle] [&_button:not(.tab-color-swatch):hover]:bg-hover!";

export function SidebarCtxMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: CtxEntry[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const gutter = 8;
    const rect = menu.getBoundingClientRect();
    setMenuPosition({
      left: Math.max(
        gutter,
        Math.min(x, window.innerWidth - rect.width - gutter),
      ),
      top: Math.max(
        gutter,
        Math.min(y, window.innerHeight - rect.height - gutter),
      ),
    });
  }, [x, y, entries]);

  // Flyout state + hover grace so the pointer can
  // cross the gap between the menu and the panel.
  const [sub, setSub] = useState<{
    kind: "status" | "snooze";
    rect: DOMRect;
  } | null>(null);
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelClose() {
    if (closeT.current) clearTimeout(closeT.current);
    closeT.current = null;
  }
  function scheduleClose() {
    cancelClose();
    closeT.current = setTimeout(() => setSub(null), 160);
  }
  useEffect(() => cancelClose, []);

  const statusEntry = entries.find(
    (e): e is Extract<CtxEntry, { kind: "status" }> => e.kind === "status",
  );
  const snoozeEntry = entries.find(
    (e): e is Extract<CtxEntry, { kind: "snooze" }> => e.kind === "snooze",
  );
  const check = (on: boolean) => (
    <MenuCheck on={on} size={20} className="text-dim" />
  );

  const SUB_W = 210;
  const subLeft = sub
    ? sub.rect.right + SUB_W + 8 > window.innerWidth
      ? sub.rect.left - SUB_W - 4
      : sub.rect.right + 4
    : 0;
  // Rough panel height, so a flyout opened low in the window is nudged up
  // rather than clipped. Rows are ~30px, plus the popup's own padding.
  const subRows =
    sub?.kind === "status"
      ? MINE_STATUS_META.length + 1
      : snoozePresets().length + (snoozeEntry?.until ? 1 : 0);
  const subTop = sub
    ? Math.max(
        8,
        Math.min(
          sub.rect.top - 6,
          window.innerHeight - (subRows * 30 + 16) - 8,
        ),
      )
    : 0;

  return createPortal(
    <>
      <div
        ref={menuRef}
        className={POPUP_CLASS}
        style={{ ...CTX_MENU_STYLE, ...menuPosition }}
        onClick={(e) => e.stopPropagation()}
      >
        {entries.map((entry, i) => {
          if (entry.kind === "sep")
            return <div key={i} style={CTX_SEP_STYLE} />;
          if (entry.kind === "label")
            return (
              // Same heading as a Base UI menu group's label, so a
              // grouped right-click menu reads like every other menu.
              <div
                key={i}
                className="px-2 pt-1 pb-1 text-meta font-semibold tracking-[-0.01em] text-faint"
              >
                {entry.label}
              </div>
            );
          if (entry.kind === "status") {
            return (
              <CtxFlyoutRow
                key={i}
                icon={<IconStatusRing size={20} />}
                label="Set status"
                onOpen={(rect) => {
                  cancelClose();
                  setSub({ kind: "status", rect });
                }}
                onLeave={scheduleClose}
              />
            );
          }
          if (entry.kind === "snooze") {
            return (
              <CtxFlyoutRow
                key={i}
                icon={<IconMoon size={20} />}
                label="Snooze"
                onOpen={(rect) => {
                  cancelClose();
                  setSub({ kind: "snooze", rect });
                }}
                onLeave={scheduleClose}
              />
            );
          }

          return (
            <CtxItem
              key={i}
              icon={entry.icon}
              label={entry.label}
              shortcut={entry.shortcut}
              trailing={entry.trailing}
              danger={entry.danger}
              onMouseEnter={scheduleClose}
              onClick={() => {
                entry.onClick();
                if (!entry.keepOpen) onClose();
              }}
            />
          );
        })}
      </div>
      {sub?.kind === "status" && statusEntry && (
        <div
          className={POPUP_CLASS}
          style={{
            ...CTX_MENU_STYLE,
            left: subLeft,
            top: subTop,
            minWidth: SUB_W,
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {MINE_STATUS_META.map((m) => (
            <CtxItem
              key={m.key}
              icon={statusMenuIcon(m.key, m.dotColor)}
              label={m.label}
              trailing={check(statusEntry.current === m.key)}
              onClick={() => {
                statusEntry.onPick(
                  statusEntry.current === m.key ? null : m.key,
                );
                onClose();
              }}
            />
          ))}
          <div style={CTX_SEP_STYLE} />
          <CtxItem
            icon={<span />}
            label="Auto (default)"
            trailing={check(statusEntry.current === null)}
            onClick={() => {
              statusEntry.onPick(null);
              onClose();
            }}
          />
        </div>
      )}
      {sub?.kind === "snooze" && snoozeEntry && (
        <div
          className={POPUP_CLASS}
          style={{
            ...CTX_MENU_STYLE,
            left: subLeft,
            top: subTop,
            minWidth: SUB_W,
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {snoozePresets().map((p) => (
            <CtxItem
              key={p.label}
              label={p.label}
              onClick={() => {
                snoozeEntry.onPick(p.until);
                onClose();
              }}
            />
          ))}
          {snoozeEntry.until && (
            <>
              <div style={CTX_SEP_STYLE} />
              <CtxItem
                label="Unsnooze"
                onClick={() => {
                  snoozeEntry.onPick(null);
                  onClose();
                }}
              />
            </>
          )}
        </div>
      )}
    </>,
    document.body,
  );
}
