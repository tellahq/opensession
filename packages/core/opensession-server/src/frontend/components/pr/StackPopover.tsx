import { mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import { useState } from "react";
import {
  PR_ROW_OUT,
  PR_STATE_TEXT,
  prStackChipClass,
} from "../../lib/pr-tone-classes";
import type { PrTone } from "../../lib/pr-refs";
import { stackLayersTopFirst } from "../../lib/pr-stack";
import { prPath } from "../../lib/share-link";
import type { PrDetails, PrStackLayer } from "../../lib/types";
import { cn } from "../../ui/cn";
import { Popover } from "../../ui/popover";
import { IconArrowUpRight, IconStack } from "../icons";
import { StackNode, StackRail } from "./StackRail";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  noUnderline: {
    textDecorationLine: "none",
  },
  block: {
    display: "block",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  flex: {
    display: "flex",
  },
  maxHMin560px70vhVarAvailableHeight: {
    maxHeight: "min(560px, 70vh, var(--available-height))",
  },
  wMin460pxCalc100vw24px: {
    width: "min(460px, calc(100vw - 24px))",
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
  m0: {
    margin: "0",
  },
  listNone: {
    listStyleType: "none",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
});

/**
 * The stack, from the status strip: a chip reading `position/size` that opens
 * the whole stack on hover or click.
 *
 * The review panel already has a stack map (pr/Stack.tsx), but the strip is
 * where a person decides whether to merge — and merging a layer takes every
 * layer under it along, so the strip has to be able to show what "every layer
 * under it" actually is without leaving the session. Rows are drawn top-first
 * with the trunk as the last node, the way github.com draws a stack.
 */

/* The rail and its nodes live in ./StackRail so this component stays focused
   on the popup and its navigation rows. */

const ROW = utilityClassName("flex items-stretch gap-2.5 pr-1.5 pl-3");

function StackRow({
  layer,
  current,
  first,
  repo,
  onOpenPr,
  onNavigate,
}: {
  layer: PrStackLayer;
  current: boolean;
  first: boolean;
  repo?: string;
  onOpenPr?: (repo: string, branch: string) => void;
  onNavigate: () => void;
}) {
  // Layers open in this session's review panel, not on github.com — the arrow
  // on the right is the way out. Falls back to the GitHub URL when the repo id
  // is unknown, so a row is never a dead end.
  const inApp = repo ? prPath(repo, layer.headRefName) : null;
  // "You are here" is painted as a wash, not a surface: bg-surface is an
  // absolute colour and lands *lighter* than the popup's panel in light mode.
  return (
    <li
      className={cn(
        ROW,
        current
          ? utilityClassName("bg-hover")
          : utilityClassName("hover:bg-hover"),
      )}
    >
      <StackRail first={first}>
        <StackNode state={layer.state} isDraft={layer.isDraft} />
      </StackRail>
      <a
        {...stylex.props(sx.minW0, sx.flex1, sx.py2, sx.noUnderline)}
        href={inApp || layer.url}
        {...(inApp ? {} : { target: "_blank", rel: "noopener" })}
        aria-current={current ? "true" : undefined}
        onClick={(e) => {
          // Modified clicks keep native new-tab behavior.
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          onNavigate();
          if (!inApp || !onOpenPr) return;
          e.preventDefault();
          onOpenPr(repo!, layer.headRefName);
        }}
      >
        <span
          className={cn(
            utilityClassName("block truncate text-label leading-snug"),
            current
              ? utilityClassName("font-semibold text-fg")
              : utilityClassName("font-medium text-fg"),
          )}
        >
          {layer.title}
        </span>
        <span
          {...stylex.props(
            sx.block,
            sx.truncate,
            sx.leadingSnug,
            sx.textFaint,
            typography.meta,
          )}
        >
          #{layer.number} · {layer.headRefName}
        </span>
      </a>
      <a
        className={cn(
          PR_ROW_OUT,
          utilityClassName("self-center phone:size-11"),
        )}
        href={layer.url}
        target="_blank"
        rel="noopener"
        aria-label={`Open #${layer.number} on GitHub`}
      >
        <IconArrowUpRight size={20} />
      </a>
    </li>
  );
}

export function PrStackChip({
  pr,
  tone,
  size,
  headline,
  repo,
  onOpenPr,
}: {
  pr: PrDetails;
  tone: PrTone;
  /** Which strip the chip rides in — it sizes to that strip's other chips. */
  size: "bar" | "head";
  /** The strip's own headline, repeated as the popup's title so the popup
   *  says what merging the stack would mean, not just what is in it. */
  headline: string;
  /** Registered repo id, for in-app links to the other layers. */
  repo?: string;
  onOpenPr?: (repo: string, branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const stack = pr.stack;
  if (!stack) return null;
  const layers = stackLayersTopFirst(stack);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        openOnHover
        delay={200}
        closeDelay={120}
        render={
          <button
            type="button"
            className={prStackChipClass(tone, size)}
            aria-label={`Stack #${stack.number}: layer ${stack.position} of ${stack.size}`}
          />
        }
      >
        <IconStack size={20} />
        <span className="tabular-nums">
          {stack.position}/{stack.size}
        </span>
      </Popover.Trigger>
      <Popover.Popup
        side="bottom"
        align="start"
        sideOffset={6}
        className={mergeStylexOverrideClassName(
          "",
          sx.flex,
          sx.maxHMin560px70vhVarAvailableHeight,
          sx.wMin460pxCalc100vw24px,
          sx.flexCol,
          sx.overflowHidden,
          sx.p0,
        )}
      >
        {/* The strip's headline, in the strip's tone: the popup opens under a
				    green chip and has to keep saying what the green means. */}
        <div
          className={cn(
            utilityClassName(
              "shrink-0 border-b border-divider px-3 py-2.5 text-item-title font-semibold",
            ),
            PR_STATE_TEXT[tone],
          )}
        >
          {headline}
        </div>
        <ul
          {...stylex.props(
            sx.m0,
            sx.flex,
            sx.listNone,
            sx.flexCol,
            sx.overflowYAuto,
            sx.p0,
          )}
        >
          {layers.map((layer, i) => (
            <StackRow
              key={layer.number}
              layer={layer}
              current={layer.number === pr.number}
              first={i === 0}
              repo={repo}
              onOpenPr={onOpenPr}
              onNavigate={() => setOpen(false)}
            />
          ))}
          {/* The trunk: not a layer, just where the bottom one lands. */}
          <li className={cn(ROW, utilityClassName("py-2"))}>
            <StackRail last>
              <StackNode />
            </StackRail>
            <span
              {...stylex.props(
                sx.minW0,
                sx.flex1,
                sx.truncate,
                sx.fontMono,
                sx.textFaint,
                typography.label,
              )}
            >
              {stack.baseRefName}
            </span>
          </li>
        </ul>
      </Popover.Popup>
    </Popover.Root>
  );
}
