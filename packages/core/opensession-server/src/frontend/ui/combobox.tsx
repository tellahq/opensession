import * as React from "react";
import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { IconCheck, IconChevronDown, IconSearch } from "../components/icons";
import * as stylex from "@stylexjs/stylex";
import { cn } from "./cn";
import { field } from "./field-styles";
import { POPUP_HOOK } from "./popup-classes";
import { popup } from "./popup-styles";
import { sx } from "./sx";
import { selectTriggerClasses } from "./select-classes";
import { restoreSelectFocusAfterClose } from "./select-focus";

/**
 * A select whose list can be searched: `ui/select`'s trigger, the app's own
 * popup, and a search field at the top of the list.
 *
 * `ui/select` is right for a handful of options. Once a list runs to
 * hundreds (every Slack channel a person is in, every repository), scrolling
 * it is not choosing from it, and a native `<select>` offers only first-letter
 * typeahead. This keeps the closed control identical to a select, so a row
 * can swap one for the other without the row changing, and opens a list that
 * narrows as the person types.
 *
 * Built on Base UI's Combobox with the input inside the popup, which is the
 * shape Base UI documents for a select-like combobox: the trigger is the
 * button, the popup is a dialog holding the search field and the list.
 *
 * Composable parts, like `ui/select`: assemble Root/Trigger/Popup/Item, or
 * reach for `SearchSelect` for the flat `{ value, label }` case.
 *
 * Pass `items` to `Root`. Filtering runs over that list, and the trigger's
 * value text resolves from it (an item shaped `{ value, label }` shows its
 * label without any further wiring).
 */

type Size = "sm" | "md" | "lg";

export interface ComboboxOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

const ComboboxFocusContext =
  React.createContext<React.RefObject<boolean> | null>(null);

function Root<Value, Multiple extends boolean | undefined = false>({
  onOpenChange,
  onOpenChangeComplete,
  children,
  ...props
}: BaseCombobox.Root.Props<Value, Multiple>) {
  // The same dismissal rule as `ui/select`: a pointer press outside the
  // popup should not hand focus back to the trigger, or the field lights up
  // as though it had just been tabbed to.
  const restoreFocusRef = React.useRef(true);
  const dismissedElementRef = React.useRef<HTMLElement | null>(null);
  return (
    <ComboboxFocusContext.Provider value={restoreFocusRef}>
      <BaseCombobox.Root
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
      </BaseCombobox.Root>
    </ComboboxFocusContext.Provider>
  );
}

type TriggerProps = Omit<
  React.ComponentProps<typeof BaseCombobox.Trigger>,
  "className"
> & {
  className?: string;
  size?: Size;
  /** Shown when nothing is selected. */
  placeholder?: React.ReactNode;
};

function Trigger({
  className,
  size = "md",
  placeholder,
  children,
  ...props
}: TriggerProps) {
  return (
    <BaseCombobox.Trigger
      {...props}
      className={selectTriggerClasses(size, false, className)}
    >
      <span {...stylex.props(field.triggerLabel)}>
        {children ?? <BaseCombobox.Value placeholder={placeholder} />}
      </span>
      <IconChevronDown size={16} {...stylex.props(field.triggerChevron)} />
    </BaseCombobox.Trigger>
  );
}

