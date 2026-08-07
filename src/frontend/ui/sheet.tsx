import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";

/**
 * The app's sheet/dialog language for surfaces that own their own open state —
 * summoned by a route or a keyboard shortcut rather than hung off a trigger
 * element (Settings, the account menu, the Desk).
 *
 * `ResponsiveDialog` is the primitive: one piece of content rendered as a
 * centered modal on desktop and an iOS-style bottom sheet on phone, with the
 * same dismissal, animation and focus behaviour on both. `BottomSheet` is the
 * phone-only shorthand over it.
 *
 * Deliberately not a Base UI wrapper (unlike ui/modal.tsx): these popups have
 * no trigger to anchor to, and one of them — the Desk — has to stay mounted
 * while closed so its socket keeps streaming, which Base UI's `keepMounted`
 * only does via `display: none` (that would zero the transcript's scrollHeight
 * and lose the reader's place). See `keepMounted`.
 *
 * Dismissal (backdrop tap, Esc, dragging the grabber down, or a child calling
 * the render-prop `dismiss`) always plays the exit animation before the owner
 * is told to close, so owners never manage animation themselves.
 */

/** Kept in sync with the panel transition durations below. */
const SHEET_MS = 300;
const MODAL_MS = 150;

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Phase = "closed" | "entering" | "open" | "exiting";

/**
 * Enter/exit as a four-state machine, so one render path serves both the
 * unmount-when-closed sheets and the Desk's stay-mounted overlay: `entering`
 * paints the start state for a frame so the transition has somewhere to come
 * from, `exiting` holds the panel around long enough to animate away.
 */
function usePhase(open: boolean, animated: boolean, durationMs: number): Phase {
	const [phase, setPhase] = React.useState<Phase>("closed");

	React.useEffect(() => {
		if (!animated) {
			setPhase(open ? "open" : "closed");
			return;
		}
		setPhase((p) =>
			open
				? p === "open"
					? p
					: "entering"
				: p === "closed"
					? p
					: "exiting",
		);
	}, [open, animated]);

	React.useEffect(() => {
		if (phase === "entering") {
			const raf = requestAnimationFrame(() => setPhase("open"));
			return () => cancelAnimationFrame(raf);
		}
		if (phase === "exiting") {
			const t = window.setTimeout(() => setPhase("closed"), durationMs);
			return () => window.clearTimeout(t);
		}
	}, [phase, durationMs]);

	return phase;
}

