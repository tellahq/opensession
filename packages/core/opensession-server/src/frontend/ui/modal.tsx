import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { IconX } from "../components/icons";
import { cn } from "./cn";
import { dialogText, SELECTABLE } from "./dialog-styles";
import { focusStyles } from "./focus-styles";
import { sx } from "./sx";
import {
  blur,
  color,
  controlHeight,
  corner,
  geometry,
  layer,
  media,
  motion,
  radius,
  shadow,
  space,
} from "./tokens.stylex";

const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";
const HIDDEN = ":is([hidden])";

const styles = stylex.create({
  // Base UI's keepMounted popup receives `hidden` when closed. This outranks
  // the shell's own `display: flex`.
  shell: {
    display: { default: "flex", [HIDDEN]: "none" },
    flexDirection: "column",
    outline: "none",
    // A 22px base rather than the scale's `xl`: an overlay this size carries
    // a rounder corner than the controls inside it.
    borderRadius: radius.xxl,
    ["cornerShape"]: corner.squircle,
    // --dialog-ring, not --popup-ring: a shell on a scrim needs a firmer
    // hairline than a menu over the page (base.css). In light the two
    // resolve to the same line.
    "--smooth-ring-color": color.dialogRing,
    boxShadow: shadow.ringLg,
    opacity: { default: null, [STARTING]: 0, [ENDING]: 0 },
  },
  palette: {
    // `relative` anchors overlays a palette draws inside itself (the
    // dictation HUD); `overflow: hidden` keeps the rows' dividers inside the
    // corner.
    position: "relative",
    overflow: "hidden",
    // The glass the menus are made of. --popup-glass falls back to the opaque
    // fill without backdrop-filter and under prefers-reduced-transparency
    // (base-theme.css).
    backgroundColor: color.popupGlass,
    backdropFilter: "var(--popup-blur)",
    // Drops in from just above its resting place, the way a palette
    // summoned by a keystroke should.
    transformOrigin: "top",
    transitionProperty: "translate, scale, opacity",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    translate: {
      default: null,
      [STARTING]: motion.paletteDrop,
      [ENDING]: motion.paletteDrop,
    },
    scale: {
      default: null,
      [STARTING]: motion.paletteScale,
      [ENDING]: motion.paletteScale,
    },
  },
  paletteWidth: { width: geometry.paletteWidth },
  // Above the page and its floating triggers, below the palettes and the
  // modal tier: a panel you keep open should never sit over a dialog you
  // were asked to answer. Opaque, not glass: there is no scrim under this
  // one. The caller sets the transform origin to the corner it is parked in.
  floating: {
    position: "fixed",
    zIndex: layer.panel,
    overflow: "hidden",
    backgroundColor: color.raised,
    transitionProperty: "scale, opacity",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    scale: {
      default: null,
      [STARTING]: motion.dialogEnterScale,
      [ENDING]: motion.dialogExitScale,
    },
  },
  // A restrained dialog shell: lifted surface, soft edge, and enough radius
  // to read as a modal without becoming a card. Centred with translate so
  // the enter scale keeps it pinned to the middle while it pops.
  centered: {
    position: "fixed",
    left: "50%",
    top: "50%",
    zIndex: layer.modal,
    width: geometry.dialogWidth,
    translate: "-50% -50%",
    maxHeight: geometry.dialogMaxHeight,
    overflowY: "auto",
    overscrollBehavior: "contain",
    backgroundColor: color.raised,
    padding: space.s24,
    gap: space.s16,
    transformOrigin: "center",
    transitionProperty: "scale, opacity",
    transitionDuration: motion.standard,
    transitionTimingFunction: motion.ease,
    scale: {
      default: null,
      [STARTING]: motion.dialogEnterScale,
      [ENDING]: motion.dialogExitScale,
    },
  },
  centeredWidth: { maxWidth: geometry.dialogMaxWidth },
  backdrop: {
    position: "fixed",
    inset: space.s0,
    transitionProperty: "opacity",
    transitionTimingFunction: motion.easeOut,
    opacity: { default: null, [STARTING]: 0, [ENDING]: 0 },
  },
  // Palettes sit on their own, lower tier so anything that has always
  // floated above them (the caret-anchored mention popup at 10500, the modal
  // tier) keeps doing so. A lighter tint over a heavier blur: the palette is
  // glass, so the scrim composites THROUGH it.
  backdropPalette: {
    zIndex: layer.paletteScrim,
    backgroundColor: color.scrimLight,
    backdropFilter: blur.paletteScrim,
    transitionDuration: motion.micro,
  },
  backdropModal: {
    zIndex: layer.modalScrim,
    backgroundColor: color.scrim,
    backdropFilter: blur.scrim,
    transitionDuration: motion.standard,
  },
  viewport: {
    position: "fixed",
    inset: space.s0,
    zIndex: layer.palette,
    display: { default: "flex", [HIDDEN]: "none" },
    alignItems: "flex-start",
    justifyContent: "center",
    paddingInline: space.s16,
    paddingBottom: space.s16,
    paddingTop: {
      default: geometry.paletteTop,
      [media.narrow]: geometry.paletteTopNarrow,
    },
  },
  // `top` cancels the negative top margin, and the two stay a pair: sticky
  // pins the MARGIN box, so with `top: 0` the negative margin lands the bar
  // 24px down the shell and leaves a strip of content sliding past above
  // it. Both are the shell's padding. The bottom padding is the air the bar
  // keeps under the title, handed straight back by the negative bottom
  // margin, so the resting header keeps its height.
  header: {
    position: "sticky",
    top: `calc(-1 * ${space.s24})`,
    zIndex: layer.sticky,
    display: "flex",
    alignItems: "flex-start",
    gap: space.s12,
    backgroundColor: color.raised,
    marginInline: `calc(-1 * ${space.s24})`,
    marginBottom: `calc(-1 * ${space.s12})`,
    marginTop: `calc(-1 * ${space.s24})`,
    paddingInline: space.s24,
    paddingBottom: space.s12,
    paddingTop: space.s24,
    // The seam is an inset shadow rather than a border, the way the other
    // sticky bars draw theirs: it costs no layout.
    transitionProperty: "box-shadow",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
  },
  headerScrolled: { boxShadow: shadow.stickySeam },
  // In the header row the title takes the space the close button leaves.
  title: { flex: "1" },
  // The header's negative margin already reclaims 12px of the shell's gap;
  // pulling this line back 2px more leaves it just under the sticky bar's
  // painted edge rather than behind it.
  description: { marginTop: `calc(-1 * ${space.s2})` },
  // A 32px circle with an invisible 4px apron, so the corner target is
  // bigger than the glyph's wash. On a phone the apron grows to the 44px
  // touch target without moving the glyph.
  close: {
    position: "relative",
    marginRight: `calc(-1 * ${space.s6})`,
    marginTop: `calc(-1 * ${space.s4})`,
    display: "flex",
    width: controlHeight.md,
    height: controlHeight.md,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    padding: space.s0,
    color: {
      default: color.faint,
      ":hover": { default: null, [media.hover]: color.fg },
    },
    backgroundColor: {
      default: null,
      ":hover": { default: null, [media.hover]: color.hover },
    },
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    "::after": {
      content: "''",
      position: "absolute",
      inset: {
        default: `calc(-1 * ${space.s4})`,
        [media.phone]: geometry.touchBleed,
      },
    },
  },
  footer: {
    marginTop: space.s8,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space.s10,
  },
});

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
 *
 * The Desk uses `variant="floating"`: a full-bleed shell like the palette,
 * but with no backdrop and no viewport. The caller positions it with `style`
 * and pairs it with `modal={false}` on the root, so the page underneath stays
 * usable while it is open.
 */

