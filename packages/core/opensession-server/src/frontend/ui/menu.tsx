import * as React from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { IconCheck, type IconSize } from "../components/icons";
import * as stylex from "@stylexjs/stylex";
import { cn } from "./cn";
import { POPUP_HOOK } from "./popup-classes";
import { popup } from "./popup-styles";
import { sx } from "./sx";
import {
  DeferredPopupRootContext,
  useDeferredPopupRoot,
  useLazyPopupRoot,
} from "./popup-arming";
import { DeferredPopupTrigger } from "./popup-arming-region";

/**
 * Menu on Base UI parts, styled with Tailwind tokens. Composable shape —
 * consumers assemble Root/Trigger/Popup/Item rather than passing item configs.
 *
 * Unlike ui/tooltip.tsx this does NOT animate via a Motion render prop: the
 * render merge drops Base UI's injected attributes (role, data-*), which a
 * focus-managed popup can't afford. Menus animate with CSS transitions on
 * Base UI's [data-starting-style]/[data-ending-style] lifecycle attributes —
 * enter AND exit work, keyboard nav and a11y stay intact.
 */

/** Inside an unarmed PopupArmingRegion (ui/popup-arming.ts) the root waits:
 *  its trigger is a plain button and its popup is not rendered until the
 *  region arms or the button is clicked. */
function Root<Payload = unknown>({
  children,
  defaultOpen,
  ...props
}: BaseMenu.Root.Props<Payload>) {
  const { deferred, openOnMount } = useLazyPopupRoot(props.open);
  if (deferred && !(children instanceof Function))
    return (
      <DeferredPopupRootContext value={deferred}>
        {children}
      </DeferredPopupRootContext>
    );
  return (
    <DeferredPopupRootContext value={null}>
      <BaseMenu.Root {...props} defaultOpen={defaultOpen || openOnMount}>
        {children}
      </BaseMenu.Root>
    </DeferredPopupRootContext>
  );
}

function Trigger({
  className,
  ...props
}: Omit<React.ComponentProps<typeof BaseMenu.Trigger>, "className"> & {
  className?: string;
}) {
  const deferred = useDeferredPopupRoot();
  if (deferred) {
    const {
      render,
      openOnHover,
      delay,
      closeDelay,
      handle,
      payload,
      nativeButton,
      style,
      ...domProps
    } = props;
    return (
      <DeferredPopupTrigger
        haspopup="menu"
        onOpen={deferred.open}
        render={render}
        state={{ open: false, disabled: Boolean(domProps.disabled) }}
        props={{ ...domProps, className: cn("focus-ring", className) }}
      />
    );
  }
  return (
    <BaseMenu.Trigger {...props} className={cn("focus-ring", className)} />
  );
}

// The popup chrome, the scroller inside it, and the row live in
// ui/popup-classes.ts. The click-menu, the right-click menu and ui/select all
// wear the same surface, so it has one home.

