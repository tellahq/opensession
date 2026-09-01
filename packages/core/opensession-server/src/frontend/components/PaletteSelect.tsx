import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useState } from "react";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { isApple } from "../lib/platform";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  absolute: {
    position: "absolute",
  },
  inset0: {
    inset: "0",
  },
  hFull: {
    height: "100%",
  },
  wFull: {
    width: "100%",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  appearanceNone: {
    appearance: "none",
  },
  borderNone: {
    borderStyle: "none",
  },
  opacity0: {
    opacity: "0%",
  },
  disabledCursorDefault: {
    ":disabled": {
      cursor: "default",
    },
  },
  maxWMin360pxCalc100vw1rem: {
    maxWidth: "min(360px, calc(100vw - 1rem))",
  },
  flex: {
    display: "flex",
  },
  minW0: {
    minWidth: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  shrink0: {
    flexShrink: "0",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  w0: {
    width: "0",
  },
  minWFull: {
    minWidth: "100%",
  },
  px25: {
    paddingInline: "calc(4px * 2.5)",
  },
  pt15: {
    paddingTop: "calc(4px * 1.5)",
  },
  pb05: {
    paddingBottom: "calc(4px * 0.5)",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
});

export type PaletteSelectOption = {
  value: string;
  label: string;
  menuLabel?: string;
  /** Optional leading icon shown before the label in the desktop menu. */
  icon?: React.ReactNode;
  /**
   * Multi-select pickers only: this row can be picked on its own but never
   * alongside another, so the modifier falls through to a plain pick.
   */
  singleOnly?: boolean;
};

type Props = {
  value: string;
  options: PaletteSelectOption[];
  onChange: (value: string) => void;
  /**
   * Values picked alongside `value`, in the order they were added. Passing
   * `onToggleExtra` turns the menu multi-select: the platform's command
   * modifier adds or removes a row and leaves the menu open, while a plain
   * click still picks one row and closes.
   */
  extraValues?: string[];
  onToggleExtra?: (value: string) => void;
  /** Footer line under the rows: the gesture has nowhere else to announce itself. */
  multiHint?: string;
  isPhone: boolean;
  className: string;
  children: React.ReactNode;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  align?: "start" | "center" | "end";
};

export function PaletteSelect({
  value,
  options,
  onChange,
  extraValues,
  onToggleExtra,
  multiHint,
  isPhone,
  className,
  children,
  ariaLabel,
  title,
  disabled,
  align = "start",
}: Props) {
  // Owned here because a multi-select pick has to leave the menu up: Base UI
  // closes on `Menu.Item`'s own click, and `closeOnClick` is a per-item prop
  // rather than something the handler can decide, so the close is ours to
  // make. Single-select pickers behave exactly as they did.
  const [open, setOpen] = useState(false);

  if (isPhone) {
    return (
      <div className={className} title={title}>
        {children}
        {/* Invisible native <select> stacked over the styled trigger so we
				    get a real OS menu without hand-rolling a popover. There is no
				    modifier on a phone, so this stays single-select; a second repo
				    is added from the session's own repo menu instead. */}
        <select
          {...stylex.props(
            sx.absolute,
            sx.inset0,
            sx.hFull,
            sx.wFull,
            sx.cursorPointer,
            sx.appearanceNone,
            sx.borderNone,
            sx.opacity0,
            sx.disabledCursorDefault,
          )}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-label={ariaLabel}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const picked = new Set([value, ...(extraValues || [])]);

  function pick(option: PaletteSelectOption, additive: boolean) {
    if (additive && onToggleExtra && !option.singleOnly) {
      onToggleExtra(option.value);
      return;
    }
    onChange(option.value);
    setOpen(false);
  }

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        type="button"
        className={className}
        title={title}
        disabled={disabled}
        aria-label={ariaLabel}
      >
        {children}
      </Menu.Trigger>
      <Menu.Popup
        align={align}
        sideOffset={6}
        className={mergeStylexOverrideClassName(
          "",
          sx.maxWMin360pxCalc100vw1rem,
        )}
      >
        {options.map((option) => {
          const selected = picked.has(option.value);
          return (
            <Menu.Item
              key={option.value}
              closeOnClick={false}
              // Base UI hands a keyboard Enter to this same handler (as
              // the keyboard event, not a synthesized click), so the
              // modifier form works from the keyboard too.
              onClick={(e) => pick(option, isApple ? e.metaKey : e.ctrlKey)}
              // A hair of air between rows: more than one can be picked
              // here, and two selected rows that touch read as one block
              // with a pinched waist rather than as two repos.
              className={cn(
                utilityClassName("mt-0.5 justify-between gap-3 first:mt-0"),
                selected && utilityClassName("bg-hover"),
              )}
            >
              <span
                {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap25)}
              >
                {option.icon && (
                  <span
                    {...stylex.props(sx.flex, sx.shrink0, sx.textDim)}
                    aria-hidden="true"
                  >
                    {option.icon}
                  </span>
                )}
                <span {...stylex.props(sx.minW0, sx.truncate)}>
                  {option.menuLabel ?? option.label}
                </span>
              </span>
              <Menu.Check
                on={selected}
                className={mergeStylexOverrideClassName("", sx.textDim)}
              />
            </Menu.Item>
          );
        })}
        {onToggleExtra &&
          multiHint && (
            // `w-0 min-w-full` keeps this line out of the popup's own width:
            // the hint changes as you pick, so a popup sized to it would be
            // one width teaching the gesture and another naming the repos.
            // The rows decide how wide the menu is; the hint wraps inside it.
            <div
              {...stylex.props(
                sx.w0,
                sx.minWFull,
                sx.px25,
                sx.pt15,
                sx.pb05,
                sx.leadingSnug,
                sx.textFaint,
                typography.supporting,
              )}
            >
              {multiHint}
            </div>
          )}
      </Menu.Popup>
    </Menu.Root>
  );
}
