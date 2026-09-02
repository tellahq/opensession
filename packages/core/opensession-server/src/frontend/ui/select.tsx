import * as React from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { IconCheck, IconChevronDown } from "../components/icons";
import { cn } from "./cn";
import { fieldClasses } from "./input";
import {
  FLOATING_OVERLAY_LAYER,
  POPUP_HOOK,
  popupItemClasses,
  popupScrollClasses,
  popupSurfaceClasses,
} from "./popup-classes";
import { restoreSelectFocusAfterClose } from "./select-focus";

/**
 * Select on Base UI parts: a field-shaped trigger that opens the app's own
 * popup instead of the operating system's dropdown.
 *
 * A native `<select>` is the odd control out here. It draws the platform's
 * arrow rather than our icon set, it opens a list styled by the OS, and its
 * rows can carry nothing but text, so a page of settings ends with one
 * control that belongs to a different app. This is the same surface every
 * menu in the product already uses (`ui/popup-classes.ts`), so a select and
 * the ⋯ menu in the row beside it open the same-looking list.
 *
 * Composable parts, like `ui/menu`: assemble Root/Trigger/Popup/Item rather
 * than passing item configs. `components/settings/shared.tsx` wraps these in
 * the options-array API settings rows use.
 *
 * One thing to know: pass `items` to `Root`. The trigger's value text is
 * resolved from that list, so without it a closed select shows the raw value
 * (`pi/anthropic/claude-opus-5`) instead of its label.
 *
 * Reach for `ui/input`'s native `Select` only when you specifically want the
 * OS picker.
 */

type Size = "sm" | "md" | "lg";

const SelectFocusContext = React.createContext<React.RefObject<boolean> | null>(
  null,
);

function Root<Value, Multiple extends boolean | undefined = false>({
  onOpenChange,
  onOpenChangeComplete,
  children,
  ...props
}: BaseSelect.Root.Props<Value, Multiple>) {
  const restoreFocusRef = React.useRef(true);
  const dismissedElementRef = React.useRef<HTMLElement | null>(null);
  return (
    <SelectFocusContext.Provider value={restoreFocusRef}>
      <BaseSelect.Root
        {...props}
        onOpenChange={(open, eventDetails) => {
          if (!open) {
            restoreFocusRef.current = restoreSelectFocusAfterClose(
              eventDetails.reason,
            );
            if (
              !restoreFocusRef.current &&
              document.activeElement instanceof HTMLElement
            ) {
              dismissedElementRef.current = document.activeElement;
              dismissedElementRef.current.blur();
            }
          }
          onOpenChange?.(open, eventDetails);
        }}
        onOpenChangeComplete={(open) => {
          if (!open && !restoreFocusRef.current) {
            dismissedElementRef.current?.blur();
            dismissedElementRef.current = null;
          }
          onOpenChangeComplete?.(open);
        }}
      >
        {children}
      </BaseSelect.Root>
    </SelectFocusContext.Provider>
  );
}

type TriggerProps = Omit<
  React.ComponentProps<typeof BaseSelect.Trigger>,
  "className"
> & {
  className?: string;
  size?: Size;
  /** Shown when nothing is selected. */
  placeholder?: React.ReactNode;
  /**
   * A glyph before the value, in its own column so `sizeTo` still governs
   * the label's width. Pass it (even as `null`) to keep the slot reserved,
   * so a value with no glyph doesn't shift the text.
   */
  icon?: React.ReactNode;
  /**
   * Every label the select can show. The trigger reserves the width of the
   * widest one, so choosing a longer option doesn't resize the control and
   * shuffle the row around it. A native select does this for free; a custom
   * trigger sizes to the current value unless it is told the rest.
   *
   * Skip it where the trigger's width is already fixed by its container (a
   * form grid, a `w-full` field).
   */
  sizeTo?: React.ReactNode[];
};

function Trigger(triggerProps: TriggerProps) {
  const {
    className,
    size = "md",
    placeholder,
    sizeTo,
    icon,
    children,
    ...props
  } = triggerProps;
  // Presence, not truthiness: an icon-bearing list keeps the slot for the
  // values that have no glyph, so the labels stay on one x.
  const iconSlot = "icon" in triggerProps;
  const label = iconSlot ? "col-start-2" : "col-start-1";
  return (
    <BaseSelect.Trigger
      {...props}
      className={cn(
        fieldClasses(
          size,
          // The chevron sits in flow in its own grid column, so the
          // field's own padding is what separates it from the edge.
          cn(
            "inline-grid cursor-pointer items-center gap-2 pr-2 text-left",
            iconSlot
              ? "grid-cols-[auto_minmax(0,1fr)_auto]"
              : "grid-cols-[minmax(0,1fr)_auto]",
          ),
        ),
        // A select lifts slightly under the pointer; opening still reads like
        // focus, with the border carrying that state as on every other field.
        "transition-[border-color,box-shadow] hover:border-line-strong enabled:hover:smooth-shadow-xs data-[popup-open]:border-accent",
        className,
      )}
    >
      {iconSlot && (
        <span className="col-start-1 row-start-1 flex size-4 shrink-0 items-center justify-center text-dim">
          {icon}
        </span>
      )}
      <span className={cn("row-start-1 truncate", label)}>
        {children ?? <BaseSelect.Value placeholder={placeholder} />}
      </span>
      {sizeTo?.map((text, index) => (
        <span
          key={index}
          aria-hidden
          className={cn("invisible row-start-1 truncate", label)}
        >
          {text}
        </span>
      ))}
      <IconChevronDown
        size={16}
        className={cn(
          "row-start-1 shrink-0 text-faint",
          iconSlot ? "col-start-3" : "col-start-2",
        )}
      />
    </BaseSelect.Trigger>
  );
}

