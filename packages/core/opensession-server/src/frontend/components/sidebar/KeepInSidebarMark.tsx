import { mergeStylexProps } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconInbox, IconPlus } from "../icons";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  absolute: {
    position: "absolute",
  },
  Right1: {
    right: "calc(4px * -1)",
  },
  Bottom1: {
    bottom: "calc(4px * -1)",
  },
  flex: {
    display: "flex",
  },
  size3: {
    width: "calc(4px * 3)",
    height: "calc(4px * 3)",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgAccent: {
    backgroundColor: "var(--accent)",
  },
  textOnAccent: {
    color: "var(--on-accent)",
  },
});

/** Inbox-plus mark shared by sidebar rows and the top bar. */
export function KeepInSidebarIcon({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        utilityClassName("relative inline-flex shrink-0"),
        className,
      )}
    >
      <IconInbox size={20} />
      <span
        aria-hidden="true"
        {...mergeStylexProps(
          "ring-2 ring-panel",
          sx.absolute,
          sx.Right1,
          sx.Bottom1,
          sx.flex,
          sx.size3,
          sx.itemsCenter,
          sx.justifyCenter,
          sx.roundedFull,
          sx.bgAccent,
          sx.textOnAccent,
        )}
      >
        <IconPlus size={9} />
      </span>
    </span>
  );
}

/** The inline claim affordance for a row that is visible but not yet kept. */
export function KeepInSidebarMark({
  onKeep,
  label = "Keep in sidebar",
  className,
  onMouseEnter,
}: {
  onKeep: () => void;
  label?: string;
  className?: string;
  onMouseEnter?: () => void;
}) {
  const keep = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    onKeep();
  };
  return (
    <Tooltip label={label}>
      <span
        role="button"
        tabIndex={0}
        aria-label={label}
        data-sidebar-keep=""
        className={cn(
          utilityClassName(
            "focus-ring relative shrink-0 cursor-pointer items-center justify-center rounded-md text-faint transition-[color,scale] hover:text-fg active:scale-[0.96] motion-reduce:transform-none",
          ),
          className ??
            utilityClassName(
              "ml-1 flex size-5 before:absolute before:-inset-3 before:content-[''] desktop:before:-inset-2.5",
            ),
        )}
        onClick={keep}
        onMouseEnter={onMouseEnter}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
        onTouchEnd={keep}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") keep(event);
        }}
      >
        <KeepInSidebarIcon />
      </span>
    </Tooltip>
  );
}
