import { mergeStylexOverrideClassName } from "./cn";
import { utilityClassName } from "./cn";
import { Toast as BaseToast } from "@base-ui/react/toast";
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
import { Spinner } from "./spinner";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  my0: {
    marginBlock: "0",
  },
  minW0: {
    minWidth: "0",
  },
  lineClamp2: {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: "2",
  },
  relative: {
    position: "relative",
  },
  My1: {
    marginBlock: "calc(4px * -1)",
  },
  ml1: {
    marginLeft: "4px",
  },
  shrink0: {
    flexShrink: "0",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py1: {
    paddingBlock: "4px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  transitionBackgroundColorTransform: {
    transitionProperty: "background-color,transform",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  duration150: {
    transitionDuration: "150ms",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  activeScale096: {
    ":active": {
      scale: "0.96",
    },
  },
  phoneMy15: {
    "@media (max-width: 720px)": {
      marginBlock: "calc(4px * -1.5)",
    },
  },
  phoneMl05: {
    "@media (max-width: 720px)": {
      marginLeft: "calc(4px * 0.5)",
    },
  },
  phoneGrid: {
    "@media (max-width: 720px)": {
      display: "grid",
    },
  },
  phoneMinH7: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 7)",
    },
  },
  phonePlaceItemsCenter: {
    "@media (max-width: 720px)": {
      placeItems: "center",
    },
  },
  phoneRounded999px: {
    "@media (max-width: 720px)": {
      borderRadius: "999px",
      cornerShape: "var(--cs)",
    },
  },
  phonePx25: {
    "@media (max-width: 720px)": {
      paddingInline: "calc(4px * 2.5)",
    },
  },
  phoneAfterAbsolute: {
    "@media (max-width: 720px)": {
      "::after": {
        content: '""',
        position: "absolute",
      },
    },
  },
  phoneAfterInsetX0: {
    "@media (max-width: 720px)": {
      "::after": {
        content: '""',
        insetInline: "0",
      },
    },
  },
  phoneAfterTop12: {
    "@media (max-width: 720px)": {
      "::after": {
        content: '""',
        top: "calc(1 / 2 * 100%)",
      },
    },
  },
  phoneAfterH11: {
    "@media (max-width: 720px)": {
      "::after": {
        content: '""',
        height: "calc(4px * 11)",
      },
    },
  },
  phoneAfterTranslateY12: {
    "@media (max-width: 720px)": {
      "::after": {
        content: '""',
        translate: "0 calc(calc(1 / 2 * 100%) * -1)",
      },
    },
  },
  phoneAfterContent: {
    "@media (max-width: 720px)": {
      "::after": {
        content: "''",
      },
    },
  },
  textDim: {
    color: "var(--text-dim)",
  },
  grid: {
    display: "grid",
  },
  size35: {
    width: "calc(4px * 3.5)",
    height: "calc(4px * 3.5)",
  },
  placeItemsCenter: {
    placeItems: "center",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  insetX0: {
    insetInline: "0",
  },
  bottom0: {
    bottom: "0",
  },
  h05: {
    height: "calc(4px * 0.5)",
  },
  originLeft: {
    transformOrigin: "0",
  },
  bgDim35: {
    backgroundColor: "color-mix(in oklab, var(--text-dim) 35%, transparent)",
  },
});

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
        className={utilityClassName(
          `${TOAST_NOTICE_LANE} ${container ? "absolute" : "fixed"} toast-viewport mx-auto h-[var(--toast-frontmost-height)] w-[min(480px,calc(100vw-32px))] outline-none phone:w-full phone:px-3`,
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
      className={[
        `${data.ongoing ? "pointer-events-none" : "pointer-events-auto"} left-1/2 w-max max-w-full outline-none phone:max-w-[calc(100vw-24px)]`,
        data.ongoing ? ONGOING_TOAST_POSITION : "absolute bottom-0",
        "[z-index:calc(100-var(--toast-index))] [transform-origin:center_bottom]",
        "[transform:translateX(calc(-50%+var(--toast-swipe-movement-x)))_translateY(calc(var(--toast-swipe-movement-y)-var(--toast-index)*8px))_scale(calc(1-(var(--toast-index)*0.04)))]",
        "data-[expanded]:[transform:translateX(calc(-50%+var(--toast-swipe-movement-x)))_translateY(calc(var(--toast-swipe-movement-y)-var(--toast-offset-y)-var(--toast-index)*8px))_scale(1)]",
        "transition-[transform,translate,scale,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-opacity",
        "data-[starting-style]:opacity-0 data-[starting-style]:[translate:0_8px] data-[starting-style]:[scale:0.96] data-[ending-style]:opacity-0 data-[ending-style]:[translate:0_8px] data-[ending-style]:[scale:0.96] data-[limited]:opacity-0 motion-reduce:data-[starting-style]:[translate:0_0] motion-reduce:data-[starting-style]:[scale:1] motion-reduce:data-[ending-style]:[translate:0_0] motion-reduce:data-[ending-style]:[scale:1]",
      ].join(" ")}
    >
      <BaseToast.Content
        className={[
          "relative flex max-w-full items-center gap-2 overflow-hidden whitespace-normal rounded-[999px] border border-divider-soft bg-popup",
          "py-1.5 text-supporting font-medium leading-tight text-fg smooth-shadow-md",
          iconName ? "pl-2.5" : "pl-3",
          data.action ? "pr-1.5" : "pr-3",
        ].join(" ")}
      >
        <ToastStatusIcon name={iconName} ongoing={data.ongoing} />
        {/* Description renders a <p>; remove its browser margins so the
				    visible height comes from the pill padding alone. */}
        <BaseToast.Description
          className={mergeStylexOverrideClassName(
            "",
            sx.my0,
            sx.minW0,
            sx.lineClamp2,
          )}
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
              className={mergeStylexOverrideClassName(
                "focus-ring text-accent",
                sx.relative,
                sx.My1,
                sx.ml1,
                sx.shrink0,
                sx.cursorPointer,
                sx.roundedMd,
                sx.px2,
                sx.py1,
                sx.fontSemibold,
                sx.transitionBackgroundColorTransform,
                sx.duration150,
                sx.hoverBgHover,
                sx.activeScale096,
                sx.phoneMy15,
                sx.phoneMl05,
                sx.phoneGrid,
                sx.phoneMinH7,
                sx.phonePlaceItemsCenter,
                sx.phoneRounded999px,
                sx.phonePx25,
                sx.phoneAfterAbsolute,
                sx.phoneAfterInsetX0,
                sx.phoneAfterTop12,
                sx.phoneAfterH11,
                sx.phoneAfterTranslateY12,
                sx.phoneAfterContent,
                typography.supporting,
              )}
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
  const className = utilityClassName("shrink-0 text-dim");
  if (ongoing)
    return <Spinner className={mergeStylexOverrideClassName("", sx.textDim)} />;

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
        <span
          aria-hidden
          {...stylex.props(
            sx.grid,
            sx.size35,
            sx.shrink0,
            sx.placeItemsCenter,
            sx.roundedFull,
            sx.fontSemibold,
            sx.textDim,
            typography.meta,
          )}
        >
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

  return (
    <span
      ref={lineRef}
      aria-hidden
      {...stylex.props(
        sx.pointerEventsNone,
        sx.absolute,
        sx.insetX0,
        sx.bottom0,
        sx.h05,
        sx.originLeft,
        sx.bgDim35,
      )}
    />
  );
}
