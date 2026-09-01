import { mergeStylexOverrideClassName } from "../../ui/cn";
import type { ReactNode } from "react";
import { MINE_STATUS_META, type MineStatus } from "../../lib/sidebar-types";
import { SheetBody, SheetIconButton, SheetItem } from "../../ui/sheet";
import { PhoneTopBar, PhoneTopBarTitle } from "../../ui/top-bar";
import { IconCheck, IconChevronLeft, IconChevronRight } from "../icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  grid: {
    display: "grid",
  },
  size22px: {
    width: "22px",
    height: "22px",
  },
  shrink0: {
    flexShrink: "0",
  },
  placeItemsCenter: {
    placeItems: "center",
  },
  size2: {
    width: "calc(4px * 2)",
    height: "calc(4px * 2)",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
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
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  absolute: {
    position: "absolute",
  },
  left3: {
    left: "calc(4px * 3)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLineStrong: {
    borderColor: "var(--border-strong)",
  },
});

export type LanePickerValue = MineStatus | "mixed" | null;

export function lanePickerLabel(value: LanePickerValue): string {
  if (value === "mixed") return "Mixed";
  return MINE_STATUS_META.find((item) => item.key === value)?.label ?? "Auto";
}

export function LaneStatusMark({ value }: { value: LanePickerValue }) {
  const color = MINE_STATUS_META.find((item) => item.key === value)?.dotColor;
  return (
    <span
      {...stylex.props(sx.grid, sx.size22px, sx.shrink0, sx.placeItemsCenter)}
    >
      <span
        {...stylex.props(sx.size2, sx.roundedFull)}
        style={{ background: color ?? "var(--text-faint)" }}
      />
    </span>
  );
}

export function SheetDrillInItem({
  icon,
  label,
  value,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
  onClick: () => void;
}) {
  return (
    <SheetItem onClick={onClick}>
      {icon}
      <span>{label}</span>
      <span
        {...stylex.props(
          sx.mlAuto,
          sx.flex,
          sx.minW0,
          sx.itemsCenter,
          sx.gap15,
          sx.textFaint,
          typography.supporting,
        )}
      >
        {value && <span {...stylex.props(sx.truncate)}>{value}</span>}
        <IconChevronRight size={20} />
      </span>
    </SheetItem>
  );
}

export function SheetPageHeader({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}) {
  return (
    <PhoneTopBar>
      <SheetIconButton
        className={mergeStylexOverrideClassName("", sx.absolute, sx.left3)}
        onClick={onBack}
        aria-label="Back to actions"
      >
        <IconChevronLeft size={24} />
      </SheetIconButton>
      <PhoneTopBarTitle
        className={mergeStylexOverrideClassName("", typography.sectionTitle)}
      >
        {title}
      </PhoneTopBarTitle>
    </PhoneTopBar>
  );
}

export function LanePickerPage({
  current,
  onBack,
  onSelect,
}: {
  current: LanePickerValue;
  onBack: () => void;
  onSelect: (status: MineStatus | null) => void;
}) {
  return (
    <>
      <SheetPageHeader title="Status" onBack={onBack} />
      <SheetBody>
        {MINE_STATUS_META.map((item) => (
          <SheetItem key={item.key} onClick={() => onSelect(item.key)}>
            <span
              {...stylex.props(sx.size2, sx.shrink0, sx.roundedFull)}
              style={{ background: item.dotColor }}
            />
            {item.label}
            {current === item.key && (
              <IconCheck
                size={20}
                className={mergeStylexOverrideClassName(
                  "",
                  sx.mlAuto,
                  sx.textDim,
                )}
              />
            )}
          </SheetItem>
        ))}
        <SheetItem onClick={() => onSelect(null)}>
          <span
            {...stylex.props(
              sx.size2,
              sx.shrink0,
              sx.roundedFull,
              sx.border,
              sx.borderLineStrong,
            )}
          />
          Auto
          {current === null && (
            <IconCheck
              size={20}
              className={mergeStylexOverrideClassName(
                "",
                sx.mlAuto,
                sx.textDim,
              )}
            />
          )}
        </SheetItem>
      </SheetBody>
    </>
  );
}
