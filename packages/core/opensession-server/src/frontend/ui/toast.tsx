import { Toast as BaseToast } from "@base-ui/react/toast";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  IconArchive,
  IconArrowUp,
  IconBranches,
  IconCopy,
  IconLink,
  IconPlay,
  IconPlug,
  IconPlus,
  IconRestore,
  IconServer,
  IconTrash,
} from "../components/icons";
import { useIsPhone } from "../hooks/useIsPhone";
import {
  ONGOING_TOAST_POSITION,
  TOAST_NOTICE_LANE,
} from "../lib/notification-classes";
import { toastIconName, type ToastIconName } from "../lib/toast-icon";
import { AnimatedCheck } from "./copy";
import { cn } from "./cn";
import { SELECTABLE } from "./dialog-styles";
import { focusStyles } from "./focus-styles";
import { Spinner } from "./spinner";
import {
  color,
  controlHeight,
  corner,
  geometry,
  leading,
  media,
  motion,
  radius,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex";
import { Tooltip } from "./tooltip";
import {
  clearUndoAction,
  isEditableUndoTarget,
  isUndoShortcut,
  registerUndoAction,
  UNDO_SHORTCUT_KEYS,
  undoLatestAction,
  type UndoHandle,
} from "../lib/undo";

export type ToastVariant = "default" | "success" | "error";

/** One action beside a message. A toast that needs a choice is a dialog. */
export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type ToastOptions = {
  variant?: ToastVariant;
  /** Defaults: 3200ms, 4200ms for errors, and 7000ms with an action. */
  duration?: number;
  /** Keeps live status visible until its owner dismisses it. */
  ongoing?: boolean;
  action?: ToastAction;
};

export type Toast = {
  id: number;
  message: string;
  variant: ToastVariant;
  ongoing?: boolean;
  action?: ToastAction;
};

type ToastData = {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
  ongoing?: boolean;
  action?: ToastAction;
};

const MAX_VISIBLE = 3;
const manager = BaseToast.createToastManager<ToastData>();
let toasts: Toast[] = [];
let nextId = 1;
const undoHandles = new Map<number, UndoHandle>();

function managerId(id: number) {
  return `opensession-toast-${id}`;
}

function inferVariant(message: string): ToastVariant {
  if (
    /\b(could not|couldn'?t|can not|can'?t|failed|failure|error|nothing|missed|lost|unavailable)\b|\bno\s|larger than|waiting for approval/i.test(
      message,
    )
  )
    return "error";
  if (
    /\b(copied|saved|done|created|sent|updated|added|removed|enabled|disabled|registered|connected|disconnected|linked|unlinked|archived|reopened|restored|forgotten|started|works|restarted|switched)\b/i.test(
      message,
    )
  )
    return "success";
  return "default";
}

function removeToastState(id: number) {
  toasts = toasts.filter((item) => item.id !== id);
  clearUndoAction(undoHandles.get(id));
  undoHandles.delete(id);
}

function runToastAction(id: number) {
  const item = toasts.find((candidate) => candidate.id === id);
  if (!item?.action) return;
  dismissToast(id);
  item.action.onClick();
}

/** Fire an app-wide toast. Returns its id so callers can close it early. */
export function toast(message: string, options: ToastOptions = {}): number {
  // Link controls already confirm the copy inline or through the platform share
  // surface. A second floating receipt repeats the same result in a louder place.
  if (/\blink copied\b/i.test(message)) return 0;

  const id = nextId++;
  const variant = options.variant ?? inferVariant(message);
  const item: Toast = {
    id,
    message,
    variant,
    ongoing: options.ongoing,
    action: options.action,
  };
  toasts = [...toasts, item];

  if (item.action?.label.toLowerCase() === "undo") {
    undoHandles.set(
      id,
      registerUndoAction(`toast:${id}`, () => runToastAction(id)),
    );
  }

  if (toasts.length > MAX_VISIBLE) {
    const overflow = toasts.slice(0, toasts.length - MAX_VISIBLE);
    for (const old of overflow) {
      removeToastState(old.id);
      manager.close(managerId(old.id));
    }
  }

  const duration =
    options.duration ??
    (options.ongoing
      ? 0
      : options.action
        ? 7000
        : variant === "error"
          ? 4200
          : 3200);
  manager.add({
    id: managerId(id),
    description: message,
    type: variant,
    timeout: duration,
    data: { ...item, duration },
    onClose: () => removeToastState(id),
  });
  return id;
}

export function dismissToast(id: number) {
  removeToastState(id);
  manager.close(managerId(id));
}

/** The visible stack, exposed for store-level tests. */
export function activeToasts(): readonly Toast[] {
  return toasts;
}

/**
 * Base UI owns measurement, stacking, hover and focus expansion, timer pausing,
 * swipe dismissal, and accessibility. Keep one host mounted at the app root.
 */
export function ToastHost({ container }: { container?: HTMLElement | null }) {
  return (
    <BaseToast.Provider toastManager={manager} limit={MAX_VISIBLE}>
      <ToastViewport container={container} />
    </BaseToast.Provider>
  );
}

function ToastViewport({ container }: { container?: HTMLElement | null }) {
  const { toasts: items } = BaseToast.useToastManager<ToastData>();
  const isPhone = useIsPhone();
  const viewportRef = useRef<HTMLDivElement>(null);

  // Desktop aligns to the rendered composer rather than the window. Its centre
  // moves with the sidebar, workspace panel, and summary-card transform.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !container || isPhone) return;
    let composer: Element | null = null;
    let frame = 0;
    const resizeObserver = new ResizeObserver(() => scheduleAlign());
    const align = () => {
      frame = 0;
      const nextComposer = container.querySelector(".composer");
      if (nextComposer !== composer) {
        if (composer) resizeObserver.unobserve(composer);
        composer = nextComposer;
        if (composer) resizeObserver.observe(composer);
      }
      if (!composer) {
        viewport.style.left = "0px";
        viewport.style.right = "0px";
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const left = `${Math.max(0, Math.round(composerRect.left - containerRect.left))}px`;
      const right = `${Math.max(0, Math.round(containerRect.right - composerRect.right))}px`;
      if (viewport.style.left !== left) viewport.style.left = left;
      if (viewport.style.right !== right) viewport.style.right = right;
    };
    function scheduleAlign() {
      if (!frame) frame = requestAnimationFrame(align);
    }
    resizeObserver.observe(container);
    const mutationObserver = new MutationObserver((mutations) => {
      if (mutations.every(({ target }) => viewport.contains(target))) return;
      scheduleAlign();
    });
    mutationObserver.observe(container, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["class", "style"],
    });
    window.addEventListener("resize", scheduleAlign);
    align();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleAlign);
    };
  }, [container, isPhone, items.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !isUndoShortcut(event) ||
        isEditableUndoTarget(event.target) ||
        !undoLatestAction()
      )
        return;
      event.preventDefault();
      // The archive fallback also listens on window. Only one reversible
      // action should consume this Command-Z.
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <BaseToast.Portal container={container ?? undefined}>
      <BaseToast.Viewport
        ref={viewportRef}
        // `toast-viewport` is the hook ToastProgress finds its stack by.
        className={cn(
          stylex.props(
            styles.viewport,
            container ? styles.inContainer : styles.onScreen,
          ).className,
          "toast-viewport",
          TOAST_NOTICE_LANE,
        )}
      >
        {items.map((item) => (
          <ToastCard key={item.id} toast={item} />
        ))}
      </BaseToast.Viewport>
    </BaseToast.Portal>
  );
}