function Popup({
  className,
  positionerClassName,
  side,
  align,
  sideOffset = 8,
  alignOffset = 0,
  anchor,
  finalFocus,
  footer,
  aside,
  children,
}: {
  className?: string;
  /** Override the portal layer when this menu opens inside a higher popup. */
  positionerClassName?: string;
  side?: React.ComponentProps<typeof BaseMenu.Positioner>["side"];
  align?: React.ComponentProps<typeof BaseMenu.Positioner>["align"];
  sideOffset?: number;
  /** Shift the popup along its alignment axis. */
  alignOffset?: React.ComponentProps<typeof BaseMenu.Positioner>["alignOffset"];
  /** Anchor something other than the trigger — an element, a ref, or a
   * virtual element with `getBoundingClientRect`. That last form is for a
   * menu whose subject is not a control at all: the composer's pill menu
   * hangs off a box of TEXT inside a textarea (Composer.tsx), which has no
   * element of its own to point at. */
  anchor?: React.ComponentProps<typeof BaseMenu.Positioner>["anchor"];
  /** Where focus goes on close. Defaults to the trigger, which a menu opened
   * from an anchor rather than a trigger does not have. */
  finalFocus?: React.ComponentProps<typeof BaseMenu.Popup>["finalFocus"];
  /** Non-scrolling footer docked flush to the bottom edge of the popup. */
  footer?: React.ReactNode;
  /** Non-scrolling panel docked beside the list, on its right. The list and
   *  any footer stay one column; the aside takes the popup's full height. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (useDeferredPopupRoot()) return null;
  const list = (
    <>
      <div
        {...stylex.props(
          popup.scroll,
          footer || aside ? popup.scrollAboveFooter : null,
        )}
      >
        {children}
      </div>
      {footer}
    </>
  );
  return (
    <BaseMenu.Portal
      // Base UI otherwise inherits a containing popup's portal target. The
      // workspace summary card portals into the header's actions row, whose
      // low stacking layer would trap its menus under the Browser thumbnail
      // drawn over the card. Mount at the page root so the menu paints above.
      container={typeof document !== "undefined" ? document.body : undefined}
    >
      <BaseMenu.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionPadding={8}
        {...sx(popup.positioner, positionerClassName)}
      >
        <BaseMenu.Popup
          {...sx(
            [
              popup.surface,
              aside ? popup.withAside : footer ? popup.withFooter : null,
            ],
            cn(POPUP_HOOK, className),
          )}
          finalFocus={finalFocus}
        >
          {aside ? (
            <>
              <div
                {...stylex.props(
                  popup.asideList,
                  // A column of its own, so the list takes the popup's
                  // taller cap rather than a plain menu's.
                  popup.withFooter,
                )}
              >
                {list}
              </div>
              {aside}
            </>
          ) : (
            list
          )}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

/** Right-click context-menu popup. Anchors to the cursor (Base UI positions it
 * from the contextmenu event), reusing the same chrome + Item styling as Menu. */
function ContextPopup({
  className,
  finalFocus,
  children,
}: {
  className?: string;
  /** Where focus goes on close — pass `false` when the menu opens an inline
   * editor that autofocuses itself (default restores focus to the trigger). */
  finalFocus?: React.ComponentProps<typeof BaseContextMenu.Popup>["finalFocus"];
  children: React.ReactNode;
}) {
  return (
    <BaseContextMenu.Portal
      // Base UI otherwise inherits a containing popup's portal target. A
      // right-click menu is the active interaction, so mount it at the page
      // root where its floating layer paints above hover previews.
      container={typeof document !== "undefined" ? document.body : undefined}
    >
      <BaseContextMenu.Positioner
        collisionPadding={8}
        {...stylex.props(popup.positioner)}
      >
        <BaseContextMenu.Popup
          {...sx(popup.surface, cn(POPUP_HOOK, className))}
          finalFocus={finalFocus}
        >
          <div {...stylex.props(popup.scroll)}>{children}</div>
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  );
}

function Item({
  className,
  tone,
  ...props
}: Omit<React.ComponentProps<typeof BaseMenu.Item>, "className"> & {
  className?: string;
  /** `danger` for a destructive row (Delete, Remove, Archive): red ink and
   *  a red wash when lit. Leave the row's glyph uncoloured so it takes the
   *  red too. */
  tone?: "danger";
}) {
  return (
    <BaseMenu.Item
      {...props}
      {...sx([popup.item, tone === "danger" && popup.itemDanger], className)}
    />
  );
}

function SubmenuTrigger({
  className,
  ...props
}: Omit<React.ComponentProps<typeof BaseMenu.SubmenuTrigger>, "className"> & {
  className?: string;
}) {
  return (
    <BaseMenu.SubmenuTrigger
      {...props}
      {...sx([popup.item, popup.itemOpen], className)}
    />
  );
}

function RadioItem({
  className,
  ...props
}: Omit<React.ComponentProps<typeof BaseMenu.RadioItem>, "className"> & {
  className?: string;
}) {
  return <BaseMenu.RadioItem {...props} {...sx(popup.item, className)} />;
}

function CheckboxItem({
  className,
  ...props
}: Omit<React.ComponentProps<typeof BaseMenu.CheckboxItem>, "className"> & {
  className?: string;
}) {
  return <BaseMenu.CheckboxItem {...props} {...sx(popup.item, className)} />;
}

/**
 * Resting colour for a row's leading glyph. Menu icons sit one step back from
 * their label so the words lead and the column of glyphs reads as one set;
 * the sidebar's right-click menu and the phone sheet already do this. Skip it
 * for a glyph that carries state in its colour (a running preview's green, a
 * pinned row's yellow).
 */
export const MENU_ICON = "text-dim";

/** Right-aligned keyboard-shortcut hint on a menu row ("⌘ W"). Place it after
 * the row's `grow` label so it pins to the trailing edge. Exported on its own
 * as well as on the Menu namespaces: the composer's "+" menu is a hand-rolled
 * popover (its rows carry the iOS touchend handling Base UI can't), and its
 * hints have to read exactly like the ones in a real menu. */
export function MenuShortcut({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <span {...sx(popup.shortcut, className)}>{children}</span>;
}

/**
 * The tick on a selectable row. It holds its column whether or not the row is
 * the picked one, because a tick that only exists while selected makes that
 * one row wider than its neighbours: the popup is then a different width
 * depending on what is selected, and every label in it shifts under the
 * pointer when you change your mind. Reserving the slot is the move
 * `ui/select`'s trigger already makes with `sizeTo`.
 *
 * Exported on its own as well as on the Menu namespaces: the hand-rolled
 * popovers (the composer's "+" menu, the New-session create menu) carry rows
 * Base UI can't own, and their ticks have to read like the ones in a real menu.
 */
export function MenuCheck({
  on,
  size = 20,
  className,
}: {
  /** Whether this row is the picked one. */
  on: boolean;
  size?: IconSize;
  className?: string;
}) {
  return (
    <IconCheck
      size={size}
      aria-hidden
      {...sx([popup.check, !on && popup.checkOff], className)}
    />
  );
}

function Separator({ className }: { className?: string }) {
  return <BaseMenu.Separator {...sx(popup.separator, className)} />;
}

function GroupLabel({
  className,
  ...props
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <BaseMenu.GroupLabel {...props} {...sx(popup.groupLabel, className)} />
  );
}

/** Right-click context menu. Trigger wraps the target (render it as the anchor);
 * left-click passes through, contextmenu opens the popup at the cursor. Reuses
 * Menu's Item/Separator — Base UI's ContextMenu.Item is the same MenuItem. */
export const ContextMenu = {
  Root: BaseContextMenu.Root,
  Trigger: BaseContextMenu.Trigger,
  Popup: ContextPopup,
  Item,
  Separator,
  Shortcut: MenuShortcut,
  Check: MenuCheck,
  // Grouping and checkable rows are the plain Menu parts for the same reason
  // the submenu parts below are: Base UI builds both menus on one primitive,
  // so a context menu can offer a checkable list without a second styling
  // path. Only the popup differs, because that is the part that anchors.
  Group: BaseMenu.Group,
  GroupLabel,
  CheckboxItem,
  // Submenus are the plain Menu parts (ContextMenu re-exports them), so a
  // submenu's own popup is Menu.Popup: it anchors to its trigger row rather
  // than to the cursor the way ContextPopup does.
  SubmenuRoot: BaseContextMenu.SubmenuRoot,
  SubmenuTrigger,
};

export const Menu = {
  Root,
  Trigger,
  Popup,
  Item,
  Separator,
  Shortcut: MenuShortcut,
  Check: MenuCheck,
  Group: BaseMenu.Group,
  GroupLabel,
  SubmenuRoot: BaseMenu.SubmenuRoot,
  SubmenuTrigger,
  RadioGroup: BaseMenu.RadioGroup,
  RadioItem,
  RadioItemIndicator: BaseMenu.RadioItemIndicator,
  CheckboxItem,
};
