import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { PhoneTopBarAction } from "./top-bar";

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
  children: React.ReactNode | ((dismiss: () => void) => React.ReactNode);
}) {
  const phonePage = phone && phonePresentation === "page";
  // Phone surfaces always animate. Desktop HUD-style overlays can opt out.
  const animated = phone || desktopTransition !== "none";
  const phase = usePhase(open, animated, phone ? SHEET_MS : MODAL_MS);
  const panelRef = React.useRef<HTMLDivElement>(null);

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
        // This capture listener runs before a portalled Base UI menu. Let the
        // menu consume the first Escape instead of closing the whole dialog.
        if (document.querySelector(".app-menu-popup")) return;
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
      const prev = restoreTo;
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
      className={cn(
        "fixed inset-0 z-[10000]",
        parked && "invisible pointer-events-none",
      )}
      role="dialog"
      aria-modal={parked ? undefined : "true"}
      aria-label={label}
      aria-hidden={parked || undefined}
    >
      {!phonePage && (
        <div
          className={cn(
            "absolute inset-0 bg-black/45",
            backdropClassName,
            animated && [
              "transition-opacity",
              phone ? "duration-[var(--dur-lg)]" : "duration-[var(--dur)]",
              shown ? "opacity-100" : "opacity-0",
            ],
          )}
          onClick={onClose}
        />
      )}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          // Radii are authored the way base.css authors every corner in the
          // app, `calc(<px> * var(--rf))`, so they follow the squircle bump
          // and its circular fallback with everything else.
          "absolute flex flex-col overflow-hidden outline-none [corner-shape:squircle]",
          phone
            ? phonePage
              ? "inset-0 h-dvh max-h-none rounded-none bg-surface pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-none"
              : "inset-x-0 bottom-0 max-h-[94dvh] rounded-t-[calc(var(--sheet-radius,34px)*var(--rf))] bg-surface pb-[env(safe-area-inset-bottom)] shadow-[0_-12px_40px_rgba(0,0,0,0.35)]"
            : "left-1/2 top-1/2 max-h-[85vh] w-[92vw] max-w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-[calc(18px*var(--rf))] bg-raised smooth-shadow-ring-lg",
          animated &&
            (phone
              ? [
                  "transition-transform duration-[var(--dur-lg)] ease-[var(--ease)]",
                  shown ? "translate-y-0" : "translate-y-full",
                ]
              : [
                  "origin-center transition-[transform,opacity] duration-[var(--dur)] ease-[var(--ease)]",
                  shown ? "scale-100 opacity-100" : "scale-[0.96] opacity-0",
                ]),
          phone ? sheetClassName : modalClassName,
        )}
      >
        {phone && !phonePage && showPhoneGrabber && (
          <div
            className="flex shrink-0 touch-none justify-center pb-1.5 pt-2.5"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            <div className="h-[5px] w-9 rounded-full bg-active" />
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
  return (
    <div
      className={cn(
        "min-h-0 overflow-y-auto overscroll-contain px-2.5 pb-3.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The sheet's own heading — the object the actions below it act on. */
export function SheetTitle({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "truncate px-3 pb-2 pt-1.5 text-label text-faint",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Hairline between two groups of sheet actions. */
export function SheetSeparator({ className }: { className?: string }) {
  return <div className={cn("mx-2.5 my-1.5 h-px bg-line", className)} />;
}

/**
 * A sheet action row. Thumb-sized and full-bleed, pressed rather than hovered
 * — a sheet only ever appears on touch.
 *
 * `tone` exists instead of a colour className because the row colours its icon
 * as well as its label: two `text-*` utilities aimed at the same subject don't
 * compose, so each variant has to name both of its colours in one place.
 */
const SHEET_ITEM_TONE = {
  /** Icons stay quiet against the label — the legacy sheet's look. */
  default: "text-fg [&_svg]:text-faint",
  danger: "text-red [&_svg]:text-red",
  accent: "font-semibold text-accent [&_svg]:text-faint",
  green: "font-semibold text-green [&_svg]:text-faint",
  purple: "font-semibold text-purple [&_svg]:text-faint",
} as const;

export type SheetItemTone = keyof typeof SHEET_ITEM_TONE;

export function SheetItem({
  tone = "default",
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: SheetItemTone }) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-[13px] rounded-control px-3.5 py-[15px] text-left text-body active:bg-pressed [&_svg]:shrink-0",
        SHEET_ITEM_TONE[tone],
        className,
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