export function ResponsiveDialog({
	open,
	onClose,
	phone,
	label,
	keepMounted = false,
	desktopTransition = "pop",
	sheetClassName,
	modalClassName,
	children,
}: {
	open: boolean;
	/** Close was requested (backdrop, Esc, drag, `dismiss`) — flip `open`. */
	onClose: () => void;
	/** Phone viewport: render the bottom sheet instead of the centered modal. */
	phone: boolean;
	/** Accessible dialog label. */
	label: string;
	/**
	 * Keep the panel mounted (hidden) once it has been opened, instead of
	 * unmounting on close. For overlays whose children hold live state —
	 * sockets, scroll position — that must survive a dismiss.
	 */
	keepMounted?: boolean;
	/** `"none"` for overlays that toggle like a HUD rather than open like a dialog. */
	desktopTransition?: "pop" | "none";
	/** Extra classes for the phone sheet panel (e.g. a fixed height). */
	sheetClassName?: string;
	/** Extra classes for the desktop modal panel (e.g. a fixed size). */
	modalClassName?: string;
	children: React.ReactNode | ((dismiss: () => void) => React.ReactNode);
}) {
	// The sheet always animates: its drag-to-dismiss needs something to follow.
	const animated = phone || desktopTransition === "pop";
	const phase = usePhase(open, animated, phone ? SHEET_MS : MODAL_MS);
	const panelRef = React.useRef<HTMLDivElement>(null);
	const restoreRef = React.useRef<HTMLElement | null>(null);

	const [booted, setBooted] = React.useState(open);
	React.useEffect(() => {
		if (open) setBooted(true);
	}, [open]);

	const mounted = keepMounted ? booted : phase !== "closed";
	const shown = phase === "open";

	// Esc dismisses. Capture phase so it wins over page-level Esc handlers
	// (the app's palette/back handlers) while the dialog is up.
	React.useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, onClose]);

	// Park focus inside the dialog on open — unless a child already claimed it
	// (the Desk drops the caret in its composer on desktop) — and hand it back
	// to whatever opened us on close.
	React.useEffect(() => {
		if (!open || !mounted) return;
		restoreRef.current = document.activeElement as HTMLElement | null;
		const raf = requestAnimationFrame(() => {
			const panel = panelRef.current;
			if (!panel || panel.contains(document.activeElement)) return;
			panel.focus();
		});
		return () => {
			cancelAnimationFrame(raf);
			const prev = restoreRef.current;
			restoreRef.current = null;
			if (!prev || !document.body.contains(prev)) return;
			// Only take focus back if it was still ours — the user may have
			// clicked into the page behind us.
			const inside =
				panelRef.current?.contains(document.activeElement) ?? false;
			if (inside || document.activeElement === document.body) prev.focus();
		};
	}, [open, mounted]);

	// Keep Tab from wandering behind the backdrop. Bubble phase and only when
	// nothing else claimed the key, so a composer's @-mention popup can still
	// accept its completion with Tab.
	React.useEffect(() => {
		if (!open || !mounted) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Tab" || e.defaultPrevented) return;
			const panel = panelRef.current;
			const activeEl = document.activeElement as HTMLElement | null;
			// Focus that has legitimately left the panel (a portalled menu
			// popup) manages its own tabbing.
			if (!panel || !activeEl || !panel.contains(activeEl)) return;
			const items = Array.from(
				panel.querySelectorAll<HTMLElement>(FOCUSABLE),
			).filter((el) => el.getClientRects().length > 0);
			if (!items.length) return;
			const [first] = items;
			const last = items[items.length - 1];
			if (activeEl !== (e.shiftKey ? first : last)) return;
			e.preventDefault();
			(e.shiftKey ? last : first).focus();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, mounted]);

	// Drag the grabber down to dismiss: the sheet follows the finger (transition
	// suspended), and a decent pull flicks it away on release.
	const drag = React.useRef<{ startY: number; dy: number } | null>(null);
	function onTouchStart(e: React.TouchEvent) {
		drag.current = { startY: e.touches[0].clientY, dy: 0 };
		if (panelRef.current) panelRef.current.style.transition = "none";
	}
	function onTouchMove(e: React.TouchEvent) {
		if (!drag.current) return;
		const dy = Math.max(0, e.touches[0].clientY - drag.current.startY);
		drag.current.dy = dy;
		if (panelRef.current)
			panelRef.current.style.transform = `translateY(${dy}px)`;
	}
	function onTouchEnd() {
		const dy = drag.current?.dy ?? 0;
		drag.current = null;
		const el = panelRef.current;
		if (el) {
			el.style.transition = "";
			el.style.transform = "";
		}
		if (dy > 80) onClose();
	}

	if (!mounted) return null;

	// Only reachable with keepMounted: parked out of sight and out of the tab
	// order, still mounted and still streaming.
	const parked = phase === "closed";

	return createPortal(
		<div
			className={cn(
				"fixed inset-0 z-[10000]",
				parked && "invisible pointer-events-none",
			)}
			role="dialog"
			aria-modal={parked ? undefined : "true"}
			aria-label={label}
			aria-hidden={parked || undefined}
		>
			<div
				className={cn(
					"absolute inset-0 bg-black/45",
					animated && [
						"transition-opacity",
						phone ? "duration-300" : "duration-150",
						shown ? "opacity-100" : "opacity-0",
					],
				)}
				onClick={onClose}
			/>
			<div
				ref={panelRef}
				tabIndex={-1}
				className={cn(
					"absolute flex flex-col overflow-hidden outline-none [corner-shape:squircle]",
					phone
						? "inset-x-0 bottom-0 max-h-[94dvh] rounded-t-modal bg-surface pb-[env(safe-area-inset-bottom)] shadow-[0_-12px_40px_rgba(0,0,0,0.35)]"
						: "left-1/2 top-1/2 max-h-[85vh] w-[92vw] max-w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-modal border border-line-strong bg-raised shadow-[0_24px_70px_rgba(0,0,0,0.45)]",
					animated &&
						(phone
							? [
									"transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
									shown ? "translate-y-0" : "translate-y-full",
								]
							: [
									"origin-center transition-[transform,opacity] duration-150 ease-out",
									shown ? "scale-100 opacity-100" : "scale-[0.96] opacity-0",
								]),
					phone ? sheetClassName : modalClassName,
				)}
			>
				{phone && (
					<div
						className="flex shrink-0 touch-none justify-center pb-1.5 pt-2.5"
						onTouchStart={onTouchStart}
						onTouchMove={onTouchMove}
						onTouchEnd={onTouchEnd}
					>
						<div className="h-[5px] w-9 rounded-full bg-active" />
					</div>
				)}
				{typeof children === "function" ? children(onClose) : children}
			</div>
		</div>,
		document.body,
	);
}

/**
 * Phone-only bottom sheet with a self-closing contract: owners render it while
 * it should exist and unmount it in `onClose`, so the exit animation has to run
 * before they hear about it.
 */
export function BottomSheet({
	onClose,
	label,
	className,
	children,
}: {
	/** Called after the exit animation — unmount the sheet here. */
	onClose: () => void;
	/** Accessible dialog label. */
	label: string;
	/** Extra classes for the sheet panel (e.g. a fixed height). */
	className?: string;
	children: React.ReactNode | ((dismiss: () => void) => React.ReactNode);
}) {
	const [open, setOpen] = React.useState(true);
	const closingRef = React.useRef(false);

	const dismiss = React.useCallback(() => {
		if (closingRef.current) return;
		closingRef.current = true;
		setOpen(false);
		setTimeout(onClose, SHEET_MS);
	}, [onClose]);

	return (
		<ResponsiveDialog
			open={open}
			onClose={dismiss}
			phone
			label={label}
			sheetClassName={className}
		>
			{children}
		</ResponsiveDialog>
	);
}