/** Geometry of the dialog shell.
 *  - `centered` — the standard confirm/edit dialog: vertically centered, ~28rem,
 *    padded body, `gap-4` between header/body/footer.
 *  - `palette` — the command-palette shape: anchored near the top of the
 *    viewport (via Base UI's Viewport), wider, and full-bleed. No padding and no
 *    gap, because a palette's rows (search field, scrolling results, hint
 *    footer) run edge to edge and own their own spacing and dividers.
 *  - `floating` — a panel that shares the page: no backdrop, no viewport, an
 *    opaque shell the caller places with inline `left/top/width/height`. Full
 *    bleed like the palette. Pair with `modal={false}` on Modal.Root. */
export type ModalVariant = "centered" | "palette" | "floating";

export type ModalContentProps = Omit<
  React.ComponentProps<"div">,
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
  const floating = variant === "floating";
  const popup = (
    <BaseDialog.Popup
      // Centered via a single composed transform so the enter/exit
      // scale (Tailwind writes translate + scale into one transform) keeps
      // the dialog pinned to the middle while it pops. The palette variant
      // is laid out by the Viewport instead, so it only owns its own size.
      {...sx(
        [
          styles.shell,
          palette
            ? [styles.palette, widthClassName ? null : styles.paletteWidth]
            : floating
              ? styles.floating
              : [styles.centered, widthClassName ? null : styles.centeredWidth],
        ],
        cn(widthClassName, className),
      )}
      initialFocus={initialFocus}
      {...popupProps}
    >
      {children}
    </BaseDialog.Popup>
  );
  return (
    // Always body. Base UI nests a portal inside its parent's portal node, so
    // a dialog opened from a popover (the PR card's force merge confirm) would
    // land inside the popover's anchor and its stacking context. There the
    // page's own z-1 layers (the composer, the transcript fades) paint over
    // the scrim.
    <BaseDialog.Portal
      keepMounted={keepMounted}
      container={typeof document === "undefined" ? undefined : document.body}
    >
      {/* A floating panel has no backdrop at all: the page stays live under
			    it, and there is no `palette-backdrop` marker, so the window-level
			    chords keep working while it is open (lib/blocking-overlay). */}
      {!floating && (
        <BaseDialog.Backdrop
          // `palette-backdrop` rides along purely as a runtime marker that
          // nothing styles: the window-level chords (archive, pin, tab
          // switching, open pull request) decline a keystroke while one is
          // open, via `blockingOverlayOpen()` in lib/blocking-overlay. That
          // helper qualifies every marker with `:not([hidden])`, which is
          // load-bearing: a `keepMounted` palette (the Desk) is in the DOM
          // from boot. The name is removable once those guards move to
          // `[role=dialog]`, which App already uses for its bare-"n" check.
          {...sx(
            [
              styles.backdrop,
              palette ? styles.backdropPalette : styles.backdropModal,
            ],
            palette ? "palette-backdrop" : undefined,
          )}
        />
      )}
      {palette ? (
        <BaseDialog.Viewport {...sx(styles.viewport, viewportClassName)}>
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
        {...sx([styles.header, scrolled && styles.headerScrolled], className)}
      >
        {/* Base UI renders Title as <h2> and Description as <p>; preflight
				    isn't imported (base.css owns resets), so zero their UA margins
				    or the <h2> top margin reads as phantom padding above the head. */}
        <BaseDialog.Title {...stylex.props(dialogText.title, styles.title)}>
          {title}
        </BaseDialog.Title>
        <BaseDialog.Close
          aria-label="Close"
          {...stylex.props(styles.close, focusStyles.ring)}
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
        <BaseDialog.Description
          {...sx([dialogText.description, styles.description], SELECTABLE)}
        >
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
  return <div {...sx(styles.footer, className)}>{children}</div>;
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
