import { utilityClassName } from "./cn";
import * as React from "react";
import { cn } from "./cn";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
});

/**
 * Field primitive — the shared optics for single-line inputs, multi-line
 * editors, and native selects.
 *
 * The app had no field primitive at all: 95 raw `<input>`s each carried their
 * own class list, and they had settled on `rounded-md` (7px) while every
 * button in the app is `rounded-control` (10px). A field and the button that
 * submits it therefore sat side by side with visibly different corners — the
 * single loudest reason a form here reads as assembled from parts rather than
 * designed.
 *
 * So the scale is deliberately Button's scale, step for step: same heights,
 * same horizontal padding, same one radius. A field and a button of the same
 * size are the same box; only the fill and the border differ, which is the
 * distinction that should carry (a well you type into vs. a plate you press).
 *
 * The fill is `bg-surface` — the page's own surface, so a field reads as a
 * well cut into the group it sits in rather than another raised card. Focus
 * moves the border to the accent instead of adding a ring: the accent is ink
 * now, so a full-strength border is legible in both themes and costs no
 * layout.
 */

type Size = "sm" | "md" | "lg";

/** Height/padding/type per step — mirrors `Button`'s `sizes`.
 * Inputs take the exact step height rather than only a minimum, so their
 * single line can be centered consistently across Chromium and WebKit. */
const sizes: Record<Size, string> = {
  sm: utilityClassName("min-h-[26px] px-2 text-xs [&:where(input)]:h-[26px]"),
  md: utilityClassName("min-h-8 px-2.5 text-sm [&:where(input)]:h-8"),
  lg: utilityClassName("min-h-9 px-3 text-base [&:where(input)]:h-9"),
};

/**
 * Everything a field shares regardless of element: corner, fill, border,
 * placeholder, focus, disabled. Exported for the few natively-styled controls
 * that cannot be one of the components below (a `<select>` needing its own
 * appearance reset, a contenteditable).
 */
export const fieldClass =
  // Block padding and a one-line box center input text vertically. The element
  // selector deliberately leaves multiline textareas and native selects alone.
  utilityClassName(
    "w-full rounded-control border border-line bg-surface text-fg outline-none transition-colors placeholder:text-faint focus:border-accent disabled:cursor-default disabled:opacity-40 [&:where(input)]:py-0 [&:where(input)]:leading-none",
  );

export function fieldClasses(size: Size = "md", className?: string) {
  return cn(fieldClass, sizes[size], className);
}

// `ComponentProps` rather than `ComponentPropsWithoutRef`: under React 19 a ref
// is an ordinary prop, so this is all it takes for a caller to hold onto the
// element (focus it, measure it, autosize a textarea). Written without it, the
// four sites in the app that need a ref had to fall back to `fieldClasses()` on
// a raw element — the exact copy-the-classes pattern this primitive exists to
// end.
type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
  size?: Size;
};

export function Input({ className, size = "md", ...props }: InputProps) {
  return <input className={fieldClasses(size, className)} {...props} />;
}

type TextareaProps = React.ComponentProps<"textarea"> & {
  size?: Size;
};

/** Multi-line entry. Vertically resizable and padded like a paragraph rather
 *  than a single line, but the same well as `Input` in every other respect. */
export function Textarea({ className, size = "md", ...props }: TextareaProps) {
  return (
    <textarea
      className={fieldClasses(
        size,
        cn(utilityClassName("resize-y py-2"), className),
      )}
      {...props}
    />
  );
}

type SelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  size?: Size;
};

/** Native select in the field shape. `ui/select` is the default now: it wears
 *  the same field, and it opens the app's popup rather than the platform's
 *  dropdown. Reach for this one only when you specifically want the OS picker
 *  or a native select's own keyboard behaviour (see `PaletteSelect`,
 *  `SessionSearch`). */
export function Select({ className, size = "md", ...props }: SelectProps) {
  return (
    <select
      className={fieldClasses(
        size,
        cn(utilityClassName("cursor-pointer"), className),
      )}
      {...props}
    />
  );
}

/**
 * A labelled field: the label sitting 6px above its control, wrapped in a
 * `<label>` so the text is part of the control's hit area and name.
 *
 * Four surfaces had each written this same recipe by hand (`SetupTeam`'s
 * `dialogFieldLabelClass`, `SpinOffMenu`'s `fieldLabelCls`, `ProjectsSection`'s
 * `labelCls`, settings' own `SettingsField`), which is how their labels drifted
 * apart. Field vocabulary rather than dialog vocabulary — a settings form and a
 * dialog form want the identical shape, so it lives here with the field itself.
 */
export function Field({
  label,
  className,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"label">, "children"> & {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        utilityClassName("flex min-w-0 flex-col gap-1.5"),
        className,
      )}
      {...props}
    >
      <span {...stylex.props(sx.fontMedium, sx.textDim, typography.label)}>
        {label}
      </span>
      {children}
    </label>
  );
}

/** Two `Field`s side by side, stacking on a phone. Only for genuinely short
 *  values (an id, a login) — a column is ~half a dialog wide, so anything the
 *  length of an email address clips at every viewport. */
export function FieldGrid({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        utilityClassName("grid grid-cols-2 gap-3 phone:grid-cols-1"),
        className,
      )}
      {...props}
    />
  );
}
