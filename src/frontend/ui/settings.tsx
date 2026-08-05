import * as React from "react";
import { Card, CardList } from "./card";
import { cn } from "./cn";

export function SettingsPanel({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("w-full max-w-[720px]", className)} {...props} />;
}

/**
 * A settings page's header: its title, an optional sentence of context, and
 * optional actions on the right. Every panel opens with one, so pages share a
 * top rhythm no matter who wrote them. The h1 hides inside the phone sheet,
 * which already names the section in its own nav bar.
 */
export function SettingsHeader({
	title,
	description,
	actions,
	className,
	...props
}: Omit<React.ComponentPropsWithoutRef<"header">, "title"> & {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
}) {
	return (
		<header
			className={cn("mb-5 flex items-start justify-between gap-4 px-4", className)}
			{...props}
		>
			<div className="min-w-0">
				<h1 className="m-0 text-page-title font-bold tracking-[-0.02em] text-fg [.settings-sheet_&]:hidden">
					{title}
				</h1>
				{description && (
					<p className="m-0 mt-1.5 text-supporting leading-relaxed text-dim [.settings-sheet_&]:mt-0">
						{description}
					</p>
				)}
			</div>
			{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
		</header>
	);
}

/**
 * The label above a group of settings, with optional actions on its right —
 * the group's own "add"/"refresh" buttons. Pages kept re-deriving that row
 * (a flex override here, a local `SectionHeader` there), which is how the
 * groups drifted apart; the slot keeps one shape.
 */
export function SettingsGroupLabel({
	actions,
	className,
	children,
	...props
}: React.ComponentPropsWithoutRef<"div"> & { actions?: React.ReactNode }) {
	return (
		<div
			className={cn(
				// mt-9: a group's card and the hint under it read as one block, so
				// the space above the next label is what separates the groups.
				"mb-2 mt-9 flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-4 text-label font-semibold text-faint",
				className,
			)}
			{...props}
		>
			<span className="min-w-0">{children}</span>
			{actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
		</div>
	);
}

/** The surface every settings group sits on: a soft fill, no border. The fill
 * alone separates a group from the page, so a page of settings reads as a few
 * quiet blocks rather than a stack of outlined boxes.
 *
 * The corner is authored in the chrome's own language — `calc(Npx * var(--rf))`,
 * which the foundation bumps under `corner-shape: squircle` — rather than the flat
 * `rounded-lg` Card ships. A squircle at a flat radius reads visibly squarer
 * than the panels around it; 12px × --rf lands these blocks on the same softness
 * as the rest of the app's large surfaces. */
const settingsSurface = "rounded-[calc(12px*var(--rf))] border-0 bg-raised";

export function SettingCard({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <CardList className={cn(settingsSurface, className)} {...props} />;
}

/** A section for content that isn't a list of rows — an editor, a picker, a
 * filter bar. Same surface SettingCard gives rows, so a page of prose sits in
 * the page's rhythm instead of floating on it. */
export function SettingsSection({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <Card className={cn(settingsSurface, "p-4", className)} {...props} />;
}

/**
 * One setting: its label and description on the left, its control on the
 * right. On a narrow screen the control drops to its own line instead of
 * squeezing the label into a two-word column — `flex-wrap` plus the text's
 * min width is what decides that, and the control's `ml-auto` keeps it
 * right-aligned once it lands there.
 *
 * Rows are centered, which is right while the text is a title and one line of
 * description. A row that grows past that (an account with usage bars) should
 * pass `items-start`: an avatar and a control floating in the middle of a tall
 * row read as unanchored, and top-aligning ties them to the title they belong
 * to.
 */
export function SettingRow({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div
			className={cn("flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3.5", className)}
			{...props}
		/>
	);
}

export function SettingRowText({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("min-w-0 flex-1 max-sm:min-w-[55%]", className)} {...props} />;
}

export function SettingRowTitle({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("text-item-title font-medium text-fg", className)} {...props} />;
}

export function SettingRowDescription({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("mt-0.5 text-supporting text-dim", className)} {...props} />;
}

export function SettingRowControl({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("ml-auto shrink-0", className)} {...props} />;
}

/** The ⋯ trigger for a row's overflow menu — quiet until hovered or open.
 *  Shared so a row's actions look the same on every settings page. */
export const rowMenuTriggerClasses =
	"flex size-7 shrink-0 items-center justify-center rounded-md text-faint transition-[color,background] hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg";

export function SettingsHint({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("mt-2 px-4 text-meta text-faint", className)} {...props} />;
}

/**
 * One recipe behind every field in settings — select, input, textarea. They
 * had drifted into three (two radii, two fills, two focus colors), so a form
 * looked assembled from parts. The fill is the page's own surface so a field
 * reads as a well cut into the group it sits in.
 */
const settingsFieldClass =
	"rounded-md border border-line bg-surface text-fg outline-none placeholder:text-faint focus:border-accent disabled:cursor-default disabled:opacity-40";

export const settingsSelectClass = cn(
	settingsFieldClass,
	"cursor-pointer px-2.5 py-1.5 text-control-label",
);

export function SettingsForm({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div
			className={cn(settingsSurface, "mb-3 flex flex-col gap-3.5 rounded-lg p-[18px]", className)}
			{...props}
		/>
	);
}

export function SettingsFormTitle({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("mb-4 text-item-title font-semibold text-fg", className)} {...props} />;
}

export function SettingsFormRow({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("grid grid-cols-2 gap-3 max-sm:grid-cols-1", className)} {...props} />;
}

export function SettingsField({
	className,
	...props
}: React.ComponentPropsWithoutRef<"label">) {
	return (
		<label
			className={cn("mb-3 flex min-w-0 flex-col gap-1.5 text-label font-medium text-dim", className)}
			{...props}
		/>
	);
}

export const settingsInputClass = cn(settingsFieldClass, "w-full px-2.5 py-2 text-body");

/** Multi-line text entry inside settings — memory entries, the personal
 *  prompt. One class so every editor in settings reads the same. */
export const settingsTextareaClass = cn(settingsInputClass, "resize-y");

export function SettingsFormActions({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("mt-1 flex justify-end gap-2", className)} {...props} />;
}