function ToastCard({
  toast: item,
}: {
  toast: BaseToast.Root.ToastObject<ToastData>;
}) {
  const data = item.data;
  if (!data) return null;
  const iconName = toastIconName(data.message, data.variant);

  return (
    <BaseToast.Root
      toast={item}
      // Receipts rise above the composer at every width, so swiping down
      // follows the nearest screen edge. Live status is passive and stays
      // until the process that owns it dismisses it.
      swipeDirection={data.ongoing ? [] : ["down", "right"]}
      onClick={data.ongoing ? undefined : () => dismissToast(data.id)}
      className={cn(
        stylex.props(
          styles.root,
          data.ongoing ? styles.passive : styles.interactive,
          !data.ongoing && styles.notice,
        ).className,
        data.ongoing && ONGOING_TOAST_POSITION,
      )}
    >
      <BaseToast.Content
        className={cn(
          stylex.props(
            styles.pill,
            iconName ? styles.pillIconStart : styles.pillTextStart,
            data.action ? styles.pillActionEnd : styles.pillTextEnd,
          ).className,
          SELECTABLE,
        )}
      >
        <ToastStatusIcon name={iconName} ongoing={data.ongoing} />
        {/* Description renders a <p>; remove its browser margins so the
				    visible height comes from the pill padding alone. */}
        <BaseToast.Description
          className={stylex.props(styles.message).className}
          title={data.message}
        >
          {data.message}
        </BaseToast.Description>
        {data.action && (
          <Tooltip label="Undo" shortcut={UNDO_SHORTCUT_KEYS}>
            <BaseToast.Action
              onClick={(event) => {
                event.stopPropagation();
                runToastAction(data.id);
              }}
              // The pill stays tight, so the action carries the finger
              // target on its own: 28px of box inside a 44px tap area.
              className={
                stylex.props(styles.action, focusStyles.ring).className
              }
            >
              {data.action.label}
            </BaseToast.Action>
          </Tooltip>
        )}
        {!data.ongoing && data.duration > 0 && (
          <ToastProgress duration={data.duration} />
        )}
      </BaseToast.Content>
    </BaseToast.Root>
  );
}

