import { mergeStylexOverrideClassName } from "./cn";
import { utilityClassName } from "./cn";
import * as React from "react";
import {
  SETTING_GLYPH,
  SETTING_ROW,
  SETTING_ROW_PRESSABLE,
} from "../lib/setting-row-classes";
import { IconChevronDown } from "../components/icons";
import { cn } from "./cn";
import { Menu } from "./menu";
import { Switch } from "./switch";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  shrink0: {
    flexShrink: "0",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mlAuto: {
    marginLeft: "auto",
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
  gap2: {
    gap: "calc(4px * 2)",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  textFg: {
    color: "var(--text)",
  },
  Mr05: {
    marginRight: "calc(4px * -0.5)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
});

/** The rows a settings popover is made of. The rule they follow, and why they
 *  wear a menu row rather than a field, is in `lib/setting-row-classes`. */
export interface SettingOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

/** A setting whose control draws itself: a segmented control, a stepper, a
 *  pair of buttons. The row names it and pins it right. */
export function SettingRow({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(SETTING_ROW, className)}>
      <span {...stylex.props(sx.shrink0, sx.textDim)}>{label}</span>
      <span
        {...stylex.props(sx.mlAuto, sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}
      >
        {children}
      </span>
    </div>
  );
}

/** A setting that is on or off. The label is part of the target, so the whole
 *  row flips it. */
export function SwitchRow({
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        SETTING_ROW,
        disabled ? utilityClassName("cursor-default") : SETTING_ROW_PRESSABLE,
      )}
    >
      {/* A setting that cannot apply yet dims its name too: a live label
			    over a faded switch reads as a switch that failed to draw. */}
      <span
        className={cn(
          utilityClassName("shrink-0"),
          disabled
            ? utilityClassName("text-faint")
            : utilityClassName("text-dim"),
        )}
      >
        {label}
      </span>
      <Switch
        className={mergeStylexOverrideClassName("", sx.mlAuto)}
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  );
}

/** The options behind a `ValueRow`, and behind a submenu asking the same
 *  question one level in. */
export function ValueOptions({
  value,
  options,
  onSelect,
}: {
  value: string;
  options: SettingOption[];
  onSelect: (value: string) => void;
}) {
  const glyphs = options.some((option) => option.icon);
  return (
    <Menu.RadioGroup
      value={value}
      onValueChange={(next) => onSelect(String(next))}
    >
      {options.map((option) => (
        // `closeOnClick`, because this list is a value picker: Base UI
        // leaves a radio item's menu open by default, which is right for a
        // menu you keep toggling things in and wrong for one answering a
        // single question.
        <Menu.RadioItem
          key={option.value}
          value={option.value}
          closeOnClick
          className={mergeStylexOverrideClassName(
            "",
            sx.justifyBetween,
            sx.gap3,
          )}
        >
          <span {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}>
            {glyphs && <span className={SETTING_GLYPH}>{option.icon}</span>}
            <span {...stylex.props(sx.minW0, sx.truncate)}>{option.label}</span>
          </span>
          <Menu.Check on={option.value === value} />
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

/** A setting whose answers are too long to show at once: the row IS the
 *  control, holding the name, the answer in effect, and a chevron. */
export function ValueRow({
  label,
  value,
  options,
  onSelect,
  trailing,
  footer,
  className,
}: {
  label: string;
  value: string;
  options: SettingOption[];
  onSelect: (value: string) => void;
  /** A glyph after the value, for a second setting the value is read with
   *  rather than another value to pick: the direction an order runs in. */
  trailing?: React.ReactNode;
  /** Rows under the options, below a rule: a setting about the things the
   *  options name, rather than another one of them to pick. */
  footer?: React.ReactNode;
  className?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(SETTING_ROW, SETTING_ROW_PRESSABLE, className)}
      >
        <span {...stylex.props(sx.shrink0, sx.textDim)}>{label}</span>
        <span
          {...stylex.props(
            sx.mlAuto,
            sx.flex,
            sx.minW0,
            sx.itemsCenter,
            sx.gap2,
            sx.textFg,
          )}
        >
          {current?.icon && (
            <span className={SETTING_GLYPH}>{current.icon}</span>
          )}
          <span {...stylex.props(sx.truncate)}>{current?.label ?? value}</span>
          {trailing}
          <IconChevronDown
            size={16}
            className={mergeStylexOverrideClassName(
              "",
              sx.Mr05,
              sx.shrink0,
              sx.textFaint,
            )}
          />
        </span>
      </Menu.Trigger>
      <Menu.Popup align="end" sideOffset={6}>
        <ValueOptions value={value} options={options} onSelect={onSelect} />
        {footer && (
          <>
            <Menu.Separator />
            {footer}
          </>
        )}
      </Menu.Popup>
    </Menu.Root>
  );
}
