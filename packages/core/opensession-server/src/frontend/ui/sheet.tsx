import * as React from "react";
import { createPortal } from "react-dom";
import * as stylex from "@stylexjs/stylex";
import { cn } from "./cn";
import { sx } from "./sx";
import { PhoneTopBarAction } from "./top-bar";
import {
  color,
  corner,
  geometry,
  layer,
  motion,
  radius,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex";

const styles = stylex.create({
  root: { position: "fixed", inset: space.s0, zIndex: layer.modalScrim },
  parked: { visibility: "hidden", pointerEvents: "none" },
  backdrop: {
    position: "absolute",
    inset: space.s0,
    backgroundColor: color.scrimSheet,
  },
  fade: {
    transitionProperty: "opacity",
    transitionTimingFunction: motion.ease,
  },
  fadePhone: { transitionDuration: motion.long },
  fadeDesktop: { transitionDuration: motion.standard },
  hidden: { opacity: 0 },
  panel: {
    position: "absolute",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    outline: "none",
    ["cornerShape"]: corner.squircle,
  },
  // A full-height phone page: edge to edge, clear of both safe areas.
  page: {
    inset: space.s0,
    height: geometry.fullHeight,
    maxHeight: "none",
    borderRadius: 0,
    backgroundColor: color.page,
    paddingBottom: geometry.safeBottom,
    paddingTop: geometry.safeTop,
    boxShadow: "none",
  },
  sheet: {
    insetInline: space.s0,
    bottom: space.s0,
    maxHeight: geometry.sheetMaxHeight,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    backgroundColor: color.page,
    paddingBottom: geometry.safeBottom,
    boxShadow: shadow.sheet,
  },
  dialog: {
    left: "50%",
    top: "50%",
    maxHeight: geometry.sheetDialogMaxHeight,
    width: geometry.sheetDialogWidth,
    maxWidth: geometry.sheetDialogMaxWidth,
    translate: "-50% -50%",
    borderRadius: radius.xl,
    backgroundColor: color.raised,
    boxShadow: shadow.ringLg,
  },
  slide: {
    transitionProperty: "transform, translate, scale, rotate",
    transitionDuration: motion.long,
    transitionTimingFunction: motion.ease,
  },
  slidOut: { translate: "0 100%" },
  pop: {
    transformOrigin: "center",
    transitionProperty: "scale, opacity",
    transitionDuration: motion.standard,
    transitionTimingFunction: motion.ease,
  },
  poppedOut: { scale: motion.dialogEnterScale, opacity: 0 },
  grabberRow: {
    display: "flex",
    flexShrink: 0,
    touchAction: "none",
    justifyContent: "center",
    paddingBottom: space.s6,
    paddingTop: space.s10,
  },
  grabber: {
    height: geometry.grabberHeight,
    width: geometry.grabberWidth,
    borderRadius: radius.pill,
    backgroundColor: color.active,
  },
  body: {
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
    paddingInline: space.s10,
    paddingBottom: space.s14,
  },
  title: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    paddingInline: space.s12,
    paddingBottom: space.s8,
    paddingTop: space.s6,
    fontSize: text.label,
    color: color.faint,
  },
  separator: {
    marginInline: space.s10,
    marginBlock: space.s6,
    height: geometry.hairline,
    backgroundColor: color.line,
  },
  item: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: geometry.sheetRowGap,
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    paddingInline: space.s14,
    paddingBlock: geometry.sheetRowPad,
    textAlign: "left",
    fontSize: text.body,
    backgroundColor: { default: null, ":active": color.pressed },
  },
  default: { color: color.fg },
  danger: { color: color.red },
  accent: { fontWeight: weight.strong, color: color.accentInk },
  green: { fontWeight: weight.strong, color: color.green },
  purple: { fontWeight: weight.strong, color: color.purple },
});

