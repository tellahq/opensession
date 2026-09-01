import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import type React from "react";
import {
  type CheckVisual,
  checkStatusMeta,
  checkToneClass,
} from "../lib/pr-checks";
import type { PrCheck } from "../lib/types";
import { Popover } from "../ui/popover";
import { CheckStatusIcon } from "./CheckStatusIcon";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  maxHMin560px70vhVarAvailableHeight: {
    maxHeight: "min(560px, 70vh, var(--available-height))",
  },
  wMin440pxCalc100vw24px: {
    width: "min(440px, calc(100vw - 24px))",
  },
  flexCol: {
    flexDirection: "column",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  p0: {
    padding: "0",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py9px: {
    paddingBlock: "9px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  textGreen: {
    color: "var(--green)",
  },
  textRed: {
    color: "var(--red)",
  },
  textYellow: {
    color: "var(--yellow)",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  p1: {
    padding: "4px",
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
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  shrink0: {
    flexShrink: "0",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap9px: {
    gap: "9px",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  noUnderline: {
    textDecorationLine: "none",
  },
  hoverBgSurface: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--bg)",
      },
    },
  },
});

/** A shared checks preview: hover for detail, click its trigger to open Review's Checks tab. */
export function PrChecksPopover({
  checks,
  trigger,
  nested = false,
}: {
  checks: PrCheck[];
  trigger: React.ReactElement;
  /** Keep a parent popup open and paint this hover preview above its layer. */
  nested?: boolean;
}) {
  const order: Record<CheckVisual, number> = {
    failure: 0,
    pending: 1,
    success: 2,
    skipped: 3,
    neutral: 3,
  };
  const sorted = [...checks].sort(
    (a, b) => order[checkStatusMeta(a).kind] - order[checkStatusMeta(b).kind],
  );
  const summary = sorted.reduce(
    (sum, check) => {
      switch (checkStatusMeta(check).kind) {
        case "success":
          sum.passed++;
          break;
        case "failure":
          sum.failed++;
          break;
        case "pending":
          sum.pending++;
          break;
      }
      return sum;
    },
    { passed: 0, failed: 0, pending: 0 },
  );

  return (
    <Popover.Root exclusive={!nested}>
      <Popover.Trigger
        render={trigger}
        openOnHover
        delay={200}
        closeDelay={120}
      />
      <Popover.Popup
        // Base UI inherits a parent popover's portal container. The workspace
        // summary lives in the header actions, whose z-1 stacking context sits
        // below Review's sticky topbar. Escape that context so this child preview
        // can use the shared floating layer above both surfaces.
        portalContainer={
          nested && typeof document !== "undefined" ? document.body : undefined
        }
        side="left"
        align="start"
        sideOffset={10}
        className={mergeStylexOverrideClassName(
          "",
          sx.flex,
          sx.maxHMin560px70vhVarAvailableHeight,
          sx.wMin440pxCalc100vw24px,
          sx.flexCol,
          sx.overflowHidden,
          sx.p0,
        )}
      >
        <div
          {...stylex.props(
            sx.flex,
            sx.itemsBaseline,
            sx.justifyBetween,
            sx.gap25,
            sx.borderB,
            sx.borderDivider,
            sx.bgSurface,
            sx.px3,
            sx.py9px,
          )}
        >
          <span {...stylex.props(sx.fontSemibold, sx.textFg, typography.label)}>
            {sorted.length} check{sorted.length === 1 ? "" : "s"}
          </span>
          <span
            {...stylex.props(
              sx.inlineFlex,
              sx.gap2,
              sx.fontSemibold,
              typography.meta,
            )}
          >
            {summary.passed > 0 && (
              <span {...stylex.props(sx.textGreen)}>
                {summary.passed} passed
              </span>
            )}
            {summary.failed > 0 && (
              <span {...stylex.props(sx.textRed)}>{summary.failed} failed</span>
            )}
            {summary.pending > 0 && (
              <span {...stylex.props(sx.textYellow)}>
                {summary.pending} running
              </span>
            )}
          </span>
        </div>
        <div {...stylex.props(sx.overflowYAuto, sx.p1)}>
          {sorted.map((check, i) => {
            const status = checkStatusMeta(check);
            const content = (
              <>
                <span
                  className={utilityClassName(
                    `inline-flex size-4 shrink-0 ${checkToneClass(status.kind)}`,
                  )}
                >
                  <CheckStatusIcon kind={status.kind} />
                </span>
                <span
                  {...stylex.props(
                    sx.minW0,
                    sx.flex1,
                    sx.truncate,
                    sx.fontMedium,
                    sx.textFg,
                    typography.label,
                  )}
                >
                  {check.name}
                </span>
                <span
                  {...stylex.props(
                    sx.shrink0,
                    sx.fontMedium,
                    sx.textDim,
                    typography.label,
                  )}
                >
                  {status.label}
                </span>
              </>
            );
            return check.url ? (
              <a
                key={`${check.name}:${i}`}
                {...stylex.props(
                  sx.flex,
                  sx.itemsCenter,
                  sx.gap9px,
                  sx.roundedMd,
                  sx.px2,
                  sx.py15,
                  sx.textFg,
                  sx.noUnderline,
                  sx.hoverBgSurface,
                )}
                href={check.url}
                target="_blank"
                rel="noopener"
              >
                {content}
              </a>
            ) : (
              <div
                key={`${check.name}:${i}`}
                {...stylex.props(
                  sx.flex,
                  sx.itemsCenter,
                  sx.gap9px,
                  sx.roundedMd,
                  sx.px2,
                  sx.py15,
                  sx.textFg,
                )}
              >
                {content}
              </div>
            );
          })}
        </div>
      </Popover.Popup>
    </Popover.Root>
  );
}
