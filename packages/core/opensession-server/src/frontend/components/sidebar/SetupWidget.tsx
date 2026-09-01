import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import { useState } from "react";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import type { SettingsSectionKey } from "../../lib/settings-sections";
import {
  dismissSetupWidget,
  setupWidgetDismissed,
  setupWidgetItems,
  visibleSetupWidgetItems,
  type SetupWidgetItem,
} from "../../lib/setup-widget";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import {
  IconBranches,
  IconCheck,
  IconCheckCircleFilled,
  IconChevronDown,
  IconConnections,
  IconGlobe,
  IconMessage,
  IconPeople,
  IconPlug,
  IconServer,
  IconShapes,
  IconX,
} from "../icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  size7: {
    width: "calc(4px * 7)",
    height: "calc(4px * 7)",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  textDim: {
    color: "var(--text-dim)",
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
  mr1: {
    marginRight: "4px",
  },
  size5: {
    width: "calc(4px * 5)",
    height: "calc(4px * 5)",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  textTransparent: {
    color: "transparent",
  },
  mx2: {
    marginInline: "calc(4px * 2)",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  flexNone: {
    flex: "none",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  roundedXl: {
    borderRadius: "calc(18px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  borderDividerSoft: {
    borderColor: "var(--divider-soft)",
  },
  bgPopupGlass: {
    backgroundColor: "var(--popup-glass)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  pr15: {
    paddingRight: "calc(4px * 1.5)",
  },
  pl3: {
    paddingLeft: "calc(4px * 3)",
  },
  BackdropFilterVarPopupBlur: {
    backdropFilter: "var(--popup-blur)",
  },
  smoothShadowSm: {
    boxShadow:
      "0 1px 3px -1px color-mix(in srgb, var(--smooth-shadow-color) 6%, transparent), 0 4px 10px -4px color-mix(in srgb, var(--smooth-shadow-color) 9%, transparent)",
  },
  flexCol: {
    flexDirection: "column",
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  leading13: {
    lineHeight: "1.3",
  },
  textFg: {
    color: "var(--text)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  gap1: {
    gap: "4px",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  pl2: {
    paddingLeft: "calc(4px * 2)",
  },
  m0: {
    margin: "0",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  h1: {
    height: "4px",
  },
  w8: {
    width: "calc(4px * 8)",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  rounded999px: {
    borderRadius: "999px",
    cornerShape: "var(--cs)",
  },
  bgActive: {
    backgroundColor: "var(--bg-active)",
  },
  hFull: {
    height: "100%",
  },
  bgAccent: {
    backgroundColor: "var(--accent)",
  },
  size10: {
    width: "calc(4px * 10)",
    height: "calc(4px * 10)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  transitionColorBackgroundColorScale: {
    transitionProperty: "color,background-color,scale",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  durationVarDurMicro: {
    transitionDuration: "var(--dur-micro)",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
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
  activeScale096: {
    ":active": {
      scale: "0.96",
    },
  },
  phoneSize11: {
    "@media (max-width: 720px)": {
      width: "calc(4px * 11)",
      height: "calc(4px * 11)",
    },
  },
  wFull: {
    width: "100%",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  textLeft: {
    textAlign: "left",
  },
  transitionBackgroundColorColorScale: {
    transitionProperty: "background-color,color,scale",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  ml1: {
    marginLeft: "4px",
  },
});

function SetupStepIcon({ id }: { id: SetupWidgetItem["id"] }) {
  switch (id) {
    case "server":
      return <IconServer size={20} />;
    case "github":
      return <IconConnections size={20} />;
    case "models":
      return <IconShapes size={20} />;
    case "repository":
      return <IconBranches size={20} />;
    case "domain":
      return <IconGlobe size={20} />;
    case "tools":
      return <IconPlug size={20} />;
    case "members":
      return <IconPeople size={20} />;
    case "session":
      return <IconMessage size={20} />;
  }
}

function SetupStep({
  item,
  complete,
  onOpenSettings,
  onNewSession,
}: {
  item: SetupWidgetItem;
  complete: boolean;
  onOpenSettings: (section?: SettingsSectionKey) => void;
  onNewSession: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        utilityClassName(
          "focus-ring flex min-h-9 w-full items-center gap-1.5 rounded-control px-1.5 text-left text-label font-medium transition-[background-color,color,scale] duration-[var(--dur-micro)] hover:bg-hover active:scale-[0.96] phone:min-h-11",
        ),
        complete ? utilityClassName("text-dim") : utilityClassName("text-fg"),
      )}
      onClick={() =>
        item.target === "new-session"
          ? onNewSession()
          : onOpenSettings(item.target)
      }
    >
      <span
        {...stylex.props(
          sx.flex,
          sx.size7,
          sx.shrink0,
          sx.itemsCenter,
          sx.justifyCenter,
          sx.textDim,
        )}
        aria-hidden="true"
      >
        <SetupStepIcon id={item.id} />
      </span>
      <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
        {item.label}
      </span>
      {complete ? (
        <IconCheckCircleFilled
          size={20}
          className={mergeStylexOverrideClassName(
            "text-accent",
            sx.mr1,
            sx.shrink0,
          )}
          aria-hidden="true"
        />
      ) : (
        <span
          {...stylex.props(
            sx.mr1,
            sx.flex,
            sx.size5,
            sx.shrink0,
            sx.itemsCenter,
            sx.justifyCenter,
            sx.roundedFull,
            sx.border,
            sx.borderLine,
            sx.textTransparent,
          )}
          aria-hidden="true"
        >
          <IconCheck size={16} />
        </span>
      )}
    </button>
  );
}

export function SetupWidget({
  placement,
  hasCreatedSession,
  onOpenSettings,
  onNewSession,
}: {
  placement: "desktop" | "phone";
  hasCreatedSession: boolean;
  onOpenSettings: (section?: SettingsSectionKey) => void;
  onNewSession: () => void;
}) {
  const [dismissed, setDismissed] = useState(setupWidgetDismissed);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const setup = useSetupStatus();
  if (dismissed || !setup.status) return null;

  const items = setupWidgetItems(setup.status, hasCreatedSession);
  const completed = items.filter((item) => item.complete);
  if (completed.length === items.length) return null;
  const visibleItems = visibleSetupWidgetItems(items);

  const progress = (completed.length / items.length) * 100;
  const completedLabel = `${completed.length} ${completed.length === 1 ? "step" : "steps"} checked`;

  if (placement === "desktop" && !desktopOpen) {
    return (
      <aside
        aria-label="Get started"
        {...stylex.props(
          sx.mx2,
          sx.mb2,
          sx.flex,
          sx.flexNone,
          sx.itemsCenter,
          sx.gap2,
          sx.roundedXl,
          sx.border,
          sx.borderDividerSoft,
          sx.bgPopupGlass,
          sx.py15,
          sx.pr15,
          sx.pl3,
          sx.BackdropFilterVarPopupBlur,
          sx.smoothShadowSm,
        )}
        onPointerEnter={() => void setup.refetch()}
        onFocusCapture={() => void setup.refetch()}
      >
        <div
          {...stylex.props(
            sx.flex,
            sx.minW0,
            sx.flex1,
            sx.flexCol,
            sx.itemsStart,
            sx.gap05,
          )}
        >
          <span
            {...stylex.props(
              sx.maxWFull,
              sx.truncate,
              sx.fontMedium,
              sx.leading13,
              sx.textFg,
              typography.supporting,
            )}
          >
            Get started
          </span>
          <span
            {...mergeStylexProps(
              "tabular-nums",
              sx.leading13,
              sx.textFaint,
              typography.meta,
            )}
          >
            {completed.length} of {items.length}
          </span>
        </div>
        <div {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.gap1)}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setDesktopOpen(true)}
          >
            Open
          </Button>
          <Tooltip label="Dismiss" side="top">
            <Button
              variant="ghost"
              size="sm"
              icon={<IconX size={16} />}
              aria-label="Dismiss setup checklist"
              onClick={() => {
                dismissSetupWidget();
                setDismissed(true);
              }}
            />
          </Tooltip>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-labelledby="sidebar-setup-title"
      className={cn(
        utilityClassName(
          "z-30 flex-none rounded-2xl border border-divider-soft bg-popup-glass p-2 [backdrop-filter:var(--popup-blur)] smooth-shadow-sm",
        ),
        placement === "desktop"
          ? utilityClassName("mx-2 mb-2")
          : utilityClassName("mx-3 mt-3 mb-20"),
      )}
      style={placement === "phone" ? { order: 100 } : undefined}
      onPointerEnter={() => void setup.refetch()}
      onFocusCapture={() => void setup.refetch()}
    >
      <div
        {...stylex.props(sx.flex, sx.minH10, sx.itemsCenter, sx.gap2, sx.pl2)}
      >
        <h2
          id="sidebar-setup-title"
          {...stylex.props(
            sx.m0,
            sx.shrink0,
            sx.fontSemibold,
            sx.textFg,
            typography.label,
          )}
        >
          Get started
        </h2>
        <div
          {...stylex.props(
            sx.mlAuto,
            sx.flex,
            sx.shrink0,
            sx.itemsCenter,
            sx.gap2,
          )}
        >
          <div
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={completed.length}
            {...stylex.props(
              sx.h1,
              sx.w8,
              sx.overflowHidden,
              sx.rounded999px,
              sx.bgActive,
            )}
          >
            <div
              {...stylex.props(sx.hFull, sx.rounded999px, sx.bgAccent)}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span
            {...mergeStylexProps("tabular-nums", sx.textFaint, typography.meta)}
          >
            {completed.length} of {items.length}
          </span>
        </div>
        <Tooltip label="Dismiss">
          <button
            type="button"
            aria-label="Dismiss setup checklist"
            {...mergeStylexProps(
              "focus-ring",
              sx.flex,
              sx.size10,
              sx.shrink0,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.roundedControl,
              sx.textFaint,
              sx.transitionColorBackgroundColorScale,
              sx.durationVarDurMicro,
              sx.hoverBgHover,
              sx.hoverTextFg,
              sx.activeScale096,
              sx.phoneSize11,
            )}
            onClick={() => {
              dismissSetupWidget();
              setDismissed(true);
            }}
          >
            <IconX size={20} />
          </button>
        </Tooltip>
      </div>

      {completed.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={completedOpen}
            {...mergeStylexProps(
              "focus-ring",
              sx.flex,
              sx.minH10,
              sx.wFull,
              sx.itemsCenter,
              sx.gap2,
              sx.roundedControl,
              sx.px2,
              sx.textLeft,
              sx.fontMedium,
              sx.textDim,
              sx.transitionBackgroundColorColorScale,
              sx.durationVarDurMicro,
              sx.hoverBgHover,
              sx.hoverTextFg,
              sx.activeScale096,
              sx.phoneMinH11,
              typography.label,
            )}
            onClick={() => setCompletedOpen((open) => !open)}
          >
            <IconCheckCircleFilled
              size={20}
              className={mergeStylexOverrideClassName(
                "text-accent",
                sx.ml1,
                sx.shrink0,
              )}
            />
            <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
              {completedLabel}
            </span>
            <IconChevronDown
              size={20}
              className={cn(
                utilityClassName(
                  "mr-0.5 shrink-0 transition-transform duration-[var(--dur-micro)]",
                ),
                completedOpen && utilityClassName("rotate-180"),
              )}
            />
          </button>
          {completedOpen && (
            <div {...stylex.props(sx.flex, sx.flexCol)}>
              {completed.map((item) => (
                <SetupStep
                  key={item.id}
                  item={item}
                  complete
                  onOpenSettings={onOpenSettings}
                  onNewSession={onNewSession}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div {...stylex.props(sx.flex, sx.flexCol)}>
        {visibleItems.map((item) => (
          <SetupStep
            key={item.id}
            item={item}
            complete={false}
            onOpenSettings={onOpenSettings}
            onNewSession={onNewSession}
          />
        ))}
      </div>
    </aside>
  );
}
