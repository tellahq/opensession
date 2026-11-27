import { field } from "./field-styles";
import { sx } from "./sx";

type Size = "sm" | "md" | "lg";

/**
 * The field-shaped trigger `ui/select` and `ui/combobox` share, as one class
 * string: a select and a searchable select sit in the same rows, so they open
 * from the same box. See `field.trigger` for the look.
 */
export function selectTriggerClasses(
  size: Size = "md",
  iconSlot = false,
  className?: string,
) {
  return sx(
    [
      field.base,
      field[size],
      field.trigger,
      iconSlot ? field.triggerWithIcon : null,
    ],
    className,
  ).className;
}
