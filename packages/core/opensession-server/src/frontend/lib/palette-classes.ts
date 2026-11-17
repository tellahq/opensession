/**
 * Shared Tailwind class maps for the `palette-*` family — the quiet icon
 * button and the model/effort pill that the composer toolbar and the
 * new-session palette footer both build their rows out of.
 *
 * Same two rules as lib/composer-classes.ts, and breaking either one fails
 * silently — no build error, just the wrong pixels:
 *
 * 1. **Every class is spelled out in full, literal text.** Tailwind scans
 *    source as text, so an interpolated class is never generated. Add a
 *    variant by adding a literal entry here, never by building the string.
 * 2. **A base string carries geometry; a variant carries a complete state.**
 *    Two competing colour utilities on one element do not compose — the
 *    browser takes whichever Tailwind emitted last — so `paletteIconBtnOn`
 *    restates its hover colour rather than leaning on the base's.
 *
 * These are meant to be combined through `cn()`, not concatenated: the
 * variants below depend on tailwind-merge dropping the base entry they
 * replace (`text-accent` over `text-dim`). A plain template string leaves both in and the winner is
 * decided by the compiled sheet's order.
 */

/* ── The quiet icon button ────────────────────────────────────────
   A 40px pointer target around a 20px glyph, painting a 32px wash. The wash
   is a pseudo-element inset by 4px rather than the button box: filling all
   40px read as a slab twice the size of the glyph, and the button has to keep
   its target on every viewport. `src/frontend/AGENTS.md` cites this control
   as the example of keeping a hover wash proportional.

   These details are load-bearing:
   · `border-transparent` is a real 1px border holding layout, not decoration.
     The wash is `inset-1` from the PADDING box, so dropping the border would
     grow it from 30px to 32px.
   · `[&>*]:relative [&>*]:z-[1]` lifts the glyph (and the new-session
     footer's count badge) above the wash — the pseudo-element is positioned,
     so it would otherwise paint over static in-flow content.
   · It is a circle, like every button in the app, and so is its wash.
     `rounded-full` is base.css's opt-out from the squircle (a squircle at
     50% is a lobed blob). The wash spells `before:[corner-shape:round]` out
     because `corner-shape` does not inherit into a pseudo-element.
   · The base button reset in styles/base.css already supplies `cursor`,
     `background`, `padding` and `border: none`, so only the deviations are
     written here. */
export const paletteIconBtn =
  "relative inline-flex size-10 items-center justify-center rounded-full border border-transparent text-item-title text-dim transition-[color] hover:text-fg disabled:cursor-default disabled:opacity-50 " +
  "before:absolute before:inset-1 before:z-0 before:rounded-full before:[corner-shape:round] before:transition-[background,box-shadow] before:content-[''] hover:before:bg-hover " +
  "[&>*]:relative [&>*]:z-[1] phone:[&_svg]:size-5";

/** On reads as one filled accent chip: the glyph lights up with its wash. The
 *  hover colour is restated because the base's `hover:text-fg` is a different
 *  conflict group from `text-dim` — without it, an on toggle would drop back
 *  to plain ink under the cursor, and the stylesheet's `.is-on` never did.
 *  Both hover fills stay in the wash rather than a border: a full-strength
 *  ring read as a validation outline, and it is the one thing that survived
 *  on the plan-mode surface, which carries its own accent tint. */
export const paletteIconBtnOn =
  "text-accent hover:text-accent before:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:before:bg-[color-mix(in_srgb,var(--accent)_24%,transparent)]";

/* ── The model/effort pill ────────────────────────────────────────
   ModelEffortSelect's trigger, in the composer toolbar and in the new-session
   palette footer. It stays a pill: it is a text readout you can change, not a
   plate you press.

   `rounded-full`, not `rounded-[999px]`: this control has never been a
   squircle — the stylesheet said a bare `border-radius: 999px` with no
   `corner-shape`, and the class is not in base.css's explicit squircle list.
   `rounded-[999px]` would opt it IN and change the corner.

   The border is transparent, which is the rendered state rather than a
   change: ModelEffortSelect's own trigger string already carried
   `border-transparent` ("quiet pill: no outline at rest, hover state only"),
   and as a utility it outranked the stylesheet's `var(--border)` on source
   order. Written out here so the constant describes what actually paints. */
export const palettePill =
  "relative inline-flex min-h-8 max-w-[180px] items-center gap-1.5 rounded-full border border-transparent px-[11px] py-[5px] text-label font-medium text-dim transition-[background,border-color,color] hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-55";
