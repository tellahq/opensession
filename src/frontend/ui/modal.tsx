import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { cn } from "./cn";
import { IconX } from "../components/icons";

/**
 * Centered modal dialog on Base UI parts, styled with Tailwind tokens. The
 * shared standard for confirm/edit dialogs — mirrors tella-fusion's UI__Dialog2
 * (soft squircle shell, icon + title/description header, top-right close, a
 * body, and a right-aligned footer of actions).
 *
 * Like ui/menu.tsx (and unlike ui/tooltip.tsx) this animates with CSS
 * transitions on Base UI's [data-starting-style]/[data-ending-style] lifecycle
 * attributes — never a Motion render prop, which drops the injected role/data-*
 * a focus-managed dialog needs. Enter AND exit both animate; keyboard nav +
 * focus trapping stay intact.
 *
 * Composable: assemble <Modal.Root>/<Modal.Content> yourself, or reach for the
 * <Modal.Header>/<Modal.Footer> helpers for the common shape.
 *
 *   <Modal.Root open={open} onOpenChange={setOpen}>
 *     <Modal.Content>
 *       <Modal.Header icon={<IconCrosshair />} title="Session goal"
 *         description="Rides along with every prompt." />
 *       <textarea … />
 *       <Modal.Footer>
 *         <Modal.Close render={<button className="…">Cancel</button>} />
 *         <button className="…">Set goal</button>
 *       </Modal.Footer>
 *     </Modal.Content>
 *   </Modal.Root>
 *
 * The command palettes (⌘K search, ⌘N new session) use `variant="palette"` —
 * the same mechanics in a top-anchored, wider, full-bleed shell whose own rows
 * carry the padding and dividers. Pair it with `useEnterOnMount()` when the
 * parent mounts the dialog conditionally.
 */

/** Geometry of the dialog shell.
 *  - `centered` — the standard confirm/edit dialog: vertically centered, ~28rem,
 *    padded body, `gap-4` between header/body/footer.
 *  - `palette` — the command-palette shape: anchored near the top of the
 *    viewport (via Base UI's Viewport), wider, and full-bleed. No padding and no
 *    gap, because a palette's rows (search field, scrolling results, hint
 *    footer) run edge to edge and own their own spacing and dividers. */
export type ModalVariant = "centered" | "palette";

export type ModalContentProps = Omit<
	React.ComponentPropsWithoutRef<"div">,
	"children"
> & {
	children: React.ReactNode;
	/** Width (a Tailwind width utility). Defaults to ~28rem for `centered` and
	 *  min(820px, 100%) for `palette` — override with e.g. "max-w-[34rem]". */
	widthClassName?: string;
	/** Element to focus when the dialog opens (Base UI otherwise focuses the
	 *  first tabbable). Pass the ref of the field you want the caret in. */
	initialFocus?: React.RefObject<HTMLElement | null>;
	variant?: ModalVariant;
};

/** Portal + backdrop + popup. Children are the dialog body; pair with
 *  Modal.Header / Modal.Footer for the standard shape. Remaining props land on
 *  the popup, so a title-less dialog can name itself with `aria-label` and a
 *  palette can own its own `onKeyDown`.
 *  (Backdrop-dismiss is on by default; pass `disablePointerDismissal` to
 *  Modal.Root for confirmations that demand an explicit choice.) */
