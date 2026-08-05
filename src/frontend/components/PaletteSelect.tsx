import React from "react";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { IconCheck } from "./icons";

export type PaletteSelectOption = {
	value: string;
	label: string;
	menuLabel?: string;
	/** Optional leading icon shown before the label in the desktop menu. */
	icon?: React.ReactNode;
};

type Props = {
	value: string;
	options: PaletteSelectOption[];
	onChange: (value: string) => void;
	isPhone: boolean;
	className: string;
	children: React.ReactNode;
	ariaLabel: string;
	title?: string;
	disabled?: boolean;
	align?: "start" | "center" | "end";
};

export function PaletteSelect({
	value,
	options,
	onChange,
	isPhone,
	className,
	children,
	ariaLabel,
	title,
	disabled,
	align = "start",
}: Props) {
	if (isPhone) {
		return (
			<div className={cn("relative inline-flex min-w-0 items-center", className)} title={title}>
				{children}
				<select
					className="palette-select-overlay absolute inset-0 h-full w-full cursor-pointer appearance-none border-0 opacity-0 disabled:cursor-default"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					disabled={disabled}
					aria-label={ariaLabel}
				>
					{options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
		);
	}

	return (
		<Menu.Root>
			<Menu.Trigger
				type="button"
				className={className}
				title={title}
				disabled={disabled}
				aria-label={ariaLabel}
			>
				{children}
			</Menu.Trigger>
			<Menu.Popup align={align} sideOffset={6} className="max-w-[min(360px,calc(100vw-1rem))]">
				{options.map((option) => {
					const selected = option.value === value;
					return (
						<Menu.Item
							key={option.value}
							onClick={() => onChange(option.value)}
							className={cn("justify-between gap-3", selected && "bg-hover")}
						>
							<span className="flex min-w-0 items-center gap-2.5">
								{option.icon && (
									<span className="flex shrink-0 text-dim" aria-hidden="true">
										{option.icon}
									</span>
								)}
								<span className="min-w-0 truncate">
									{option.menuLabel ?? option.label}
								</span>
							</span>
							{selected && <IconCheck className="shrink-0 text-dim" size={17} />}
						</Menu.Item>
					);
				})}
			</Menu.Popup>
		</Menu.Root>
	);
}
