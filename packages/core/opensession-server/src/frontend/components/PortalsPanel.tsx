import { mergeStylexProps } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { useState } from "react";
import type {
  PreviewPortalRecipe,
  PreviewService,
  PreviewStatus,
} from "../lib/api";
import { portalTargetFor, type PortalTarget } from "../lib/portals";
import {
  INFO_LABEL_CLASS,
  INFO_SECTION_CLASS,
} from "../lib/session-viewer-classes";
import { cn } from "../ui/cn";
import { IconArrowUpRight } from "./icons";
import { PanelPageHeader } from "./PanelPageHeader";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py1: {
    paddingBlock: "4px",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  size35: {
    width: "calc(4px * 3.5)",
    height: "calc(4px * 3.5)",
  },
  animateSpin: {
    animation: "var(--animate-spin)",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  border2: {
    borderStyle: "solid",
    borderWidth: "2px",
  },
  borderLineStrong: {
    borderColor: "var(--border-strong)",
  },
  borderTAccent: {
    borderTopColor: "var(--accent)",
  },
  shrink0: {
    flexShrink: "0",
  },
  px1: {
    paddingInline: "4px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  grid: {
    display: "grid",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  pt2: {
    paddingTop: "calc(4px * 2)",
  },
  pb22px: {
    paddingBottom: "22px",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgRedSoft: {
    backgroundColor: "var(--red-soft)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  textRed: {
    color: "var(--red)",
  },
  minH11: {
    minHeight: "calc(4px * 11)",
  },
  wFull: {
    width: "100%",
  },
  minW0: {
    minWidth: "0",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  textLeft: {
    textAlign: "left",
  },
  transitionBackgroundColorScale: {
    transitionProperty: "background-color,scale",
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
  activeScale096: {
    ":active": {
      scale: "0.96",
    },
  },
  disabledCursorDefault: {
    ":disabled": {
      cursor: "default",
    },
  },
  disabledOpacity45: {
    ":disabled": {
      opacity: "45%",
    },
  },
  flex1: {
    flex: "1",
  },
  block: {
    display: "block",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  lineClamp2: {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: "2",
  },
  py5px: {
    paddingBlock: "5px",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  size11: {
    width: "calc(4px * 11)",
    height: "calc(4px * 11)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  opacity0: {
    opacity: "0%",
  },
  transitionColorOpacity: {
    transitionProperty: "color,opacity",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  phoneOpacity100: {
    "@media (max-width: 720px)": {
      opacity: "100%",
    },
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  focusVisibleOpacity100: {
    ":focus-visible": {
      opacity: "100%",
    },
  },
  transitionOpacity: {
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  focusWithinOpacity100: {
    ":focus-within": {
      opacity: "100%",
    },
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  transitionColors: {
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  hoverTextRed: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--red)",
      },
    },
  },
  py7px: {
    paddingBlock: "7px",
  },
});

/** A plain divided list. Portal rows do not need a shared grey plate around
 * them: the panel itself is already their surface. */
const PORTAL_LIST_CLASS = utilityClassName("grid divide-y divide-line/70");

/** What a service row says on its right: where it is, in one word. */
function statusLabel(
  service: PreviewService,
  target: PortalTarget | null,
  active: boolean,
): string {
  if (target) return active ? "Open" : "Running";
  if (service.running) {
    if (service.state === "starting") return "Starting";
    if (service.state === "sleeping") return "Sleeping";
    if (service.state === "waking") return "Waking";
    return "Unavailable";
  }
  return service.state === "failed" ? "Failed" : `Port ${service.port}`;
}

function DiscoveringRow() {
  return (
    <div
      {...stylex.props(
        sx.flex,
        sx.itemsCenter,
        sx.gap2,
        sx.px2,
        sx.py1,
        sx.textDim,
        typography.supporting,
      )}
    >
      <span
        {...stylex.props(
          sx.size35,
          sx.animateSpin,
          sx.roundedFull,
          sx.border2,
          sx.borderLineStrong,
          sx.borderTAccent,
        )}
      />
      Discovering services…
    </div>
  );
}

/**
 * The portals page: the panel one level deeper, opened from the Portals item
 * in the panel's tab strip. The recipes this repository can start, every
 * discovered service, and the restart and stop controls for the ones we manage.
 */
export function PortalsPage({
  sessionId,
  status,
  activePortal,
  onBack,
  hideHeader = false,
  onOpenPortal,
  onStartPortal,
  onPortalAction,
}: {
  sessionId: string;
  status: PreviewStatus | null;
  activePortal?: PortalTarget | null;
  onBack: () => void;
  hideHeader?: boolean;
  onOpenPortal?: (target: PortalTarget) => void;
  onStartPortal?: (recipe: PreviewPortalRecipe) => Promise<void>;
  onPortalAction?: (name: string, action: "stop" | "restart") => Promise<void>;
}) {
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const services = status?.services ?? [];
  const recipes = status?.portalRecipes ?? [];
  const liveCount = services.filter((service) =>
    portalTargetFor(sessionId, service),
  ).length;

  return (
    <>
      {!hideHeader && (
        <PanelPageHeader
          title="Portals"
          onBack={onBack}
          trailing={
            liveCount > 0 && (
              <span
                {...mergeStylexProps(
                  "tabular-nums",
                  sx.shrink0,
                  sx.px1,
                  sx.fontSemibold,
                  sx.textFaint,
                  typography.label,
                )}
              >
                {liveCount} live
              </span>
            )
          }
        />
      )}
      <div {...stylex.props(sx.grid, sx.gap4, sx.px2, sx.pt2, sx.pb22px)}>
        {error ? (
          <div
            role="alert"
            {...stylex.props(
              sx.roundedControl,
              sx.bgRedSoft,
              sx.px3,
              sx.py2,
              sx.textRed,
              typography.label,
            )}
          >
            {error}
          </div>
        ) : null}
        {!status ? (
          <DiscoveringRow />
        ) : (
          <>
            {recipes.length ? (
              <div className={INFO_SECTION_CLASS}>
                <div className={INFO_LABEL_CLASS}>Start a portal</div>
                <div className={PORTAL_LIST_CLASS}>
                  {recipes.map((recipe) => {
                    const service = recipe.serviceKey
                      ? services.find(
                          (candidate) => candidate.key === recipe.serviceKey,
                        )
                      : null;
                    const target = service
                      ? portalTargetFor(sessionId, service)
                      : null;
                    return (
                      <button
                        key={recipe.id}
                        type="button"
                        disabled={
                          !target && (!onStartPortal || requestedId != null)
                        }
                        onClick={() => {
                          if (target) {
                            onOpenPortal?.(target);
                            return;
                          }
                          if (!onStartPortal) return;
                          setError(null);
                          setRequestedId(recipe.id);
                          void onStartPortal(recipe)
                            .catch((cause) =>
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : String(cause),
                              ),
                            )
                            .finally(() => setRequestedId(null));
                        }}
                        {...mergeStylexProps(
                          "focus-ring",
                          sx.flex,
                          sx.minH11,
                          sx.wFull,
                          sx.minW0,
                          sx.itemsCenter,
                          sx.gap3,
                          sx.roundedControl,
                          sx.px2,
                          sx.py15,
                          sx.textLeft,
                          sx.transitionBackgroundColorScale,
                          sx.hoverBgHover,
                          sx.activeScale096,
                          sx.disabledCursorDefault,
                          sx.disabledOpacity45,
                        )}
                      >
                        <span {...stylex.props(sx.minW0, sx.flex1)}>
                          <span
                            {...stylex.props(
                              sx.block,
                              sx.truncate,
                              sx.fontMedium,
                              sx.textFg,
                              typography.label,
                            )}
                          >
                            {recipe.name}
                          </span>
                          {recipe.description ? (
                            <span
                              {...stylex.props(
                                sx.mt05,
                                sx.block,
                                sx.lineClamp2,
                                sx.textDim,
                                typography.supporting,
                              )}
                            >
                              {recipe.description}
                            </span>
                          ) : null}
                        </span>
                        <span
                          {...stylex.props(
                            sx.shrink0,
                            sx.fontSemibold,
                            sx.textFaint,
                            typography.label,
                          )}
                        >
                          {target
                            ? "Open"
                            : requestedId === recipe.id
                              ? "Starting…"
                              : "Start"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className={INFO_SECTION_CLASS}>
              {recipes.length > 0 && (
                <div className={INFO_LABEL_CLASS}>Services</div>
              )}
              <div className={PORTAL_LIST_CLASS}>
                {services.length ? (
                  services.map((service) => {
                    const target = portalTargetFor(sessionId, service);
                    const active =
                      !!target &&
                      activePortal?.sessionId === sessionId &&
                      activePortal.key === service.key;
                    return (
                      <div
                        key={service.key}
                        className={cn(
                          utilityClassName(
                            "group flex min-h-11 min-w-0 items-center gap-1 rounded-control pr-1 transition-colors",
                          ),
                          active
                            ? utilityClassName("bg-hover")
                            : utilityClassName("hover:bg-hover"),
                        )}
                      >
                        <button
                          type="button"
                          disabled={!target}
                          onClick={() => target && onOpenPortal?.(target)}
                          {...stylex.props(
                            sx.flex,
                            sx.minW0,
                            sx.flex1,
                            sx.itemsCenter,
                            sx.gap2,
                            sx.roundedControl,
                            sx.px2,
                            sx.py5px,
                            sx.textLeft,
                            sx.disabledCursorDefault,
                          )}
                        >
                          <span
                            className={cn(
                              utilityClassName(
                                "size-[7px] shrink-0 rounded-full",
                              ),
                              service.running
                                ? utilityClassName("bg-green")
                                : utilityClassName("bg-line-strong"),
                            )}
                            aria-hidden="true"
                          />
                          <span
                            {...stylex.props(
                              sx.minW0,
                              sx.flex1,
                              sx.truncate,
                              sx.textFg,
                              typography.label,
                            )}
                          >
                            {service.name}
                          </span>
                          <span
                            {...stylex.props(
                              sx.shrink0,
                              sx.truncate,
                              sx.textFaint,
                              typography.label,
                            )}
                          >
                            {statusLabel(service, target, active)}
                          </span>
                        </button>
                        {target ? (
                          <a
                            href={target.url}
                            target="_blank"
                            rel="noopener"
                            {...mergeStylexProps(
                              "focus-ring group-hover:opacity-100",
                              sx.inlineFlex,
                              sx.size11,
                              sx.shrink0,
                              sx.itemsCenter,
                              sx.justifyCenter,
                              sx.roundedControl,
                              sx.textFaint,
                              sx.opacity0,
                              sx.transitionColorOpacity,
                              sx.phoneOpacity100,
                              sx.hoverTextFg,
                              sx.focusVisibleOpacity100,
                            )}
                            aria-label={`Open ${service.name} in a separate browser window`}
                            title="Open in browser"
                          >
                            <IconArrowUpRight size={14} />
                          </a>
                        ) : null}
                        {service.managed && onPortalAction ? (
                          <div
                            {...mergeStylexProps(
                              "group-hover:opacity-100",
                              sx.flex,
                              sx.shrink0,
                              sx.itemsCenter,
                              sx.opacity0,
                              sx.transitionOpacity,
                              sx.phoneOpacity100,
                              sx.focusWithinOpacity100,
                            )}
                          >
                            <button
                              type="button"
                              disabled={working === service.name}
                              onClick={() => {
                                setError(null);
                                setWorking(service.name);
                                void onPortalAction(service.name, "restart")
                                  .catch((cause) =>
                                    setError(
                                      cause instanceof Error
                                        ? cause.message
                                        : String(cause),
                                    ),
                                  )
                                  .finally(() => setWorking(null));
                              }}
                              {...mergeStylexProps(
                                "focus-ring",
                                sx.roundedControl,
                                sx.px15,
                                sx.py1,
                                sx.fontSemibold,
                                sx.textFaint,
                                sx.transitionColors,
                                sx.phoneMinH11,
                                sx.hoverTextFg,
                                sx.disabledOpacity45,
                                typography.label,
                              )}
                            >
                              Restart
                            </button>
                            <button
                              type="button"
                              disabled={
                                working === service.name || !service.running
                              }
                              onClick={() => {
                                setError(null);
                                setWorking(service.name);
                                void onPortalAction(service.name, "stop")
                                  .catch((cause) =>
                                    setError(
                                      cause instanceof Error
                                        ? cause.message
                                        : String(cause),
                                    ),
                                  )
                                  .finally(() => setWorking(null));
                              }}
                              {...mergeStylexProps(
                                "focus-ring",
                                sx.roundedControl,
                                sx.px15,
                                sx.py1,
                                sx.fontSemibold,
                                sx.textRed,
                                sx.transitionColors,
                                sx.phoneMinH11,
                                sx.hoverTextRed,
                                sx.disabledOpacity45,
                                typography.label,
                              )}
                            >
                              Stop
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <div
                    {...stylex.props(
                      sx.px2,
                      sx.py7px,
                      sx.textDim,
                      typography.label,
                    )}
                  >
                    {status.starting
                      ? "Starting services…"
                      : "No Portals are running. Start one above, or ask the agent to expose a service."}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