/**
 * The app's sheet/dialog language for surfaces that own their own open state —
 * summoned by a route or a keyboard shortcut rather than hung off a trigger
 * element (Settings, the account menu, the Desk).
 *
 * `ResponsiveDialog` is the primitive: one piece of content rendered as a
 * centered modal on desktop and an iOS-style bottom sheet on phone, with the
 * same dismissal, animation and focus behaviour on both. `BottomSheet` is the
 * phone-only shorthand over it.
 *
 * Deliberately not a Base UI wrapper (unlike ui/modal.tsx): these popups have
 * no trigger to anchor to, and one of them — the Desk — has to stay mounted
 * while closed so its socket keeps streaming, which Base UI's `keepMounted`
 * only does via `display: none` (that would zero the transcript's scrollHeight
 * and lose the reader's place). See `keepMounted`.
 *
 * Dismissal (backdrop tap, Esc, dragging the grabber down, or a child calling
 * the render-prop `dismiss`) always plays the exit animation before the owner
 * is told to close, so owners never manage animation themselves.
 */

/** Kept in sync with the panel transition durations below. */
const SHEET_MS = 300;
const MODAL_MS = 150;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Phase = "closed" | "entering" | "open" | "exiting";

/**
 * Enter/exit as a four-state machine, so one render path serves both the
 * unmount-when-closed sheets and the Desk's stay-mounted overlay: `entering`
 * paints the start state for a frame so the transition has somewhere to come
 * from, `exiting` holds the panel around long enough to animate away.
 */
function usePhase(open: boolean, animated: boolean, durationMs: number): Phase {
  const [phase, setPhase] = React.useState<Phase>("closed");

  React.useEffect(() => {
    if (!animated) {
      setPhase(open ? "open" : "closed");
      return;
    }
    setPhase((p) =>
      open ? (p === "open" ? p : "entering") : p === "closed" ? p : "exiting",
    );
  }, [open, animated]);

  React.useEffect(() => {
    if (phase === "entering") {
      const raf = requestAnimationFrame(() => setPhase("open"));
      return () => cancelAnimationFrame(raf);
    }
    if (phase === "exiting") {
      const t = window.setTimeout(() => setPhase("closed"), durationMs);
      return () => window.clearTimeout(t);
    }
  }, [phase, durationMs]);

  return phase;
}

