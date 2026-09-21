import { cn } from "./cn";
import { fieldClasses } from "./input";

type Size = "sm" | "md" | "lg";

/**
 * The field-shaped trigger `ui/select` and `ui/combobox` share: a select and
 * a searchable select sit in the same rows, so they open from the same box.
 *
 * The chevron sits in flow in its own grid column, so the field's own padding
 * is what separates it from the edge. A select lifts slightly under the
 * pointer; opening still reads like focus, with the border carrying that
 * state as on every other field.
 */
export function selectTriggerClasses(
  size: Size = "md",
  iconSlot = false,
  className?: string,
) {
  return cn(
    fieldClasses(
      size,
      cn(
        "inline-grid cursor-pointer items-center gap-2 pr-2 text-left",
        iconSlot
          ? "grid-cols-[auto_minmax(0,1fr)_auto]"
          : "grid-cols-[minmax(0,1fr)_auto]",
      ),
    ),
    "transition-[border-color,box-shadow] hover:border-line-strong enabled:hover:smooth-shadow-xs data-[popup-open]:border-accent",
    className,
  );
}
