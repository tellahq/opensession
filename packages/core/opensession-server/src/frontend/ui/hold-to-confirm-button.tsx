import React, { useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "./button";
import * as stylex from "@stylexjs/stylex";
import { cn } from "./cn";
import { color, layer, space } from "./tokens.stylex";

/** `color-mix` ink at a fixed strength over whatever surface is behind it. */
const ink = (c: string, pct: number) =>
  `color-mix(in oklab, ${c} ${pct}%, transparent)`;

const styles = stylex.create({
  // The fill that sweeps across the plate while it is held.
  fill: {
    pointerEvents: "none",
    position: "absolute",
    inset: space.s0,
    transformOrigin: "left",
    backgroundColor: ink(color.onScrim, 20),
  },
  label: { position: "relative", zIndex: layer.sticky },
});

export interface HoldToConfirmButtonProps extends Omit<
  ButtonProps,
  "onClick" | "children"
> {
  /** Idle label before holding (e.g. "Hold to merge anyway"). */
  label: string;
  /** Optional label while holding (defaults to `label`). */
  holdingLabel?: string;
  /** Optional label while the confirmed action is running. */
  busyLabel?: string;
  /** Whether the confirmed action is currently in flight. */
  busy?: boolean;
  /** Hold duration in milliseconds (default 900ms). */
  holdMs?: number;
  /** Fires once the hold completes. */
  onConfirm: () => void;
}

/**
 * Press-and-hold confirmation button for destructive or bypass actions (e.g.
 * force merging past branch protection). Prevents accidental single clicks
 * while staying one fluid gesture: press and hold with pointer or Space/Enter
 * until the fill completes; release early to cancel.
 */
export function HoldToConfirmButton({
  label,
  holdingLabel,
  busyLabel,
  busy = false,
  holdMs = 900,
  onConfirm,
  disabled,
  variant = "danger-strong",
  size = "lg",
  className,
  ...rest
}: HoldToConfirmButtonProps) {
  const [holding, setHolding] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);

  const cancel = () => {
    activeRef.current = false;
    setHolding(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => cancel, []);

  const start = () => {
    if (disabled || busy || activeRef.current) return;
    activeRef.current = true;
    setHolding(true);
    timerRef.current = setTimeout(() => {
      activeRef.current = false;
      timerRef.current = null;
      setHolding(false);
      onConfirm();
    }, holdMs);
  };

  const displayLabel = busy
    ? (busyLabel ?? label)
    : holding
      ? (holdingLabel ?? label)
      : label;

  return (
    <Button
      {...rest}
      type="button"
      variant={variant}
      size={size}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-label={displayLabel}
      data-holding={holding ? "" : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(e) => {
        if (e.repeat) return;
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={cancel}
      className={cn(
        "relative select-none overflow-hidden touch-none",
        className,
      )}
    >
      <span
        aria-hidden="true"
        {...stylex.props(styles.fill)}
        style={{
          transform: holding ? "scaleX(1)" : "scaleX(0)",
          transition: holding
            ? `transform ${holdMs}ms linear`
            : "transform 140ms ease-out",
        }}
      />
      <span {...stylex.props(styles.label)}>{displayLabel}</span>
    </Button>
  );
}