function ToastStatusIcon({
  name,
  ongoing,
}: {
  name: ToastIconName | null;
  ongoing?: boolean;
}) {
  const className = stylex.props(styles.glyph).className;
  if (ongoing)
    return <Spinner className={stylex.props(styles.dim).className} />;

  switch (name) {
    case "archive":
      return <IconArchive size={14} className={className} aria-hidden />;
    case "branches":
      return <IconBranches size={14} className={className} aria-hidden />;
    case "check":
      return <AnimatedCheck size={14} className={className} />;
    case "copy":
      return <IconCopy size={14} className={className} aria-hidden />;
    case "link":
      return <IconLink size={14} className={className} aria-hidden />;
    case "play":
      return <IconPlay size={14} className={className} aria-hidden />;
    case "plug":
      return <IconPlug size={14} className={className} aria-hidden />;
    case "plus":
      return <IconPlus size={14} className={className} aria-hidden />;
    case "restore":
      return <IconRestore size={14} className={className} aria-hidden />;
    case "send":
      return <IconArrowUp size={14} className={className} aria-hidden />;
    case "server":
      return <IconServer size={14} className={className} aria-hidden />;
    case "trash":
      return <IconTrash size={14} className={className} aria-hidden />;
    case "error":
      return (
        <span aria-hidden {...stylex.props(styles.errorGlyph)}>
          !
        </span>
      );
    default:
      return null;
  }
}

/**
 * A visual timer that follows Base UI's pause rules. The store pauses expiry
 * while the stack is hovered, focused, or the tab is hidden; this line reads
 * the same viewport state and advances only while the timer can advance.
 */
function ToastProgress({ duration }: { duration: number }) {
  const lineRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const line = lineRef.current;
    if (!line || duration <= 0) return;
    let elapsed = 0;
    let previous = performance.now();
    let frame = 0;

    const resetClock = () => {
      previous = performance.now();
    };
    const draw = (now: number) => {
      const viewport = line.closest(".toast-viewport");
      const paused =
        document.visibilityState !== "visible" ||
        viewport?.hasAttribute("data-expanded");
      if (!paused) elapsed += now - previous;
      previous = now;
      line.style.transform = `scaleX(${Math.max(0, 1 - elapsed / duration)})`;
      if (elapsed < duration) frame = requestAnimationFrame(draw);
    };

    document.addEventListener("visibilitychange", resetClock);
    frame = requestAnimationFrame(draw);
    return () => {
      document.removeEventListener("visibilitychange", resetClock);
      cancelAnimationFrame(frame);
    };
  }, [duration]);

  return <span ref={lineRef} aria-hidden {...stylex.props(styles.progress)} />;
}

/** A tone's ink at a fixed strength over whatever is behind it. */
const ink = (c: string, pct: number) =>
  `color-mix(in oklab, ${c} ${pct}%, transparent)`;

// Base UI positions the stack through custom properties on each toast: its
// index from the front, the swipe in flight, and (expanded) its offset.
const stacked = `translateX(calc(-50% + var(--toast-swipe-movement-x))) translateY(calc(var(--toast-swipe-movement-y) - var(--toast-index) * ${geometry.toastStackStep})) scale(calc(1 - (var(--toast-index) * ${geometry.toastStackShrink})))`;
const expanded = `translateX(calc(-50% + var(--toast-swipe-movement-x))) translateY(calc(var(--toast-swipe-movement-y) - var(--toast-offset-y) - var(--toast-index) * ${geometry.toastStackStep})) scale(1)`;

