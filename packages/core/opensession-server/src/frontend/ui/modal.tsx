import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { cn } from "./cn";
import { IconX } from "../components/icons";

/**
 * Centered modal dialog on Base UI parts, styled with Tailwind tokens. The
 * shared standard for confirm/edit dialogs: a soft squircle shell, a
 * title/description header with a top-right close, a body, and a
 * right-aligned footer of actions.
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
 *       <Modal.Header title="Session goal"
 *         description="Rides along with every prompt." />
 *       <textarea … />
 *       <Modal.Footer>
 *         <Modal.Close render={<button className="…">Cancel</button>} />
 *         <button className="…">Set goal</button>
 *       </Modal.Footer>
 *     </Modal.Content>
 *   </Modal.Root>
 *
 * The command palettes use `variant="palette"`: the same mechanics in a
 * top-anchored, wider, full-bleed shell whose own rows
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
	/** Element to focus when the dialog closes. Pass `false` when closing the
	 *  dialog also replaces the surface that opened it. */
	finalFocus?: React.ComponentProps<typeof BaseDialog.Popup>["finalFocus"];
	/** Palette only: adjust the viewport that positions the popup. Useful for a
	 *  phone sheet that rests on the bottom edge instead of below the top bar. */
	viewportClassName?: string;
	/** Keep the dialog subtree mounted while closed. Use for live surfaces whose
	 *  sockets and local state must survive dismissal. */
	keepMounted?: boolean;
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
	viewportClassName,
	keepMounted = false,
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
				// Base UI's keepMounted popup receives `hidden` when closed. This
				// explicit rule outranks display utilities such as `flex`.
				"[&[hidden]]:hidden",
				palette
					? [
							// `relative` anchors overlays a palette draws inside itself
							// (the dictation HUD); `overflow-hidden` keeps the rows'
							// dividers inside the rounded shell.
							"relative flex flex-col overflow-hidden outline-none",
							// A 22px base rather than the scale's `rounded-xl`: an
							// overlay this size carries a rounder corner than the
							// controls inside it. Same corner as the centered dialog,
							// one step up from the 18px it used to carry.
							"rounded-modal",
							// The same glass the menus and hover cards are made of
							// (ui/menu.tsx), so the palette reads as one more floating
							// surface rather than an opaque card — just denser, because
							// this one sits over a dimming backdrop. --palette-glass
							// falls back to the opaque fill without backdrop-filter and
							// under prefers-reduced-transparency (base.css).
							"bg-palette-glass [backdrop-filter:var(--popup-blur)]",
							// --dialog-ring, not --popup-ring: a shell on a scrim needs a
							// firmer hairline than a menu over the page (base.css). In
							// light the two resolve to the same line.
							"[--smooth-ring-color:var(--dialog-ring)] smooth-shadow-ring-lg",
							// Drops in from just above its resting place, the way a
							// palette summoned by a keystroke should.
							"origin-top transition-[transform,opacity] duration-[var(--dur-micro)] ease-[var(--ease)]",
							"data-[starting-style]:-translate-y-1.5 data-[starting-style]:scale-[0.99] data-[starting-style]:opacity-0",
							"data-[ending-style]:-translate-y-1.5 data-[ending-style]:scale-[0.99] data-[ending-style]:opacity-0",
							widthClassName ?? "w-[min(820px,100%)]",
						]
					: [
							"fixed left-1/2 top-1/2 z-[10001] w-[90vw] -translate-x-1/2 -translate-y-1/2",
							widthClassName ?? "max-w-[28rem]",
							"max-h-[85dvh] overflow-y-auto overscroll-contain outline-none",
							// A restrained dialog shell: lifted surface, soft edge,
							// and enough radius to read as a modal without becoming a card.
							// The edge is --dialog-ring rather than the shared hairline: on
							// a scrim the fill's step above the page all but disappears, so
							// the line is what holds the shape (base.css).
							"rounded-modal bg-raised",
							"[--smooth-ring-color:var(--dialog-ring)] smooth-shadow-ring-lg",
							"p-6",
							"flex flex-col gap-4",
							"origin-center transition-[transform,opacity] duration-[var(--dur)] ease-[var(--ease)]",
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
		<BaseDialog.Portal keepMounted={keepMounted}>
			<BaseDialog.Backdrop
				className={cn(
					"fixed inset-0 transition-opacity ease-out",
					"data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
					// Palettes sit on their own, lower tier so anything that has
					// always floated above them (the caret-anchored mention popup at
					// 10500, the modal tier at 10000) keeps doing so.
					// A lighter tint than the opaque shell needed, over a heavier
					// blur: the palette is glass now, so the scrim composites
					// THROUGH it — at the old 42% the page's dimming showed up
					// inside the palette as a grey wash over its own fill.
					palette
						? "z-[6000] bg-black/22 backdrop-blur-[6px] duration-[var(--dur-micro)]"
						: "z-[10000] bg-black/25 backdrop-blur-[1px] duration-[var(--dur)]",
					// `palette-backdrop` rides along purely as a runtime marker, and
					// nothing styles it any more: the window-level chords (archive,
					// pin, team note, tab switching, open pull request) decline a
					// keystroke while one is open, via `blockingOverlayOpen()` in
					// lib/blocking-overlay, and a palette must keep matching it.
					// That helper qualifies every marker with `:not([hidden])`, which
					// is load-bearing rather than tidy: a `keepMounted` palette (the
					// Desk) is in the DOM from boot, so the unqualified selector read
					// true forever and every one of those chords was dead. The stylesheet rule it used to carry
					// said the same z-index/tint/blur written above, plus flex and
					// padding that are inert on a childless backdrop, so deleting it
					// changed nothing visually. The NAME is removable once those two
					// guards move to `[role=dialog]`, which App already uses for its
					// bare-"n" check.
					palette && "palette-backdrop",
				)}
			/>
			{palette ? (
				<BaseDialog.Viewport
					className={cn(
						"fixed inset-0 z-[6001] flex items-start justify-center px-4 pb-4 pt-[11vh] max-[560px]:pt-[7vh] [&[hidden]]:hidden",
						viewportClassName,
					)}
				>
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

/** True once the dialog's own scroll container has moved off the top, so a
 *  sticky header can take the hairline that separates a bar from its content.
 *  Takes the header NODE rather than a ref: Base UI mounts a popup's children
 *  in a later commit than the one that opens it, so a ref-based effect has
 *  already run and bailed on null by the time the DOM exists. */
function useScrolledUnder(node: HTMLElement | null): boolean {
	const [scrolled, setScrolled] = React.useState(false);
	React.useEffect(() => {
		// The popup itself is the scroller (`overflow-y-auto` on Modal.Content),
		// and the header is its first child.
		const scroller = node?.parentElement;
		if (!scroller) return;
		const read = () => setScrolled(scroller.scrollTop > 1);
		read();
		scroller.addEventListener("scroll", read, { passive: true });
		return () => scroller.removeEventListener("scroll", read);
	}, [node]);
	return scrolled;
}

/**
 * Title with a close (✕) beside it, and the description on its own full-width
 * line underneath: the standard dialog header.
 *
 * The TITLE ROW is a top bar, not a heading that scrolls away. A tall dialog
 * scrolls inside its own shell, so that row sticks to the top of it and bleeds
 * out to the shell's edges to carry the fill that hides what passes under it.
 * The negative margins cancel the shell's `p-6`, so nothing moves at rest and
 * a dialog short enough not to scroll looks exactly as it did. The hairline
 * only appears once there is something underneath.
 *
 * The description is NOT in the bar. It scrolls away with the content it
 * describes: it is read once, on arrival, and a bar is for what you still need
 * on the twentieth field, which is the title you are in and the way out.
 *
 * Two things it deliberately does NOT do. It carries no tinted icon badge: the
 * glyph repeated what the title already said, and the 54px it indented the
 * column with is what wrapped a one-sentence description onto three lines in a
 * 28rem dialog. And the ✕ shares a row with the title only, not with the
 * description, so a long title is the only thing it can ever shorten.
 *
 * The description is `text-supporting` at normal weight — the same treatment
 * `SettingsHeader` gives its own, so a dialog and a settings page open on one
 * rhythm. At the medium weight it used to carry it read at the same strength
 * as the field labels below it, and the header and the form mushed together.
 */
function Header({
	title,
	description,
	className,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	className?: string;
}) {
	const [node, setNode] = React.useState<HTMLDivElement | null>(null);
	const scrolled = useScrolledUnder(node);
	return (
		// Two children of the shell rather than a wrapper around both: a sticky
		// box only sticks while its PARENT is in view, so a bar nested in a
		// header wrapper leaves with it after ~60px of scrolling (measured). The
		// scroll container has to be the parent, which means the shell's `gap-4`
		// now falls between the bar and the description, and the description
		// pulls 10px of it back to keep its own 6px.
		<>
			<div
				ref={setNode}
				className={cn(
					// `-top-6` cancels `-mt-6`, and the two must stay a pair: sticky
					// pins the MARGIN box, so with `top-0` the negative margin lands
					// the bar 24px down the shell and leaves a strip of content
					// sliding past above it (measured). Both are the shell's `p-6`.
					"sticky -top-6 z-10 flex items-start gap-3 bg-raised",
					// `pb-3` is the air the bar keeps under the title, so text
					// passing beneath disappears with a gap rather than touching it.
					// `-mb-3` hands it straight back, leaving the resting header the
					// height it has always had.
					"-mx-6 -mb-3 -mt-6 px-6 pb-3 pt-6",
					// The seam is an inset shadow rather than a border, the way the
					// other sticky bars in the app draw theirs (PrPanel's file strip):
					// it costs no layout, so a dialog that never scrolls is not 1px
					// taller than it was for the sake of a line it will never show.
					"transition-[box-shadow] duration-[var(--dur-micro)]",
					scrolled && "shadow-[inset_0_-1px_0_var(--divider)]",
					className,
				)}
			>
				{/* Base UI renders Title as <h2> and Description as <p>; preflight
				    isn't imported (base.css owns resets), so zero their UA margins
				    or the <h2> top margin reads as phantom padding above the head. */}
				<BaseDialog.Title className="m-0 min-w-0 flex-1 text-balance text-dialog-title font-semibold leading-tight tracking-[-0.01em] text-fg">
					{title}
				</BaseDialog.Title>
				<BaseDialog.Close
					aria-label="Close"
					className="focus-ring relative -mr-1.5 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-control p-0 text-faint transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-hover hover:text-fg"
				>
					<IconX size={20} />
				</BaseDialog.Close>
			</div>
			{/* `font-normal` is load-bearing, not decoration: base.css runs the app
			    at weight 500, so a description that merely drops `font-medium`
			    still renders at the field labels' exact size, weight and colour.
			    The header's -mb-3 already reclaims 12px of the shell's gap. Pulling
			    this line back only 2px leaves it 2px below the sticky bar's painted
			    edge; the old -mt-2.5 moved its first 6px behind that opaque bar and
			    clipped the tops of every standard modal description. */}
			{description && (
				<BaseDialog.Description className="m-0 -mt-0.5 text-pretty text-supporting font-normal leading-relaxed text-dim">
					{description}
				</BaseDialog.Description>
			)}
		</>
	);
}

/** Right-aligned action row (Cancel / confirm). The extra `mt-2` on top of the
 *  shell's `gap-4` is what separates the actions from the body — 24px reads as
 *  its own zone, and the settings surfaces this borrows from deliberately have
 *  no dividers. A leading element (a destructive "Clear") sits left of the
 *  actions with `mr-auto`; the older `<div className="flex-1" />` spacer keeps
 *  working under `justify-end`. */
function Footer({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"mt-2 flex flex-wrap items-center justify-end gap-2.5",
				className,
			)}
		>
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
