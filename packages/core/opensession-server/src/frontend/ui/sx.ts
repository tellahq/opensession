import * as stylex from "@stylexjs/stylex";
import type {
  CompiledStyles,
  InlineStyles,
  StyleXArray,
  StyleXStyles,
} from "@stylexjs/stylex";
import type { CSSProperties } from "react";
import { cn } from "./cn";

type Styles = StyleXArray<
  | (null | undefined | CompiledStyles)
  | boolean
  | Readonly<[CompiledStyles, InlineStyles]>
>;

/** What a primitive spreads onto its element. */
export type SxProps = { className?: string; style?: CSSProperties };

/**
 * `stylex.props` plus the caller's `className` and `style`, for a primitive
 * that still accepts both while its call sites migrate. The caller's classes
 * land last: the StyleX sheet is linked ahead of the Tailwind utilities, so a
 * caller's utility wins a tie the way tailwind-merge let it before.
 */
export function sx(
  styles: Styles,
  className?: string,
  style?: CSSProperties,
): SxProps {
  const own = stylex.props(styles);
  const merged = cn(own.className, className);
  return {
    className: merged || undefined,
    style: own.style || style ? { ...own.style, ...style } : undefined,
  };
}

/**
 * StyleX styles as one class string, for the `lib/*-classes.ts` constants that
 * call sites still compose as strings. Pass every style one element wears in
 * ONE call: two strings that set the same property differently are settled by
 * stylesheet order, which is not a decision anyone made.
 */
export function classString(...styles: Styles[]): string {
  return stylex.props(styles).className ?? "";
}

/** Placement-only overrides every ported primitive accepts as `xstyle`. */
export type LayoutStyles = StyleXStyles<{
  margin?: string | number | null;
  marginBlock?: string | number | null;
  marginInline?: string | number | null;
  marginTop?: string | number | null;
  marginBottom?: string | number | null;
  marginInlineStart?: string | number | null;
  marginInlineEnd?: string | number | null;
  flex?: string | number | null;
  flexGrow?: string | number | null;
  flexShrink?: string | number | null;
  flexBasis?: string | number | null;
  alignSelf?: string | null;
  justifySelf?: string | null;
  order?: string | number | null;
  gridArea?: string | null;
  gridColumn?: string | null;
  gridRow?: string | null;
  width?: string | number | null;
  maxWidth?: string | number | null;
  minWidth?: string | number | null;
}>;
