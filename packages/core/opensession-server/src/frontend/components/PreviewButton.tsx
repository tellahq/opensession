import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { useEffect, useRef, useState } from "react";
import {
  fetchPreview,
  startPreviewApi,
  stopPreviewApi,
  capturePreviewShot,
  type PreviewStatus,
} from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { BASE_PATH } from "../lib/base";
import { withPreviewPath } from "../lib/preview-url";
import { errorMessage } from "../lib/error-message";
import { Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { CopyCheck, useCopy } from "../ui/copy";
import { Menu, MENU_ICON } from "../ui/menu";
import { Popover } from "../ui/popover";
import {
  IconArrowUpRight,
  IconCamera,
  IconChevronDown,
  IconLink,
  IconPlay,
  IconPlayOutline,
} from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  grow: {
    flexGrow: "1",
  },
  fixed: {
    position: "fixed",
  },
  inset0: {
    inset: "0",
  },
  z300: {
    zIndex: "300",
  },
  bgBlack60: {
    backgroundColor: "color-mix(in oklab, var(--color-black) 60%, transparent)",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  p6: {
    padding: "calc(4px * 6)",
  },
  bgRaised: {
    backgroundColor: "var(--bg-raised)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  roundedPanel: {
    borderRadius: "calc(var(--radius) * var(--rf))",
    cornerShape: "var(--cs)",
  },
  smoothShadowLg: {
    boxShadow:
      "0 4px 12px -4px color-mix(in srgb, var(--smooth-shadow-color) 5%, transparent), 0 18px 48px -14px color-mix(in srgb, var(--smooth-shadow-color) 11%, transparent)",
  },
  p3: {
    padding: "calc(4px * 3)",
  },
  maxW90vw: {
    maxWidth: "90vw",
  },
  maxH90vh: {
    maxHeight: "90vh",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  textRed: {
    color: "var(--red)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  maxH75vh: {
    maxHeight: "75vh",
  },
  objectContain: {
    objectFit: "contain",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  justifyEnd: {
    justifyContent: "flex-end",
  },
  px14px: {
    paddingInline: "14px",
  },
  py1: {
    paddingBlock: "4px",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  minH26px: {
    minHeight: "26px",
  },
  whitespaceNowrap: {
    whiteSpace: "nowrap",
  },
  roundedXs: {
    borderRadius: "calc(2px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgControl: {
    backgroundColor: "var(--control-surface)",
  },
  px25: {
    paddingInline: "calc(4px * 2.5)",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  smoothShadowSm: {
    boxShadow:
      "0 1px 3px -1px color-mix(in srgb, var(--smooth-shadow-color) 6%, transparent), 0 4px 10px -4px color-mix(in srgb, var(--smooth-shadow-color) 9%, transparent)",
  },
  transition: {
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  hoverBorderLineStrong: {
    "@media (hover: hover)": {
      ":hover": {
        borderColor: "var(--border-strong)",
      },
    },
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  activeScale097: {
    ":active": {
      scale: "0.97",
    },
  },
  minW240px: {
    minWidth: "240px",
  },
  p25: {
    padding: "calc(4px * 2.5)",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  fontBold: {
    fontWeight: "var(--font-weight-bold)",
  },
  tracking001em: {
    letterSpacing: "-0.01em",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  px0: {
    paddingInline: "0",
  },
  listNone: {
    listStyleType: "none",
  },
  gap5px: {
    gap: "5px",
  },
  p0: {
    padding: "0",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  gap7px: {
    gap: "7px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  underline: {
    textDecorationLine: "underline",
  },
  decorationTransparent: {
    textDecorationColor: "transparent",
  },
  underlineOffset2: {
    textUnderlineOffset: "2px",
  },
  transitionTextDecorationColor: {
    transitionProperty: "text-decoration-color",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  hoverDecorationCurrent: {
    "@media (hover: hover)": {
      ":hover": {
        textDecorationColor: "currentcolor",
      },
    },
  },
  focusVisibleDecorationCurrent: {
    ":focus-visible": {
      textDecorationColor: "currentcolor",
    },
  },
  mt15: {
    marginTop: "calc(4px * 1.5)",
  },
  textCenter: {
    textAlign: "center",
  },
  size5: {
    width: "calc(4px * 5)",
    height: "calc(4px * 5)",
  },
  shrink0: {
    flexShrink: "0",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  relative: {
    position: "relative",
  },
  w8: {
    width: "calc(4px * 8)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  roundedLNone: {
    borderTopLeftRadius: "0",
    borderBottomLeftRadius: "0",
    cornerShape: "var(--cs)",
  },
  outlineNone: {
    outlineStyle: "none",
  },
  transitionColors: {
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  focusVisibleBgHover: {
    ":focus-visible": {
      backgroundColor: "var(--hover)",
    },
  },
  focusVisibleTextFg: {
    ":focus-visible": {
      color: "var(--text)",
    },
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  left12: {
    left: "calc(1 / 2 * 100%)",
  },
  top12: {
    top: "calc(1 / 2 * 100%)",
  },
  size25px: {
    width: "25px",
    height: "25px",
  },
  TranslateX12: {
    translate: "calc(calc(1 / 2 * 100%) * -1) 0",
  },
  TranslateY12: {
    translate: "0 calc(calc(1 / 2 * 100%) * -1)",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  borderTransparent: {
    borderColor: "transparent",
  },
  borderTCurrent: {
    borderTopColor: "currentcolor",
  },
  opacity90: {
    opacity: "90%",
  },
  animatePreviewSpin07sLinearInfinite: {
    animation: "preview-spin 0.7s linear infinite",
  },
  itemsStretch: {
    alignItems: "stretch",
  },
  MlPx: {
    marginLeft: "-1px",
  },
  opacity80: {
    opacity: "80%",
  },
  inline: {
    display: "inline",
  },
  hidden: {
    display: "none",
  },
});

// Any worktree session gets the control; whether a repo can actually boot a
// preview comes back on the status itself (`bootable` — repo-committed
// .agents/start.sh → configured previewCommand).
// Repos with no mechanism show a disabled button explaining what to add.
function isPreviewable(session: UnifiedSession): boolean {
  return !!session.worktreeDir;
}

const headerIconBase = utilityClassName(
  "inline-flex cursor-pointer items-center justify-center rounded-md border border-transparent bg-transparent px-[5px] py-[3px] text-faint no-underline",
);

const splitSegmentBase = utilityClassName(
  "inline-flex items-center justify-center border border-line-strong bg-transparent text-dim",
);

const spinnerClass = utilityClassName(
  "size-[10px] shrink-0 rounded-full border border-line-strong border-t-accent animate-[preview-spin_0.7s_linear_infinite]",
);

const popoverActionClass = utilityClassName(
  "w-full rounded-control border border-[color-mix(in_srgb,var(--red)_40%,transparent)] bg-transparent px-2.5 py-[5px] text-xs font-semibold text-red disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent hover:bg-[color-mix(in_srgb,var(--red)_12%,transparent)]",
);

/**
 * Header control for a session's local dev server ("Preview"). When the
 * webapp is up it links to it (`https://<host>:<httpsPort>` — a Caddy-fronted
 * secure origin over the tailnet); when it's off, a ▶ play button starts it
 * (runs the repo's preview boot script in the worktree), showing a
 * "Starting…" state until the server is listening. A caret popover lists the
 * dev services and can stop them. Renders for any session with a worktree;
 * repos without a boot mechanism get a disabled state pointing at the docs.
 */
export function PreviewButton({
  session,
  onAttachImage,
  onStatusChange,
  onOpenTab,
  variant = "bar",
}: {
  session: UnifiedSession;
  /** Open the in-app Preview view-tab instead of a new window/interstitial —
   *  the default wherever App provides it (the Mac shell turned window.opens
   *  into stray Electron windows). The interstitial flow stays for contexts
   *  without a tab (phones, PreviewWait deep links). */
  onOpenTab?: () => void;
  /** When set, the snapshot modal offers "Attach to session" (stages the PNG as a
   *  composer image, like a paste). */
  onAttachImage?: (dataUrl: string) => void;
  /** Mirrors the polled status to the parent so other preview affordances can
   *  appear and disappear with the dev server without polling it twice. */
  onStatusChange?: (status: PreviewStatus | null) => void;
  /** "bar" = the full segmented split button (right panel's action row);
   *  "header" = a single state-colored ▶ icon for the session header, sized to
   *  match the panel-toggle icon it sits beside. "action" = a compact cell for
   *  the mobile workspace Actions grid. "menu" = a single overflow-menu row. */
  variant?: "bar" | "header" | "action" | "menu";
}) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy();

  const previewable = isPreviewable(session);

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  // Poll the dev-server status while this session is open. Poll faster while a
  // bring-up is in flight so the button flips to the live link promptly; `ss`
  // is cheap and only the active SessionViewer is mounted.
  const busy = starting || (status?.starting ?? false);
  useEffect(() => {
    if (!previewable) {
      setStatus(null);
      return;
    }
    let alive = true;
    const load = () =>
      fetchPreview(session.id)
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    load();
    const t = setInterval(load, busy ? 3000 : 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [session.id, previewable, busy]);

  // Once the webapp is actually up, drop the optimistic "starting" flag.
  useEffect(() => {
    if (status?.running) setStarting(false);
  }, [status?.running]);

  // Dismissal (outside press, Escape) comes from ui/popover — the popup is
  // portalled, so a hand-rolled "outside click" test against wrapRef would
  // read every press inside the popup as outside and close it.

  if (!previewable) return null;

  // The webapp is only openable once Caddy has fronted it with an HTTPS origin
  // (previewUrl). A secure origin is required for the app to load fully.
  const running = !!status?.running && status.previewUrl != null;
  // Deep-link to the route the agent flagged (set_preview_path), so the human
  // lands on the feature under test instead of the app root.
  const url = status?.previewUrl
    ? withPreviewPath(status.previewUrl, session.previewPath)
    : "#";
  const anyRunning = status?.services.some((s) => s.running) ?? false;
  const isStarting = busy && !running;
  // Absent on pre-field servers — treat as bootable so the button still works
  // against a not-yet-restarted backend.
  const bootable = status?.bootable !== false;
  const notBootableHint = `No preview boot mechanism for this repo. Commit an .agents/start.sh to the repo, or set previewCommand on its repos config entry.`;

  // The menu row renders before the status lands, unlike every other variant.
  // A control in a toolbar can afford to not exist until there is something to
  // preview; a row in a menu cannot, because it appears under a cursor that is
  // already moving down the list and pushes everything below it. `previewable`
  // is a synchronous read of the session, so the row is decided the moment the
  // menu opens and only its label and colour fill in afterwards.
  if (variant === "menu") {
    return (
      <Menu.Item
        disabled={!bootable && !isStarting}
        onClick={() => {
          if (isStarting) void stop();
          else void start();
        }}
        title={bootable ? "Open or start the local preview" : notBootableHint}
      >
        {isStarting ? (
          <span className={spinnerClass} />
        ) : (
          <IconPlayOutline
            size={20}
            className={running ? utilityClassName("text-green") : MENU_ICON}
          />
        )}
        <span {...stylex.props(sx.grow)}>
          {isStarting
            ? "Cancel preview startup"
            : running
              ? "Open preview"
              : "Preview"}
        </span>
      </Menu.Item>
    );
  }

  if (!status) return null;

  // Same-origin interstitial that waits for the boot and then redirects itself
  // to the preview (PreviewWait.tsx). The agent-flagged deep link rides along
  // so the redirect lands where a click on the live link would.
  const waitUrl =
    `${BASE_PATH}/preview-wait/${encodeURIComponent(session.id)}` +
    (session.previewPath
      ? `?path=${encodeURIComponent(session.previewPath)}`
      : "");

  const start = async () => {
    // In-app tab flow: opening the tab both starts the preview (the pane
    // kicks the claim) and shows its progress — no popup, no interstitial.
    if (onOpenTab) {
      onOpenTab();
      return;
    }
    // Poll lag can leave a Start affordance up when the server is already
    // running — nothing to wait for, open the app directly. (Out-of-scope
    // origin, so installed PWAs hand this to a normal browser context.)
    if (status?.running && status.previewUrl) {
      window.open(url, `preview-${session.id}`, "noopener");
      return;
    }
    // Popup-blocker-safe "open when ready": window.open must fire synchronously
    // inside the click gesture, but the preview URL doesn't exist yet — so open
    // the interstitial NOW and let it redirect itself once the status endpoint
    // reports running. On the iOS PWA this opens the in-app browser view — a
    // new context, never replacing the app window. A blocked open returns null
    // and simply degrades to today's inline starting state.
    // Per-session window NAME (not _blank): reopening the same session's
    // preview reuses its own tab instead of spawning duplicates, and — the
    // real reason — a coalesced/reused browser view (iOS PWA in-app sheet)
    // can never end up showing ANOTHER session's interstitial (seen live
    // 2026-07-23: several sessions all presented preview-wait/<other-id>).
    const wait = window.open(waitUrl, `preview-${session.id}`);
    setStarting(true);
    await (async () => {
      const s = await startPreviewApi(session.id);
      setStatus(s);
      // Nothing actually started (repo not bootable, sandbox gate off) — don't
      // leave the interstitial spinning toward a boot that will never come.
      if (!s.running && !s.starting) wait?.close();
    })().catch(async () => {
      setStarting(false);
      wait?.close();
    });
  };

  const stop = async () => {
    setStopping(true);
    await (async () => {
      setStatus(await stopPreviewApi(session.id));
      setStarting(false);
    })()
      .catch(async () => {})
      .finally(async () => {
        setStopping(false);
      });
  };

  async function snap() {
    if (snapping) return;
    setSnapping(true);
    setShotError(null);
    await (async () => {
      setShot(await capturePreviewShot(session.id));
    })().catch(async (error) => {
      setShotError(errorMessage(error, "Failed to capture preview"));
      setShot(null);
    });
    setSnapping(false);
    // Hand over to the snapshot modal. The popup keeps its "Capturing…" label
    // until the result lands, then steps aside — it is portalled at the popover
    // layer, above this modal, so leaving it open would cover the screenshot.
    setOpen(false);
  }

  // Shared snapshot preview modal — rendered by both layouts.
  const snapshotModal = (shot || shotError) && (
    <div
      {...stylex.props(
        sx.fixed,
        sx.inset0,
        sx.z300,
        sx.bgBlack60,
        sx.flex,
        sx.itemsCenter,
        sx.justifyCenter,
        sx.p6,
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          setShot(null);
          setShotError(null);
        }
      }}
    >
      <div
        {...stylex.props(
          sx.bgRaised,
          sx.border,
          sx.borderLine,
          sx.roundedPanel,
          sx.smoothShadowLg,
          sx.p3,
          sx.maxW90vw,
          sx.maxH90vh,
          sx.flex,
          sx.flexCol,
          sx.gap25,
        )}
      >
        {shotError ? (
          <div {...stylex.props(sx.textRed, sx.px2, sx.py4, typography.label)}>
            {shotError}
          </div>
        ) : (
          <img
            src={shot!}
            alt="Preview screenshot"
            {...stylex.props(
              sx.maxWFull,
              sx.maxH75vh,
              sx.objectContain,
              sx.roundedMd,
              sx.border,
              sx.borderLine,
            )}
          />
        )}
        <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2, sx.justifyEnd)}>
          {shot && onAttachImage && (
            <Button
              variant="primary"
              size="sm"
              className={mergeStylexOverrideClassName("", sx.px14px, sx.py1)}
              onClick={() => {
                onAttachImage(shot);
                setShot(null);
              }}
            >
              Attach to session
            </Button>
          )}
          {shot && (
            <a
              {...stylex.props(
                sx.inlineFlex,
                sx.minH26px,
                sx.itemsCenter,
                sx.justifyCenter,
                sx.whitespaceNowrap,
                sx.roundedXs,
                sx.border,
                sx.borderLine,
                sx.bgControl,
                sx.px25,
                sx.textXs,
                sx.fontMedium,
                sx.textDim,
                sx.smoothShadowSm,
                sx.transition,
                sx.hoverBorderLineStrong,
                sx.hoverTextFg,
                sx.activeScale097,
              )}
              href={shot}
              download={`preview-${session.id}.png`}
            >
              Download
            </a>
          )}
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              setShot(null);
              setShotError(null);
            }}
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  );

  // Shared dev-services popover — the stop/start control and per-service list.
  // In header mode it also carries the snapshot action (there's no caret for it).
  // Anchored to the whole control cluster rather than to one trigger, because
  // every variant can open it from more than one place (caret, right-click, the
  // disabled button) — `align="end"` then reproduces the old `right-0` edge.
  const servicesPopup = (
    <Popover.Popup
      anchor={wrapRef}
      side="bottom"
      align="end"
      sideOffset={6}
      // Holds real controls, so let the keyboard in (the hover cards on this
      // primitive deliberately don't take focus).
      initialFocus
      className={mergeStylexOverrideClassName("", sx.minW240px, sx.p25)}
    >
      <div
        {...stylex.props(
          sx.mb2,
          sx.fontBold,
          sx.tracking001em,
          sx.textFaint,
          typography.meta,
        )}
      >
        Dev services
      </div>
      {status.services.length === 0 ? (
        <div {...stylex.props(sx.px0, sx.py1, sx.textXs, sx.textFaint)}>
          {isStarting ? "Starting up…" : "Not started yet"}
        </div>
      ) : (
        <ul
          {...stylex.props(
            sx.mb2,
            sx.flex,
            sx.listNone,
            sx.flexCol,
            sx.gap5px,
            sx.p0,
          )}
        >
          {status.services.map((s) => (
            <li
              key={s.key}
              {...stylex.props(
                sx.flex,
                sx.minH10,
                sx.itemsCenter,
                sx.gap7px,
                sx.textXs,
                sx.textDim,
              )}
            >
              <span
                className={cn(
                  utilityClassName("size-[7px] shrink-0 rounded-full"),
                  s.running
                    ? utilityClassName(
                        "bg-green shadow-[0_0_0_2px_color-mix(in_srgb,var(--green)_18%,transparent)]",
                      )
                    : utilityClassName("bg-[var(--text-faint)] shadow-none"),
                )}
              />
              {s.running && s.previewUrl ? (
                <a
                  href={s.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  {...stylex.props(
                    sx.fontSemibold,
                    sx.textFg,
                    sx.underline,
                    sx.decorationTransparent,
                    sx.underlineOffset2,
                    sx.transitionTextDecorationColor,
                    sx.hoverDecorationCurrent,
                    sx.focusVisibleDecorationCurrent,
                  )}
                >
                  {s.name}
                </a>
              ) : (
                <span {...stylex.props(sx.fontSemibold)}>{s.name}</span>
              )}
              <span {...stylex.props(sx.textFaint)}>:{s.port}</span>
              <span
                className={cn(
                  utilityClassName("ml-auto text-meta text-faint"),
                  s.running && utilityClassName("text-green"),
                )}
              >
                {s.running ? "running" : "stopped"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {running || anyRunning ? (
        <button
          className={popoverActionClass}
          onClick={stop}
          disabled={!anyRunning || stopping}
        >
          {stopping ? "Stopping…" : "Stop dev server"}
        </button>
      ) : isStarting ? (
        <button
          className={popoverActionClass}
          onClick={stop}
          disabled={stopping}
        >
          {stopping ? "Cancelling…" : "Cancel startup"}
        </button>
      ) : bootable ? (
        <button className={popoverActionClass} onClick={start}>
          Start dev server
        </button>
      ) : (
        <div {...stylex.props(sx.px0, sx.py1, sx.textXs, sx.textFaint)}>
          {notBootableHint}.
        </div>
      )}
      {variant !== "bar" && running && (
        <button
          className={cn(popoverActionClass, utilityClassName("mt-1.5"))}
          onClick={snap}
          disabled={snapping}
        >
          {snapping ? "Capturing…" : "Snapshot preview"}
        </button>
      )}
      {/* Compact modes have no room for dedicated snapshot/copy segments, so
          those actions live here. The bar layout keeps its split controls. */}
      {variant !== "bar" && running && (
        <button
          className={cn(popoverActionClass, utilityClassName("mt-1.5"))}
          onClick={() => copy(url, { toast: "Preview link copied" })}
        >
          Copy preview link
        </button>
      )}
      <div
        {...stylex.props(sx.mt15, sx.textCenter, sx.textFaint, typography.meta)}
      >
        {running || anyRunning
          ? "Stops this worktree's dev process group only."
          : bootable
            ? "Runs the repo's preview boot script in this worktree (first build ~1 min)."
            : "Add .agents/start.sh or configure previewCommand."}
      </div>
    </Popover.Popup>
  );

  // Right-click and disabled-state paths only OPEN the popup: the caret is a
  // real Popover.Trigger and owns toggling, so a second toggling opener would
  // race Base UI's outside-press dismissal (which fires on the press first,
  // then our handler would reopen what it just closed).
  const openServices = (e?: React.MouseEvent) => {
    e?.preventDefault();
    setOpen(true);
  };

  if (variant === "action") {
    const mainClass = utilityClassName(
      "flex min-w-0 flex-1 items-center gap-2 rounded-md rounded-r-none px-2.5 py-2 text-left text-supporting font-semibold text-fg no-underline outline-none transition-colors hover:bg-hover focus-visible:bg-hover disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50",
    );
    const mainContent = (
      <>
        <span
          {...stylex.props(
            sx.inlineFlex,
            sx.size5,
            sx.shrink0,
            sx.itemsCenter,
            sx.justifyCenter,
            sx.textFaint,
          )}
        >
          {isStarting ? (
            <span className={spinnerClass} />
          ) : (
            <IconPlay size={17} />
          )}
        </span>
        <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
          {isStarting ? (stopping ? "Cancelling…" : "Starting…") : "Preview"}
        </span>
      </>
    );

    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <div {...stylex.props(sx.relative, sx.flex, sx.minW0)} ref={wrapRef}>
          {running ? (
            <a
              className={mainClass}
              href={url}
              target="_blank"
              rel="noopener"
              title={`Open the webapp · ${url}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  copy(url, { toast: "Preview link copied" });
                } else if (onOpenTab) {
                  e.preventDefault();
                  onOpenTab();
                }
              }}
            >
              {mainContent}
            </a>
          ) : isStarting ? (
            <button className={mainClass} onClick={stop} disabled={stopping}>
              {mainContent}
            </button>
          ) : !bootable ? (
            <button
              className={mainClass}
              onClick={openServices}
              aria-disabled="true"
            >
              {mainContent}
            </button>
          ) : (
            <button className={mainClass} onClick={start}>
              {mainContent}
            </button>
          )}
          <Popover.Trigger
            render={
              <button
                {...stylex.props(
                  sx.flex,
                  sx.w8,
                  sx.shrink0,
                  sx.itemsCenter,
                  sx.justifyCenter,
                  sx.roundedControl,
                  sx.roundedLNone,
                  sx.textFaint,
                  sx.outlineNone,
                  sx.transitionColors,
                  sx.hoverBgHover,
                  sx.hoverTextFg,
                  sx.focusVisibleBgHover,
                  sx.focusVisibleTextFg,
                )}
                title="Dev services"
                aria-label="Dev services"
              >
                <IconChevronDown size={16} />
              </button>
            }
          />
          {snapshotModal}
        </div>
        {servicesPopup}
      </Popover.Root>
    );
  }

  // Header mode: a single ▶ icon, color-coded by state (dim=off, amber=starting,
  // green=live), sized to sit next to the panel-toggle icon. Left-click does the
  // primary action; right-click opens the services popover (stop / snapshot).
  // While the server is up (or starting) a small caret rides beside the icon —
  // the popover's stop action was right-click-only and nobody found it
  // (seen live, 2026-07-09).
  if (variant === "header") {
    const menuCaret = (running || anyRunning || isStarting) && (
      <Tooltip label="Dev services: stop the server, snapshot" side="bottom">
        <Popover.Trigger
          render={
            <button
              className={cn(
                headerIconBase,
                utilityClassName("-ml-[3px] px-px py-[3px]"),
                open
                  ? utilityClassName(
                      "text-green hover:bg-hover hover:text-green",
                    )
                  : utilityClassName(
                      "text-faint hover:bg-hover hover:text-dim",
                    ),
              )}
              aria-label="Dev services"
            >
              <IconChevronDown size={16} />
            </button>
          }
        />
      </Tooltip>
    );
    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <div
          {...stylex.props(sx.relative, sx.inlineFlex, sx.itemsCenter)}
          ref={wrapRef}
        >
          {running ? (
            <Tooltip
              label={
                copied
                  ? "Link copied"
                  : "Open the running app. ⌘-click copies the link, right-click opens dev services."
              }
              side="bottom"
            >
              <a
                className={cn(
                  headerIconBase,
                  utilityClassName(
                    "text-green hover:bg-hover hover:text-green",
                  ),
                )}
                href={url}
                target="_blank"
                rel="noopener"
                onContextMenu={openServices}
                onClick={(e) => {
                  // ⌘/Ctrl-click copies instead of opening (the same modifier
                  // semantics as StagingLink's globe).
                  if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    copy(url, { toast: "Preview link copied" });
                    return;
                  }
                  // In-app tab everywhere it exists — the tab's toolbar owns
                  // the break-out; a bare anchor here opened the browser and
                  // made the button feel random (tab sometimes, window others).
                  if (onOpenTab) {
                    e.preventDefault();
                    onOpenTab();
                  }
                }}
              >
                <CopyCheck
                  copied={copied}
                  size={22}
                  idle={<IconPlayOutline size={22} />}
                />
              </a>
            </Tooltip>
          ) : isStarting ? (
            <Tooltip
              label={
                stopping
                  ? "Cancelling…"
                  : "Starting the dev server. Click to cancel."
              }
              side="bottom"
            >
              <button
                className={cn(
                  headerIconBase,
                  utilityClassName(
                    "text-yellow hover:bg-hover hover:text-yellow",
                  ),
                )}
                onClick={stop}
                onContextMenu={openServices}
                disabled={stopping}
              >
                <span
                  {...stylex.props(
                    sx.relative,
                    sx.inlineFlex,
                    sx.itemsCenter,
                    sx.justifyCenter,
                  )}
                >
                  <span
                    {...stylex.props(
                      sx.pointerEventsNone,
                      sx.absolute,
                      sx.left12,
                      sx.top12,
                      sx.size25px,
                      sx.TranslateX12,
                      sx.TranslateY12,
                      sx.roundedFull,
                      sx.border,
                      sx.borderTransparent,
                      sx.borderTCurrent,
                      sx.opacity90,
                      sx.animatePreviewSpin07sLinearInfinite,
                    )}
                    aria-hidden="true"
                  />
                  <IconPlayOutline size={22} />
                </span>
              </button>
            </Tooltip>
          ) : !bootable ? (
            <Tooltip
              label={`${notBootableHint} Right-click for details.`}
              side="bottom"
              multiline
            >
              <button
                className={cn(
                  headerIconBase,
                  utilityClassName(
                    "cursor-not-allowed text-faint opacity-45 hover:bg-hover hover:text-dim",
                  ),
                )}
                onClick={openServices}
                onContextMenu={openServices}
                aria-disabled="true"
              >
                <IconPlayOutline size={22} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip
              label="Run the dev server (right-click for dev services)"
              side="bottom"
            >
              <button
                className={cn(
                  headerIconBase,
                  utilityClassName("text-faint hover:bg-hover hover:text-dim"),
                )}
                onClick={start}
                onContextMenu={openServices}
              >
                <IconPlayOutline size={22} />
              </button>
            </Tooltip>
          )}
          {menuCaret}
          {snapshotModal}
        </div>
        {servicesPopup}
      </Popover.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div
        {...stylex.props(sx.relative, sx.inlineFlex, sx.itemsStretch)}
        ref={wrapRef}
      >
        {running ? (
          <a
            className={cn(
              splitSegmentBase,
              utilityClassName(
                "gap-1.5 whitespace-nowrap rounded-l-[calc(5px*var(--rf))] px-[11px] py-[5px] text-label font-semibold text-green no-underline",
              ),
              utilityClassName(
                "hover:relative hover:z-[1] hover:border-[color-mix(in_srgb,var(--green)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--green)_12%,transparent)] hover:text-green",
              ),
            )}
            href={url}
            target="_blank"
            rel="noopener"
            title={`Open the webapp · ${url}`}
            onClick={(e) => {
              if (onOpenTab && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                onOpenTab();
              }
            }}
          >
            <IconPlay
              size={15}
              className={mergeStylexOverrideClassName("", sx.opacity90)}
            />
            Preview
            <IconArrowUpRight
              size={15}
              className={mergeStylexOverrideClassName(
                "",
                sx.MlPx,
                sx.opacity80,
              )}
            />
          </a>
        ) : isStarting ? (
          <button
            className={cn(
              splitSegmentBase,
              utilityClassName(
                "group gap-1.5 whitespace-nowrap rounded-l-[calc(5px*var(--rf))] px-[11px] py-[5px] text-label font-semibold text-dim",
              ),
              utilityClassName(
                "cursor-pointer hover:relative hover:z-[1] hover:border-[color-mix(in_srgb,var(--red)_40%,transparent)] hover:bg-[color-mix(in_srgb,var(--red)_10%,transparent)] hover:text-red",
              ),
            )}
            onClick={stop}
            disabled={stopping}
            title="Starting the dev server (first build can take a minute). Click to cancel."
          >
            <span className={spinnerClass} />
            <span {...mergeStylexProps("group-hover:hidden", sx.inline)}>
              {stopping ? "Cancelling…" : "Starting…"}
            </span>
            <span {...mergeStylexProps("group-hover:inline", sx.hidden)}>
              Cancel
            </span>
          </button>
        ) : !bootable ? (
          <button
            className={cn(
              splitSegmentBase,
              utilityClassName(
                "gap-1.5 whitespace-nowrap rounded-l-[calc(5px*var(--rf))] px-[11px] py-[5px] text-label font-semibold text-dim opacity-45",
              ),
              utilityClassName("cursor-not-allowed"),
            )}
            onClick={openServices}
            aria-disabled="true"
            title={`${notBootableHint}.`}
          >
            <IconPlay size={15} className="text-accent" />
            Preview
          </button>
        ) : (
          <button
            className={cn(
              splitSegmentBase,
              utilityClassName(
                "gap-1.5 whitespace-nowrap rounded-l-[calc(5px*var(--rf))] px-[11px] py-[5px] text-label font-semibold text-dim",
              ),
              utilityClassName(
                "cursor-pointer hover:relative hover:z-[1] hover:border-accent hover:bg-hover hover:text-fg",
              ),
            )}
            onClick={start}
            title="Start the dev server and preview this session"
          >
            <IconPlay size={15} className="text-accent" />
            Preview
          </button>
        )}
        {/* Copy segment — the split's secondary action. Enabled once a previewUrl
            exists (server up + Caddy fronting it); before that there's no stable
            URL to hand out, so it sits disabled with a hint. */}
        <button
          className={cn(
            splitSegmentBase,
            utilityClassName("-ml-px px-2 py-1"),
            running
              ? utilityClassName(
                  "text-[color:color-mix(in_srgb,var(--green)_72%,var(--text-dim))] hover:relative hover:z-[1] hover:border-[color-mix(in_srgb,var(--green)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--green)_12%,transparent)] hover:text-green",
                )
              : utilityClassName(
                  "hover:relative hover:z-[1] hover:border-accent hover:bg-hover hover:text-accent",
                ),
            "aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:hover:border-line-strong aria-disabled:hover:bg-transparent aria-disabled:hover:text-dim",
          )}
          onClick={() => {
            if (running) copy(url, { toast: "Preview link copied" });
          }}
          aria-disabled={!running || undefined}
          title={
            running
              ? `Copy the preview link · ${url}`
              : "Start the preview first"
          }
        >
          <CopyCheck copied={copied} size={18} idle={<IconLink size={18} />} />
        </button>
        {running && (
          <button
            className={cn(
              splitSegmentBase,
              utilityClassName(
                "-ml-px px-2 py-1 text-[color:color-mix(in_srgb,var(--green)_72%,var(--text-dim))]",
              ),
              utilityClassName(
                "hover:relative hover:z-[1] hover:border-[color-mix(in_srgb,var(--green)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--green)_12%,transparent)] hover:text-green",
              ),
            )}
            onClick={snap}
            disabled={snapping}
            title="Snapshot the preview (headless Chrome screenshot)"
          >
            {snapping ? (
              <span className={spinnerClass} />
            ) : (
              <IconCamera size={18} />
            )}
          </button>
        )}
        <Popover.Trigger
          render={
            <button
              className={cn(
                splitSegmentBase,
                utilityClassName(
                  "-ml-px rounded-r-[calc(5px*var(--rf))] px-2 py-1",
                ),
                running
                  ? utilityClassName(
                      "text-[color:color-mix(in_srgb,var(--green)_72%,var(--text-dim))]",
                    )
                  : utilityClassName("text-dim"),
                open || running
                  ? utilityClassName(
                      "relative z-[1] border-[color-mix(in_srgb,var(--green)_50%,transparent)] bg-[color-mix(in_srgb,var(--green)_12%,transparent)] text-green",
                    )
                  : "",
                !running &&
                  utilityClassName(
                    "hover:relative hover:z-[1] hover:border-accent hover:bg-hover hover:text-accent",
                  ),
                running &&
                  !open &&
                  utilityClassName(
                    "hover:relative hover:z-[1] hover:border-[color-mix(in_srgb,var(--green)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--green)_12%,transparent)] hover:text-green",
                  ),
              )}
              title="Dev server processes"
            >
              <IconChevronDown size={16} />
            </button>
          }
        />

        {snapshotModal}
      </div>
      {servicesPopup}
    </Popover.Root>
  );
}