function Popup({
  className,
  side,
  align = "start",
  sideOffset = 6,
  children,
}: {
  className?: string;
  side?: React.ComponentProps<typeof BaseSelect.Positioner>["side"];
  align?: React.ComponentProps<typeof BaseSelect.Positioner>["align"];
  sideOffset?: number;
  children: React.ReactNode;
}) {
  const restoreFocusRef = React.useContext(SelectFocusContext);
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        // Base UI's default overlays the popup on its trigger so the
        // selected row lands under the cursor. That mode skips the
        // positioning transition and turns itself off on touch, which
        // would give this one popup two open behaviours and no
        // animation. Anchor it below the trigger like every menu.
        alignItemWithTrigger={false}
        className={cn(FLOATING_OVERLAY_LAYER, "outline-none")}
      >
        <BaseSelect.Popup
          finalFocus={() => restoreFocusRef?.current ?? true}
          className={cn(
            POPUP_HOOK,
            popupSurfaceClasses,
            "min-w-[var(--anchor-width)]",
            className,
          )}
        >
          <BaseSelect.List className={popupScrollClasses}>
            {children}
          </BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

type ItemProps = Omit<
  React.ComponentProps<typeof BaseSelect.Item>,
  "className"
> & {
  className?: string;
  /** A glyph before the label. Pass it (even as `null`) on every row of a
   * list where only some rows have one, so the labels stay aligned. */
  icon?: React.ReactNode;
};

function Item(itemProps: ItemProps) {
  const { className, icon, children, ...props } = itemProps;
  const iconSlot = "icon" in itemProps;
  return (
    <BaseSelect.Item
      {...props}
      className={cn(
        popupItemClasses,
        "justify-between gap-3 data-[disabled]:cursor-default data-[disabled]:opacity-40",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {iconSlot && (
          <span className="flex size-4 shrink-0 items-center justify-center text-dim">
            {icon}
          </span>
        )}
        <BaseSelect.ItemText className="min-w-0 truncate">
          {children}
        </BaseSelect.ItemText>
      </span>
      {/* The tick's column is reserved on every row, the way `ui/menu`'s
			    `Check` reserves it: an indicator that only takes space while
			    selected makes the picked row wider than the rest, so the popup
			    is a different width depending on what is selected. */}
      <span className="flex size-[17px] shrink-0 items-center justify-center text-accent">
        <BaseSelect.ItemIndicator>
          <IconCheck size={17} />
        </BaseSelect.ItemIndicator>
      </span>
    </BaseSelect.Item>
  );
}

function GroupLabel({
  className,
  ...props
}: Omit<React.ComponentProps<typeof BaseSelect.GroupLabel>, "className"> & {
  className?: string;
}) {
  return (
    <BaseSelect.GroupLabel
      {...props}
      className={cn(
        "px-2 pb-1 pt-1.5 text-meta font-semibold tracking-[-0.01em] text-faint",
        className,
      )}
    />
  );
}

function Separator({ className }: { className?: string }) {
  return (
    <BaseSelect.Separator
      className={cn("-mx-1.5 my-1.5 h-px bg-line", className)}
    />
  );
}

export const Select = {
  Root,
  Trigger,
  Value: BaseSelect.Value,
  Popup,
  Item,
  Group: BaseSelect.Group,
  GroupLabel,
  Separator,
};

/**
 * The flat case, which is most of them: a list of `{ value, label }` and the
 * one that is picked. Settings rows and form fields both reach for this;
 * assemble the parts above only when the list needs groups or custom rows.
 */
export function OptionSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
  size,
  triggerRef,
}: {
  value: T;
  /** `icon` is optional per option, but the slot is all-or-nothing: as soon
   *  as one row carries a glyph, every row and the trigger reserve the
   *  column, so the labels stay on one x. */
  options: {
    value: T;
    label: string;
    disabled?: boolean;
    icon?: React.ReactNode;
  }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  /** The control step, as on `Button` and the fields. Defaults to `md`. */
  size?: Size;
  /** The trigger element, for a dialog that opens with the caret in this
   *  field (`Modal.Content`'s `initialFocus`). */
  triggerRef?: React.ComponentProps<typeof Trigger>["ref"];
}) {
  const hasIcons = options.some((option) => option.icon != null);
  const selected = options.find((option) => option.value === value);
  return (
    <Select.Root
      // The labels the trigger draws its value from, so a closed select
      // reads "Ask first" rather than "ask".
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <Select.Trigger
        ref={triggerRef}
        aria-label={label}
        className={className}
        size={size}
        {...(hasIcons ? { icon: selected?.icon ?? null } : {})}
        sizeTo={options.map((option) => option.label)}
      />
      <Select.Popup align="end">
        {options.map((option) => (
          <Select.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            {...(hasIcons ? { icon: option.icon ?? null } : {})}
          >
            {option.label}
          </Select.Item>
        ))}
      </Select.Popup>
    </Select.Root>
  );
}