function Popup({
  className,
  side,
  align = "start",
  sideOffset = 6,
  searchPlaceholder = "Search",
  searchLabel = "Search",
  emptyText = "No matches",
  children,
}: {
  className?: string;
  side?: React.ComponentProps<typeof BaseCombobox.Positioner>["side"];
  align?: React.ComponentProps<typeof BaseCombobox.Positioner>["align"];
  sideOffset?: number;
  searchPlaceholder?: string;
  /** The search field's accessible name, when the placeholder is not one. */
  searchLabel?: string;
  /** What the list says when nothing matches the search. */
  emptyText?: React.ReactNode;
  /** Rows, or a function rendering one row per item that survives the
   *  filter. */
  children: React.ComponentProps<typeof BaseCombobox.List>["children"];
}) {
  const restoreFocusRef = React.useContext(ComboboxFocusContext);
  return (
    <BaseCombobox.Portal>
      <BaseCombobox.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...stylex.props(popup.positioner)}
      >
        <BaseCombobox.Popup
          finalFocus={() => restoreFocusRef?.current ?? true}
          // Wider than the trigger it opens from: a search field needs room
          // for a query, and the rows it narrows to are longer than the
          // truncated value the trigger shows.
          {...sx(
            [popup.surface, popup.searchSurface],
            cn(POPUP_HOOK, className),
          )}
        >
          {/* A row, not a field: the popup surface is the well here, so the
					    search sits on it with a divider rather than in a second box. */}
          <div {...stylex.props(popup.searchRow)}>
            <IconSearch size={16} {...stylex.props(popup.searchIcon)} />
            <BaseCombobox.Input
              aria-label={searchLabel}
              placeholder={searchPlaceholder}
              {...stylex.props(popup.searchInput)}
            />
          </div>
          <BaseCombobox.Empty {...stylex.props(popup.empty)}>
            {emptyText}
          </BaseCombobox.Empty>
          <BaseCombobox.List {...stylex.props(popup.scroll)}>
            {children}
          </BaseCombobox.List>
        </BaseCombobox.Popup>
      </BaseCombobox.Positioner>
    </BaseCombobox.Portal>
  );
}

type ItemProps = Omit<
  React.ComponentProps<typeof BaseCombobox.Item>,
  "className"
> & {
  className?: string;
};

function Item({ className, children, ...props }: ItemProps) {
  return (
    <BaseCombobox.Item
      {...props}
      {...sx([popup.item, popup.selectItem, popup.touchRow], className)}
    >
      <span {...stylex.props(popup.truncate)}>{children}</span>
      {/* The tick's column is reserved on every row, as in `ui/select`, so
			    the picked row is not wider than the rest. */}
      <span {...stylex.props(popup.tickSlot)}>
        <BaseCombobox.ItemIndicator>
          <IconCheck size={17} />
        </BaseCombobox.ItemIndicator>
      </span>
    </BaseCombobox.Item>
  );
}

export const Combobox = {
  Root,
  Trigger,
  Value: BaseCombobox.Value,
  Popup,
  Item,
};

/**
 * The flat case: a list of `{ value, label }`, the one that is picked, and a
 * search over the labels. The searchable twin of `ui/select`'s `OptionSelect`.
 */
export function SearchSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled,
  className,
  size,
  align = "end",
}: {
  value: T;
  options: ComboboxOption<T>[];
  onChange: (value: T) => void;
  /** The trigger's accessible name. */
  label: string;
  /** Shown on the trigger when nothing is selected. */
  placeholder?: React.ReactNode;
  searchPlaceholder?: string;
  emptyText?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  size?: Size;
  align?: React.ComponentProps<typeof Popup>["align"];
}) {
  const selected = options.find((option) => option.value === value) ?? null;
  return (
    <Combobox.Root
      items={options}
      value={selected}
      disabled={disabled}
      isItemEqualToValue={(item, current) => item.value === current.value}
      onValueChange={(next) => {
        if (next) onChange(next.value);
      }}
    >
      <Combobox.Trigger
        aria-label={label}
        className={className}
        size={size}
        placeholder={placeholder}
      />
      <Combobox.Popup
        align={align}
        searchPlaceholder={searchPlaceholder}
        searchLabel={searchPlaceholder}
        emptyText={emptyText}
      >
        {(option: ComboboxOption<T>) => (
          <Combobox.Item
            key={option.value}
            value={option}
            disabled={option.disabled}
          >
            {option.label}
          </Combobox.Item>
        )}
      </Combobox.Popup>
    </Combobox.Root>
  );
}