export function ResponsiveDialog({
  open,
  onClose,
  phone,
  label,
  keepMounted = false,
  desktopTransition = "pop",
  sheetClassName,
  modalClassName,
  backdropClassName,
  showPhoneGrabber = true,
  phonePresentation = "sheet",
  finalFocus,
  children,
}: {
  open: boolean;
  /** Close was requested (backdrop, Esc, drag, `dismiss`) — flip `open`. */
  onClose: () => void;
  /** Phone viewport: render the bottom sheet instead of the centered modal. */
  phone: boolean;
  /** Accessible dialog label. */
  label: string;
  /**
   * Keep the panel mounted (hidden) once it has been opened, instead of
   * unmounting on close. For overlays whose children hold live state —
   * sockets, scroll position — that must survive a dismiss.
   */
  keepMounted?: boolean;
  /** `"none"` for overlays that toggle like a HUD rather than open like a dialog. */
  desktopTransition?: "pop" | "none";
  /** Extra classes for the phone sheet panel (e.g. a fixed height). */
  sheetClassName?: string;
  /** Extra classes for the desktop modal panel (e.g. a fixed size). */
  modalClassName?: string;
  /** Override the shared backdrop when a surface needs stronger separation. */
  backdropClassName?: string;
  /** Full-screen phone lightboxes close explicitly and have no sheet grabber. */
  showPhoneGrabber?: boolean;
  /** A page covers the viewport without sheet chrome, a backdrop, or drag dismissal. */
  phonePresentation?: "sheet" | "page";
  /**
   * Where focus goes on close instead of back to whatever opened the dialog.
   * Return null to keep that default. For a viewer opened from a link, whose
   * Enter would only open it again.
   */
  finalFocus?: () => HTMLElement | null;
  children: React.ReactNode | ((dismiss: () => void) => React.ReactNode);
}) {
  const phonePage = phone && phonePresentation === "page";
  // Phone surfaces always animate. Desktop HUD-style overlays can opt out.
  const animated = phone || desktopTransition !== "none";
  const phase = usePhase(open, animated, phone ? SHEET_MS : MODAL_MS);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const finalFocusRef = React.useRef(finalFocus);
  React.useLayoutEffect(() => {
    finalFocusRef.current = finalFocus;
  });

  const [booted, setBooted] = React.useState(open);
  React.useEffect(() => {
    if (open) setBooted(true);
  }, [open]);

  const mounted = keepMounted ? booted : phase !== "closed";
  const shown = phase === "open";

  // Esc dismisses. Capture phase so it wins over page-level Esc handlers
  // (the app's palette/back handlers) while the dialog is up.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // This capture listener runs before a portalled Base UI menu or a
        // layer inside the dialog (an annotation layer). Let it consume the
        // first Escape instead of closing the whole dialog.
        if (document.querySelector(".app-menu-popup, [data-consumes-escape]"))
          return;
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Park focus inside the dialog on open — unless a child already claimed it
  // (the Desk drops the caret in its composer on desktop) — and hand it back
  // to whatever opened us on close.
  React.useEffect(() => {
    if (!open || !mounted) return;
    // A local in effect scope (not a ref) so teardown hands focus back to
    // exactly the element this open parked.
    let restoreTo =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      panel.focus();
    });
    // Setup-scope helper so teardown reads the latest panel node without
    // touching `.current` directly inside the cleanup body.
    const handBackFocus = () => {
      const prev = finalFocusRef.current?.() ?? restoreTo;
      if (!prev || !document.body.contains(prev)) return;
      // Only take focus back if it was still ours — the user may have
      // clicked into the page behind us.
      const inside =
        panelRef.current?.contains(document.activeElement) ?? false;
      if (inside || document.activeElement === document.body) prev.focus();
    };
    return () => {
      cancelAnimationFrame(raf);
      handBackFocus();
    };
  }, [open, mounted]);

  // Keep Tab from wandering behind the backdrop. Bubble phase and only when
  // nothing else claimed the key, so a composer's @-mention popup can still
  // accept its completion with Tab.
  React.useEffect(() => {
    if (!open || !mounted) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const panel = panelRef.current;
      const activeEl =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      // Focus that has legitimately left the panel (a portalled menu
      // popup) manages its own tabbing.
      if (!panel || !activeEl || !panel.contains(activeEl)) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.getClientRects().length > 0);
      if (!items.length) return;
      const [first] = items;
      const last = items[items.length - 1];
      if (activeEl !== (e.shiftKey ? first : last)) return;
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, mounted]);

  // Drag the grabber down to dismiss: the sheet follows the finger (transition
  // suspended), and a decent pull flicks it away on release.
  const drag = React.useRef<{ startY: number; dy: number } | null>(null);
  function onTouchStart(e: React.TouchEvent) {
    drag.current = { startY: e.touches[0].clientY, dy: 0 };
    if (panelRef.current) panelRef.current.style.transition = "none";
  }
  function onTouchMove(e: React.TouchEvent) {
    if (!drag.current) return;
    const dy = Math.max(0, e.touches[0].clientY - drag.current.startY);
    drag.current.dy = dy;
    if (panelRef.current)
      panelRef.current.style.transform = `translateY(${dy}px)`;
  }
  function onTouchEnd() {
    const dy = drag.current?.dy ?? 0;
    drag.current = null;
    const el = panelRef.current;
    if (el) {
      el.style.transition = "";
      el.style.transform = "";
    }
    if (dy > 80) onClose();
  }

  if (!mounted) return null;

  // Only reachable with keepMounted: parked out of sight and out of the tab
  // order, still mounted and still streaming.
  const parked = phase === "closed";

  return createPortal(
    <div
      {...stylex.props(styles.root, parked && styles.parked)}
      role="dialog"
      aria-modal={parked ? undefined : "true"}
      aria-label={label}
      aria-hidden={parked || undefined}
    >
      {!phonePage && (
        <div
          {...sx(
            [
              styles.backdrop,
              animated && [
                styles.fade,
                phone ? styles.fadePhone : styles.fadeDesktop,
                !shown && styles.hidden,
              ],
            ],
            backdropClassName,
          )}
          onClick={onClose}
        />
      )}
      <div
        ref={panelRef}
        tabIndex={-1}
        // Radii are authored the way base.css authors every corner in the
        // app, `calc(<px> * var(--rf))`, so they follow the squircle bump and
        // its circular fallback with everything else.
        {...sx(
          [
            styles.panel,
            phone ? (phonePage ? styles.page : styles.sheet) : styles.dialog,
            animated &&
              (phone
                ? [styles.slide, !shown && styles.slidOut]
                : [styles.pop, !shown && styles.poppedOut]),
          ],
          phone ? sheetClassName : modalClassName,
        )}
      >
        {phone && !phonePage && showPhoneGrabber && (
          <div
            {...stylex.props(styles.grabberRow)}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            <div {...stylex.props(styles.grabber)} />
          </div>
        )}
        {children instanceof Function ? children(onClose) : children}
      </div>
    </div>,
    document.body,
  );
}

