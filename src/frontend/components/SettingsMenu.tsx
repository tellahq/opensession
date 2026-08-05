import React, { useState } from "react";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { BottomSheet } from "../ui/sheet";
import { useIsPhone } from "../hooks/useIsPhone";
import {
	IconCheck,
	IconChevronRight,
	IconGear,
	IconLogOut,
} from "./icons";
import { Tooltip } from "../ui/tooltip";
import { TEAM, setCurrentUser, signOut, useAuthStatus, useCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { PRODUCT_MARK, PRODUCT_NAME } from "../lib/brand";

// The account menu: the account switcher (who you're acting as), the live
// connection status, and an entry into the full Settings page (theme,
// notifications, …). On desktop it's a Base UI menu (ui/menu: outside-click/
// Escape dismissal, keyboard nav and submenu positioning come from the
// primitive); on phones the same content opens as an iOS-style bottom sheet
// instead, with the account switcher inlined as a tappable list rather than a
// hover submenu.
//
// Trigger shapes via `variant`:
//   "chevron" — a small chevron.
//   "brand"   — the mobile top bar logo.
//   "top"     — the whole Backstage brand (logo + wordmark) in the desktop
//               sidebar's top row, as one hover area that opens the account
//               menu. The logo carries the connection dot; the chevron only
//               shows on hover (or while the menu is open).
//   "user"    — avatar + name in the same top-row slot, for the desktop shell
//               (html.wco), where the app shouldn't re-brand itself inside its
//               own titlebar. The avatar carries the connection dot.
//   "footer"  — a full-width user row (avatar · name · connection state) at the
//               bottom of the desktop sidebar, plus a sibling gear button that
//               goes straight to the Settings page (bypassing the menu).

function Avatar({ name, size = 22 }: { name: string; size?: number }) {
	return (
		<UserAvatar
			name={name}
			size={size}
			className="border-line shadow-[0_1px_2px_rgba(0,0,0,0.18)]"
		/>
	);
}

const triggerChevron = (
	<svg width="16" height="16" viewBox="0 0 10 10" aria-hidden="true">
		<path
			d="M2 3.5L5 6.5L8 3.5"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

/** The footer trigger's contents: avatar, name, live connection state.
 * Shared by the desktop menu trigger and the phone sheet trigger so the row
 * looks identical however it opens. The settings gear sits next to this row
 * as its own button (straight to Settings), not inside the trigger. */
function UserRow({
	name,
	connected,
}: {
	name: string;
	connected?: boolean;
}) {
	return (
		<>
			<UserAvatar name={name} size={30} className="shrink-0" />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left leading-tight">
				<span className="truncate text-control-label font-semibold text-fg">{name}</span>
				<span className="flex items-center gap-1.5 text-meta font-medium text-faint">
					<span
						className={cn(
							"h-1.5 w-1.5 shrink-0 rounded-full",
							connected ? "bg-green" : "bg-red",
						)}
					/>
					{connected ? "Connected" : "Reconnecting…"}
				</span>
			</span>
		</>
	);
}

/** Phone variant: the same trigger opens a bottom sheet with the account
 * switcher as an inline grouped list (no submenus on touch). */
function SettingsSheet({
	onOpenSettings,
	connected,
	variant = "chevron",
}: {
	onOpenSettings?: () => void;
	connected?: boolean;
	variant?: "chevron" | "brand" | "top" | "user" | "footer";
}) {
	const currentUser = useCurrentUser();
	const [open, setOpen] = useState(false);
	const auth = useAuthStatus();
	// GitHub sign-in active ⇒ identity is server-verified, no account switcher.
	const githubAuth = auth?.required && auth.authenticated ? auth : null;

	return (
		<>
			{variant === "footer" ? (
				<div className="flex w-full items-center">
					<button
						aria-label="Account menu"
						className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border-none bg-transparent px-2 py-1.5 text-left active:bg-hover"
						onClick={() => setOpen(true)}
					>
						<UserRow name={currentUser} connected={connected} />
					</button>
					<button
						aria-label="Open settings"
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-none bg-transparent p-0 text-faint active:bg-hover active:text-fg"
						onClick={() => onOpenSettings?.()}
					>
						<IconGear size={24} />
					</button>
				</div>
			) : variant === "brand" ? (
				<button
					aria-label="Account menu"
					className="app-logo-button inline-flex h-[42px] w-[42px] items-center justify-center rounded-control border-0 bg-transparent p-0 text-inherit active:bg-hover"
					onClick={() => setOpen(true)}
				>
					<img className="app-logo-image block h-8 w-8" src="/mac-app-icon.png" alt="" />
				</button>
			) : (
				<button
					aria-label="Account menu"
					className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-md border-none bg-transparent p-0 text-faint active:bg-hover active:text-fg"
					onClick={() => setOpen(true)}
				>
					{triggerChevron}
				</button>
			)}
			{open && (
				<BottomSheet label="Account menu" onClose={() => setOpen(false)}>
					{(dismiss) => (
						<div className="overflow-y-auto px-4 pb-4 pt-1">
							{githubAuth ? (
								// GitHub-verified identity: nothing to switch — the server
								// decides who you are. Show it + a way out.
								<div className="overflow-hidden rounded-xl border border-line bg-panel">
									<div className="flex w-full items-center gap-3 border-x-0 border-b border-t-0 border-solid border-line px-3.5 py-3">
										<Avatar name={currentUser} />
										<span className="flex min-w-0 flex-1 flex-col leading-tight">
											<span className="text-item-title font-medium text-fg">
												{currentUser}
											</span>
											{githubAuth.login && (
												<span className="text-label text-faint">
													Signed in with GitHub · @{githubAuth.login}
												</span>
											)}
										</span>
									</div>
									{!githubAuth.local && (
										<button
											className="flex w-full items-center gap-3 border-none bg-transparent px-3.5 py-3 text-left text-item-title font-medium text-dim active:bg-hover"
											onClick={() => void signOut()}
										>
											Sign out
										</button>
									)}
								</div>
							) : (
								<>
									<div className="mb-2 px-1 text-control-label font-semibold text-faint">
										Acting as
									</div>
									<div className="overflow-hidden rounded-xl border border-line bg-panel">
										{TEAM.map((name) => (
											<button
												key={name}
												className="flex w-full items-center gap-3 border-x-0 border-b border-t-0 border-solid border-line bg-transparent px-3.5 py-3 text-left last:border-b-0 active:bg-hover"
												onClick={() => {
													setCurrentUser(name);
													dismiss();
												}}
											>
												<Avatar name={name} />
												<span className="min-w-0 flex-1 text-item-title font-medium text-fg">
													{name}
												</span>
												{name === currentUser && (
													<IconCheck size={22} className="shrink-0 text-accent" />
												)}
											</button>
										))}
									</div>
								</>
							)}

							<div className="mt-4 overflow-hidden rounded-xl border border-line bg-panel">
								<button
									className="flex w-full items-center gap-3 border-none bg-transparent px-3.5 py-3 text-left active:bg-hover"
									onClick={() => {
										dismiss();
										onOpenSettings?.();
									}}
								>
									<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-active text-dim">
										<IconGear size={22} />
									</span>
									<span className="min-w-0 flex-1 text-item-title font-medium text-fg">
										Settings
									</span>
									<IconChevronRight size={20} className="shrink-0 text-faint" />
								</button>
							</div>

							<div className="mt-4 flex items-center gap-2 px-2 text-control-label font-medium text-dim">
								<span
									className={cn(
										"h-2 w-2 rounded-full",
										connected ? "bg-green" : "bg-red",
									)}
								/>
								{connected ? "Connected" : "Reconnecting…"}
							</div>
						</div>
					)}
				</BottomSheet>
			)}
		</>
	);
}

export function SettingsMenu({
	onOpenSettings,
	connected,
	variant = "chevron",
}: {
	onOpenSettings?: () => void;
	connected?: boolean;
	variant?: "chevron" | "brand" | "top" | "user" | "footer";
}) {
	const currentUser = useCurrentUser();
	const isPhone = useIsPhone();
	const auth = useAuthStatus();
	// GitHub sign-in active ⇒ identity is server-verified, no account switcher.
	const githubAuth = auth?.required && auth.authenticated ? auth : null;

	if (isPhone)
		return (
			<SettingsSheet
				onOpenSettings={onOpenSettings}
				connected={connected}
				variant={variant}
			/>
		);

	const footer = variant === "footer";
	const top = variant === "top";
	const user = variant === "user";

	return (
		<Menu.Root>
			{footer ? (
				<div className="flex w-full items-center">
					<Menu.Trigger
						aria-label="Account menu"
						className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border-none bg-transparent px-2 py-1.5 text-left text-fg hover:bg-hover data-[popup-open]:bg-hover"
					>
						<UserRow name={currentUser} connected={connected} />
					</Menu.Trigger>
					<Tooltip label="Settings">
						<button
							aria-label="Open settings"
							className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-none bg-transparent p-0 text-faint hover:bg-hover hover:text-fg"
							onClick={() => onOpenSettings?.()}
						>
							<IconGear size={24} />
						</button>
					</Tooltip>
				</div>
			) : user ? (
				/* Avatar-only trigger for the desktop shell's chrome row — the name
				   stays in the menu itself. The avatar carries the connection dot,
				   which is the only place this variant reports the live connection
				   (the menu suppresses its status row for triggers that show it). */
				<Menu.Trigger
					aria-label="Account menu"
					className="flex shrink-0 items-center rounded-md border-none bg-transparent p-1 text-fg hover:bg-hover data-[popup-open]:bg-hover"
				>
					<span className="relative inline-flex shrink-0">
						<UserAvatar name={currentUser} size={24} />
						<span
							className="app-logo-status"
							style={{ background: connected ? "var(--green)" : "var(--red)" }}
							title={connected ? "Connected" : "Reconnecting…"}
						/>
					</span>
				</Menu.Trigger>
			) : top ? (
				<Menu.Trigger
					aria-label="Account menu"
					className="group flex items-center gap-[9px] rounded-md border-none bg-transparent py-1 pl-1.5 pr-1.5 text-fg hover:bg-hover data-[popup-open]:bg-hover"
				>
					<span className="relative inline-flex shrink-0">
						<span className="app-logo app-logo--sm">{PRODUCT_MARK}</span>
						{/* Live connection dot on the logo corner (ring matches sidebar bg). */}
						<span
							className="app-logo-status"
							style={{ background: connected ? "var(--green)" : "var(--red)" }}
							title={connected ? "Connected" : "Reconnecting…"}
						/>
					</span>
					<span className="text-item-title font-semibold leading-none tracking-[-0.01em]">
						{PRODUCT_NAME}
					</span>
					{/* A smaller chevron, hugged to the wordmark and vertically centered.
					    Only shows on hover or while the menu is open. */}
					<span className="relative top-px -ml-1 inline-flex items-center text-faint opacity-0 transition-opacity group-hover:opacity-100 group-data-[popup-open]:opacity-100">
						<svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true">
							<path
								d="M2 3.5L5 6.5L8 3.5"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</span>
				</Menu.Trigger>
			) : (
				<Menu.Trigger
					aria-label="Settings"
					className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border-none bg-transparent p-0 text-faint hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg"
				>
					{triggerChevron}
				</Menu.Trigger>
			)}

			{/* Footer trigger sits at the very bottom of the sidebar — open the menu
			    upward so it doesn't run off-screen. */}
			<Menu.Popup
				side={footer ? "top" : undefined}
				align="start"
				sideOffset={8}
				className="min-w-[252px]"
			>
				{githubAuth ? (
					// GitHub-verified identity: nothing to switch — show who the
					// server says you are.
					<div className="flex items-center gap-3 rounded-lg px-2.5 py-2">
						<Avatar name={currentUser} size={30} />
						<span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
							<span className="text-meta font-medium text-faint">
								Signed in with GitHub
							</span>
							<span className="truncate text-body font-semibold text-fg">
								{currentUser}
								{githubAuth.login && (
									<span className="ml-1.5 font-normal text-dim">
										@{githubAuth.login}
									</span>
								)}
							</span>
						</span>
					</div>
				) : (
					<Menu.SubmenuRoot>
						<Menu.SubmenuTrigger className="gap-[9px] rounded-[calc(5px*var(--rf))] px-2 py-1.5">
							<Avatar name={currentUser} />
							<span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
								<span className="text-meta font-bold tracking-[-0.01em] text-faint">
									Acting as
								</span>
								<span className="font-medium">{currentUser}</span>
							</span>
							<svg
								className="shrink-0 text-faint"
								width="14"
								height="14"
								viewBox="0 0 10 10"
								aria-hidden="true"
							>
								<path
									d="M3.5 2L6.5 5L3.5 8"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</Menu.SubmenuTrigger>
						<Menu.Popup className="min-w-[200px]">
							<Menu.RadioGroup
								value={currentUser}
								onValueChange={(value) => setCurrentUser(String(value))}
							>
								{TEAM.map((name) => (
									<Menu.RadioItem
										key={name}
										value={name}
										closeOnClick
										className="gap-[9px] rounded-[calc(5px*var(--rf))] px-2 py-1.5"
									>
										<Avatar name={name} />
										<span className="min-w-0 flex-1 font-medium">{name}</span>
										{name === currentUser && (
											<svg
												className="shrink-0 text-accent"
												width="17"
												height="17"
												viewBox="0 0 16 16"
												fill="none"
											>
												<path
													d="M3.5 8.5l3 3 6-7"
													stroke="currentColor"
													strokeWidth="1.6"
													strokeLinecap="round"
													strokeLinejoin="round"
												/>
											</svg>
										)}
									</Menu.RadioItem>
								))}
							</Menu.RadioGroup>
						</Menu.Popup>
					</Menu.SubmenuRoot>
				)}

				<Menu.Separator />

				{/* Triggers with a status dot or status label do not repeat the
				    connection state inside the menu. */}
				{!footer && !top && !user && (
					<>
						<div className="flex items-center gap-2 px-2 py-0.5 text-label text-dim">
							<span
								className={cn(
									"h-2 w-2 rounded-full",
									connected ? "bg-green" : "bg-red",
								)}
							/>
							{connected ? "Connected" : "Reconnecting…"}
						</div>

						<Menu.Separator />
					</>
				)}

				<Menu.Item
					onClick={() => onOpenSettings?.()}
					className="gap-2.5 rounded-lg px-2.5 py-2 text-control-label"
				>
					<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-active text-dim">
						<IconGear size={20} />
					</span>
					<span className="font-medium">Settings</span>
				</Menu.Item>
				{githubAuth && !githubAuth.local && (
					<Menu.Item
						onClick={() => void signOut()}
						className="gap-2.5 rounded-lg px-2.5 py-2 text-control-label text-dim data-[highlighted]:text-fg"
					>
						<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-active text-faint">
							<IconLogOut size={20} />
						</span>
						<span className="font-medium">Sign out</span>
					</Menu.Item>
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
