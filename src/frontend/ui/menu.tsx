import * as React from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { cn } from "./cn";

/**
 * Menu on Base UI parts, styled with Tailwind tokens. Composable shape —
 * consumers assemble Root/Trigger/Popup/Item rather than passing item configs.
 *
 * Unlike ui/tooltip.tsx this does NOT animate via a Motion render prop: the
 * render merge drops Base UI's injected attributes (role, data-*), which a
 * focus-managed popup can't afford. Menus animate with CSS transitions on
 * Base UI's [data-starting-style]/[data-ending-style] lifecycle attributes —
 * enter AND exit work, keyboard nav and a11y stay intact.
 */

function Trigger({
	className,
	...props
}: Omit<React.ComponentProps<typeof BaseMenu.Trigger>, "className"> & {
	className?: string;
}) {
	return <BaseMenu.Trigger {...props} className={cn("focus-ring", className)} />;
}

// Shared popup chrome for both the click-menu and the right-click context menu:
// overflow-hidden keeps the inner scrollbar's ends clipped to the rounded corner
// instead of poking past it; the transition rides Base UI's lifecycle attrs.
const popupClasses =
	"min-w-[180px] overflow-hidden rounded-popup [corner-shape:squircle] border border-line-strong bg-panel shadow-[0_10px_30px_rgba(0,0,0,0.32)] outline-none origin-[var(--transform-origin)] transition-[transform,opacity] duration-[120ms] ease-out data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0";

const popupInnerClasses =
	"max-h-[min(60vh,420px,var(--available-height))] overflow-y-auto overflow-x-hidden overscroll-contain p-2";

function Popup({
	className,
	contentClassName,
	side,
	align,
	sideOffset = 8,
	children,
}: {
	className?: string;
	contentClassName?: string;
	side?: React.ComponentProps<typeof BaseMenu.Positioner>["side"];
	align?: React.ComponentProps<typeof BaseMenu.Positioner>["align"];
	sideOffset?: number;
	children: React.ReactNode;
}) {
	return (
		<BaseMenu.Portal>
			<BaseMenu.Positioner
				side={side}
				align={align}
				sideOffset={sideOffset}
				collisionPadding={8}
				className="z-[10001] outline-none"
			>
				<BaseMenu.Popup className={cn("app-menu-popup", popupClasses, className)}>
					<div className={cn(popupInnerClasses, contentClassName)}>{children}</div>
				</BaseMenu.Popup>
			</BaseMenu.Positioner>
		</BaseMenu.Portal>
	);
}

/** Right-click context-menu popup. Anchors to the cursor (Base UI positions it
 * from the contextmenu event), reusing the same chrome + Item styling as Menu. */
function ContextPopup({
	className,
	contentClassName,
	finalFocus,
	children,
}: {
	className?: string;
	contentClassName?: string;
	/** Where focus goes on close — pass `false` when the menu opens an inline
	 * editor that autofocuses itself (default restores focus to the trigger). */
	finalFocus?: React.ComponentProps<typeof BaseContextMenu.Popup>["finalFocus"];
	children: React.ReactNode;
}) {
	return (
		<BaseContextMenu.Portal>
			<BaseContextMenu.Positioner
				collisionPadding={8}
				className="z-[10001] outline-none"
			>
				<BaseContextMenu.Popup
					className={cn(popupClasses, className)}
					finalFocus={finalFocus}
				>
					<div className={cn(popupInnerClasses, contentClassName)}>{children}</div>
				</BaseContextMenu.Popup>
			</BaseContextMenu.Positioner>
		</BaseContextMenu.Portal>
	);
}

/** Shared row styling for anything that behaves like a menu item. Highlight
 * via Base UI's data-highlighted so keyboard navigation lights rows up too. */
const itemClasses =
	"flex w-full cursor-pointer select-none items-center gap-2 rounded-[calc(8px*var(--rf))] px-2 py-1.5 text-left text-control-label text-fg outline-none data-[highlighted]:bg-hover";

function Item({
	className,
	...props
}: Omit<React.ComponentProps<typeof BaseMenu.Item>, "className"> & {
	className?: string;
}) {
	return <BaseMenu.Item {...props} className={cn(itemClasses, className)} />;
}

function SubmenuTrigger({
	className,
	...props
}: Omit<React.ComponentProps<typeof BaseMenu.SubmenuTrigger>, "className"> & {
	className?: string;
}) {
	return (
		<BaseMenu.SubmenuTrigger
			{...props}
			className={cn(itemClasses, "data-[popup-open]:bg-hover", className)}
		/>
	);
}

function RadioItem({
	className,
	...props
}: Omit<React.ComponentProps<typeof BaseMenu.RadioItem>, "className"> & {
	className?: string;
}) {
	return (
		<BaseMenu.RadioItem {...props} className={cn(itemClasses, className)} />
	);
}

function CheckboxItem({
	className,
	...props
}: Omit<React.ComponentProps<typeof BaseMenu.CheckboxItem>, "className"> & {
	className?: string;
}) {
	return (
		<BaseMenu.CheckboxItem {...props} className={cn(itemClasses, className)} />
	);
}

function Separator({ className }: { className?: string }) {
	return <BaseMenu.Separator className={cn("my-1.5 h-px bg-line", className)} />;
}

function GroupLabel({ className, ...props }: { className?: string; children?: React.ReactNode }) {
	return (
		<BaseMenu.GroupLabel
			{...props}
			className={cn(
				"px-2 pb-1 text-meta font-semibold tracking-[-0.01em] text-faint",
				className,
			)}
		/>
	);
}

/** Right-click context menu. Trigger wraps the target (render it as the anchor);
 * left-click passes through, contextmenu opens the popup at the cursor. Reuses
 * Menu's Item/Separator — Base UI's ContextMenu.Item is the same MenuItem. */
export const ContextMenu = {
	Root: BaseContextMenu.Root,
	Trigger: BaseContextMenu.Trigger,
	Popup: ContextPopup,
	Item,
	Separator,
};

export const Menu = {
	Root: BaseMenu.Root,
	Trigger,
	Popup,
	Item,
	Separator,
	Group: BaseMenu.Group,
	GroupLabel,
	SubmenuRoot: BaseMenu.SubmenuRoot,
	SubmenuTrigger,
	RadioGroup: BaseMenu.RadioGroup,
	RadioItem,
	RadioItemIndicator: BaseMenu.RadioItemIndicator,
	CheckboxItem,
};