function Content({
	className,
	children,
	widthClassName,
	initialFocus,
	variant = "centered",
	...popupProps
}: ModalContentProps) {
	const palette = variant === "palette";
	const popup = (
		<BaseDialog.Popup
			// Centered via a single composed transform so the enter/exit
			// scale (Tailwind writes translate + scale into one transform) keeps
			// the dialog pinned to the middle while it pops. The palette variant
			// is laid out by the Viewport instead, so it only owns its own size.
			className={cn(
				palette
					? [
							// `relative` anchors overlays a palette draws inside itself
							// (the dictation HUD); `overflow-hidden` keeps the rows'
							// dividers inside the rounded shell.
							"relative flex flex-col overflow-hidden outline-none",
							"rounded-[calc(20px*var(--rf))] border border-line-strong bg-panel",
							"shadow-[0_24px_70px_rgba(0,0,0,0.45)]",
							// Drops in from just above its resting place, the way a
							// palette summoned by a keystroke should.
							"origin-top transition-[transform,opacity] duration-[130ms] ease-out",
							"data-[starting-style]:-translate-y-1.5 data-[starting-style]:scale-[0.99] data-[starting-style]:opacity-0",
							"data-[ending-style]:-translate-y-1.5 data-[ending-style]:scale-[0.99] data-[ending-style]:opacity-0",
							widthClassName ?? "w-[min(820px,100%)]",
						]
					: [
							"fixed left-1/2 top-1/2 z-[10001] w-[90vw] -translate-x-1/2 -translate-y-1/2",
							widthClassName ?? "max-w-[28rem]",
							"max-h-[85dvh] overflow-y-auto overscroll-contain outline-none",
							// Match Tella's restrained Dialog2 shell: lifted surface, soft edge,
							// and enough radius to read as a modal without becoming a card.
							"rounded-2xl border border-line bg-raised",
							"p-6 shadow-[0_18px_50px_rgba(0,0,0,0.20),0_2px_8px_rgba(0,0,0,0.08)]",
							"flex flex-col gap-4",
							"origin-center transition-[transform,opacity] duration-150 ease-out",
							"data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0",
							"data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0",
						],
				className,
			)}
			initialFocus={initialFocus}
			{...popupProps}
		>
			{children}
		</BaseDialog.Popup>
	);
	return (
		<BaseDialog.Portal>
			<BaseDialog.Backdrop
				className={cn(
					"fixed inset-0 transition-opacity ease-out",
					"data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
					// Palettes sit on their own, lower tier so anything that has
					// always floated above them (the caret-anchored mention popup at
					// 10500, the modal tier at 10000) keeps doing so.
					palette
						? "z-[6000] bg-black/42 backdrop-blur-[3px] duration-[120ms]"
						: "z-[10000] bg-black/25 backdrop-blur-[1px] duration-150",
					// `palette-backdrop` rides along purely as a runtime marker:
					// SessionViewer (⌘P) and Sidebar (archive chord) suppress their
					// window-level shortcuts via
					// `document.querySelector(".palette-backdrop, …)`, and a palette
					// must keep matching it. The legacy rule's own declarations are
					// the same z-index/tint/blur written above, and its flex+padding
					// are inert on a childless backdrop, so it changes nothing
					// visually. Removable once those two guards move to
					// `[role=dialog]`, which App already uses for its bare-"n" check.
					palette && "palette-backdrop",
				)}
			/>
			{palette ? (
				<BaseDialog.Viewport className="fixed inset-0 z-[6001] flex items-start justify-center px-4 pb-4 pt-[11vh] max-[560px]:pt-[7vh]">
					{popup}
				</BaseDialog.Viewport>
			) : (
				popup
			)}
		</BaseDialog.Portal>
	);
}

/** `open` state for a dialog whose PARENT mounts it only while it should be
 *  open (`{searchOpen && <SessionSearch/>}`). Base UI skips
 *  [data-starting-style] for a popup that mounts already-open, so the enter
 *  animation needs one frame at `open={false}` first.
 *
 *  Exit animation still can't run under conditional mounting — the parent
 *  unmounts the tree the moment it closes — but the popup carries the
 *  [data-ending-style] classes anyway, so it animates out for free if the
 *  parent ever keeps it mounted. */
export function useEnterOnMount(): boolean {
	const [open, setOpen] = React.useState(false);
	React.useEffect(() => setOpen(true), []);
	return open;
}

/** Icon badge + title + one-line description on the left, a close (✕) on the
 *  right — the standard dialog header. */
function Header({
	icon,
	title,
	description,
	className,
}: {
	icon?: React.ReactNode;
	title: React.ReactNode;
	description?: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex items-start gap-3", className)}>
			{icon && (
				<span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
					{icon}
				</span>
			)}
			<div className="min-w-0 flex-1">
				{/* Base UI renders Title as <h2> and Description as <p>; preflight
				    isn't imported (the foundation owns resets), so zero their UA margins
				    or the <h2> top margin reads as phantom padding above the head. */}
				<BaseDialog.Title className="m-0 text-balance text-section-title font-semibold leading-tight tracking-[-0.01em] text-fg">
					{title}
				</BaseDialog.Title>
				{description && (
					<BaseDialog.Description className="m-0 mt-2 text-pretty text-base font-medium leading-normal text-dim">
						{description}
					</BaseDialog.Description>
				)}
			</div>
			<BaseDialog.Close
				aria-label="Close"
				className="relative -mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md p-0 text-faint outline-none transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]"
			>
				<IconX size={20} />
			</BaseDialog.Close>
		</div>
	);
}

/** Right-aligned action row (Cancel / confirm). Pass a leading element (e.g. a
 *  destructive "Clear") and it sits left of the spacer. */
function Footer({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("flex flex-wrap items-center gap-2.5", className)}>
			{children}
		</div>
	);
}

export const Modal = {
	Root: BaseDialog.Root,
	Trigger: BaseDialog.Trigger,
	Close: BaseDialog.Close,
	Title: BaseDialog.Title,
	Description: BaseDialog.Description,
	Viewport: BaseDialog.Viewport,
	Content,
	Header,
	Footer,
};