/** Shared iOS-style chrome for icon actions in a phone sheet header. */
export function SheetIconButton({
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <PhoneTopBarAction className={className} icon={children} {...props} />;
}

/**
 * The scrolling, padded interior of a bottom sheet. `ResponsiveDialog` clips
 * its panel at 94dvh, so a sheet whose action list can grow has its own
 * scroller so every action stays reachable.
 */
export function SheetBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div {...sx(styles.body, className)}>{children}</div>;
}

/** The sheet's own heading — the object the actions below it act on. */
export function SheetTitle({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div {...sx(styles.title, className)}>{children}</div>;
}

/** Hairline between two groups of sheet actions. */
export function SheetSeparator({ className }: { className?: string }) {
  return <div {...sx(styles.separator, className)} />;
}

/**
 * A sheet action row. Thumb-sized and full-bleed, pressed rather than hovered
 * — a sheet only ever appears on touch.
 *
 * `tone` exists instead of a colour className because the row colours its icon
 * as well as its label, so each variant names both of its colours in one
 * place. The icon's colour is a descendant rule StyleX cannot write, so it
 * stays a utility until the icon is a part of the row.
 */
const SHEET_ITEM_ICON = {
  /** Icons stay quiet against the label: the legacy sheet's look. */
  default: "[&_svg]:text-faint",
  danger: "[&_svg]:text-red",
  accent: "[&_svg]:text-faint",
  green: "[&_svg]:text-faint",
  purple: "[&_svg]:text-faint",
} as const;

export type SheetItemTone = keyof typeof SHEET_ITEM_ICON;

export function SheetItem({
  tone = "default",
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: SheetItemTone }) {
  return (
    <button
      type="button"
      {...sx(
        [styles.item, styles[tone]],
        cn("[&_svg]:shrink-0", SHEET_ITEM_ICON[tone], className),
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

type PhoneSurfaceProps = {
  /** Called after the exit animation. Unmount the surface here. */
  onClose: () => void;
  /** Accessible dialog label. */
  label: string;
  /** Extra classes for the phone surface. */
  className?: string;
  children: React.ReactNode | ((dismiss: () => void) => React.ReactNode);
};

function DismissiblePhoneSurface({
  onClose,
  label,
  className,
  presentation,
  children,
}: PhoneSurfaceProps & { presentation: "sheet" | "page" }) {
  const [open, setOpen] = React.useState(true);
  const closingRef = React.useRef(false);

  const dismiss = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setOpen(false);
    setTimeout(onClose, SHEET_MS);
  };

  return (
    <ResponsiveDialog
      open={open}
      onClose={dismiss}
      phone
      label={label}
      phonePresentation={presentation}
      sheetClassName={className}
    >
      {children}
    </ResponsiveDialog>
  );
}

/** Phone-only bottom sheet with a self-closing contract. */
export function BottomSheet(props: PhoneSurfaceProps) {
  return <DismissiblePhoneSurface {...props} presentation="sheet" />;
}

/** Full-screen phone page that covers the current app surface. */
export function PhonePage(props: PhoneSurfaceProps) {
  return <DismissiblePhoneSurface {...props} presentation="page" />;
}
