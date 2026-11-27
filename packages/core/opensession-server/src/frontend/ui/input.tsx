import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { field } from "./field-styles";
import { sx } from "./sx";
import { color, media, space, text, weight } from "./tokens.stylex";

const styles = stylex.create({
  field: {
    display: "flex",
    minWidth: 0,
    flexDirection: "column",
    gap: space.s6,
  },
  label: { fontSize: text.label, fontWeight: weight.medium, color: color.dim },
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [media.phone]: "repeat(1, minmax(0, 1fr))",
    },
    gap: space.s12,
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
 * So the heights are deliberately Button's, step for step. The corner is not:
 * buttons are pills, and a field keeps the soft `rounded-control` rect, the
 * way macOS pairs a rounded text field with a capsule button. The shape is
 * what says which is a well you type into and which a plate you press.
 *
 * The fill is `bg-surface` — the page's own surface, so a field reads as a
 * well cut into the group it sits in rather than another raised card. Focus
 * moves the border to the accent instead of adding a ring: the accent is ink
 * now, so a full-strength border is legible in both themes and costs no
 * layout.
 */

type Size = "sm" | "md" | "lg";

/**
 * The field's classes as one string, for the few natively-styled controls
 * that cannot be one of the components below (a `<select>` needing its own
 * appearance reset, a contenteditable). The caller's classes land last and
 * win a tie, as they did under tailwind-merge.
 */
export function fieldClasses(size: Size = "md", className?: string) {
  return sx([field.base, field[size]], className).className;
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
  return <input {...sx([field.base, field[size]], className)} {...props} />;
}

type TextareaProps = React.ComponentProps<"textarea"> & {
  size?: Size;
};

/** Multi-line entry. Vertically resizable and padded like a paragraph rather
 *  than a single line, but the same well as `Input` in every other respect. */
export function Textarea({ className, size = "md", ...props }: TextareaProps) {
  return (
    <textarea
      {...sx([field.base, field[size], field.textarea], className)}
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
      {...sx([field.base, field[size], field.select], className)}
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
    <label {...sx(styles.field, className)} {...props}>
      <span {...stylex.props(styles.label)}>{label}</span>
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
  return <div {...sx(styles.grid, className)} {...props} />;
}