const styles = stylex.create({
  viewport: {
    marginInline: "auto",
    height: geometry.toastFrontHeight,
    width: { default: geometry.toastMaxWidth, [media.phone]: "100%" },
    paddingInline: { default: null, [media.phone]: space.s12 },
    outline: "none",
  },
  onScreen: { position: "fixed" },
  inContainer: { position: "absolute" },
  root: {
    left: "50%",
    width: "max-content",
    maxWidth: { default: "100%", [media.phone]: geometry.toastMaxWidthPhone },
    outline: "none",
    zIndex: "calc(100 - var(--toast-index))",
    transformOrigin: "center bottom",
    transform: { default: stacked, ":is([data-expanded])": expanded },
    transitionProperty: {
      default: "transform, translate, scale, opacity",
      [media.reducedMotion]: "opacity",
    },
    transitionDuration: motion.standard,
    transitionTimingFunction: motion.toastEase,
    opacity: {
      default: null,
      ":is([data-starting-style])": 0,
      ":is([data-ending-style])": 0,
      ":is([data-limited])": 0,
    },
    translate: {
      default: null,
      ":is([data-starting-style])": {
        default: motion.toastDrop,
        [media.reducedMotion]: "0 0",
      },
      ":is([data-ending-style])": {
        default: motion.toastDrop,
        [media.reducedMotion]: "0 0",
      },
    },
    scale: {
      default: null,
      ":is([data-starting-style])": {
        default: motion.toastScale,
        [media.reducedMotion]: 1,
      },
      ":is([data-ending-style])": {
        default: motion.toastScale,
        [media.reducedMotion]: 1,
      },
    },
  },
  interactive: { pointerEvents: "auto" },
  passive: { pointerEvents: "none" },
  notice: { position: "absolute", bottom: space.s0 },
  // A capsule, squircled like every other rounded surface.
  pill: {
    position: "relative",
    display: "flex",
    maxWidth: "100%",
    alignItems: "center",
    gap: space.s8,
    overflow: "hidden",
    whiteSpace: "normal",
    borderRadius: radius.capsule,
    ["cornerShape"]: corner.squircle,
    borderWidth: geometry.hairline,
    borderStyle: "solid",
    borderColor: color.dividerSoft,
    backgroundColor: color.popup,
    paddingBlock: space.s6,
    fontSize: text.label,
    fontWeight: weight.medium,
    lineHeight: leading.tight,
    color: color.fg,
    boxShadow: shadow.md,
  },
  pillIconStart: { paddingInlineStart: space.s10 },
  pillTextStart: { paddingInlineStart: space.s12 },
  pillActionEnd: { paddingInlineEnd: space.s6 },
  pillTextEnd: { paddingInlineEnd: space.s12 },
  // Description renders a <p>; its browser margins would add to the pill.
  message: {
    marginBlock: space.s0,
    minWidth: 0,
    display: "-webkit-box",
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
  // The pill stays tight, so the action carries the finger target on its
  // own: 28px of box inside a 44px tap area.
  action: {
    position: "relative",
    marginBlock: {
      default: `calc(-1 * ${space.s4})`,
      [media.phone]: `calc(-1 * ${space.s6})`,
    },
    marginInlineStart: { default: space.s4, [media.phone]: space.s2 },
    display: { default: null, [media.phone]: "grid" },
    minHeight: { default: null, [media.phone]: geometry.rowMenuTrigger },
    flexShrink: 0,
    placeItems: { default: null, [media.phone]: "center" },
    cursor: "pointer",
    borderRadius: { default: radius.md, [media.phone]: radius.capsule },
    ["cornerShape"]: corner.squircle,
    paddingInline: { default: space.s8, [media.phone]: space.s10 },
    paddingBlock: space.s4,
    fontSize: text.label,
    fontWeight: weight.strong,
    color: color.accentInk,
    backgroundColor: {
      default: null,
      ":hover": { default: null, [media.hover]: color.hover },
    },
    scale: { default: null, ":active": motion.pressScale },
    transitionProperty: "background-color, scale",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    "::after": {
      content: { default: null, [media.phone]: "''" },
      position: { default: null, [media.phone]: "absolute" },
      insetInline: { default: null, [media.phone]: space.s0 },
      top: { default: null, [media.phone]: "50%" },
      height: { default: null, [media.phone]: controlHeight.touch },
      translate: { default: null, [media.phone]: "0 -50%" },
    },
  },
  glyph: { flexShrink: 0, color: color.dim },
  dim: { color: color.dim },
  errorGlyph: {
    display: "grid",
    width: space.s14,
    height: space.s14,
    flexShrink: 0,
    placeItems: "center",
    borderRadius: radius.pill,
    fontSize: text.meta,
    fontWeight: weight.strong,
    color: color.dim,
  },
  progress: {
    pointerEvents: "none",
    position: "absolute",
    insetInline: space.s0,
    bottom: space.s0,
    height: space.s2,
    transformOrigin: "left",
    backgroundColor: ink(color.dim, 35),
  },
});
