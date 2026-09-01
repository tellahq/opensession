# Working on the Open Session web UI

The root `AGENTS.md` still applies. This file defines the consistency rules for
everything under `packages/core/opensession-server/src/frontend/`. Preserve the established Open Session visual
language instead of introducing a new local style for each feature.

## Copy and naming

- Use sentence case for headings, buttons, menu items, tabs, field labels, and
  empty states. Do not use title case or decorative ALL CAPS. Proper nouns and
  established acronyms keep their normal capitalization.
- Keep copy short, direct, and specific. Buttons describe the action (`Create
session`, `Try again`); headings name the place or object (`Model providers`).
- Reuse the product's existing terms. Do not casually rename projects, sessions,
  workspaces, automations, runs, reviews, or other established concepts.
- Prefer plain language over implementation details. Errors should say what
  happened and, when useful, what the person can do next.
- Use an ellipsis only when an action requires more input before it happens,
  not as decoration or to make labels feel softer.

## Components

- Search `packages/core/opensession-server/src/frontend/ui/` before building a control. New buttons, menus,
  modals, sheets, popovers, tooltips, switches, page headers, settings rows,
  loading states, empty states, and alerts should use the existing primitive.
- Use `Button` for actions and glyphs from `components/icons.tsx` for interface
  icons. Icon-only controls need an accessible name and usually a tooltip.
- Icons are iconic-pro, drawn on a 24-unit grid and stroked through the shared
  `stroke` object in `components/icons.tsx` (1.5, round caps and joins). Spread
  it rather than writing a `strokeWidth`, so every glyph carries one weight. A
  new icon is a new export in that file, traced to the same grid; do not inline
  an SVG at a call site or pull one from another set.
- This is the web's convention, not the product's. The native app draws SF
  Symbols for the same reasons in reverse (see `packages/clients/ios/AGENTS.md`), so a glyph
  that exists in both clients is expected to look different in each. Do not
  port one set across to make them match.
- Build new interactive primitives on Base UI and wrap them in `ui/`. Keep the
  composable Base UI parts API; do not replace it with a large prop-driven
  component or bypass its focus and keyboard behavior.
- Put reusable visual vocabulary in `ui/`; keep feature-specific composition in
  `components/`. Extract a primitive only when more than one surface should
  intentionally look and behave the same.
- Do not create one-off versions of an existing card, spinner, empty state,
  alert, button, or popup. Extend the shared primitive with a small, general
  variant when the difference is genuinely reusable.

## Both widths, one change

This tree is one bundle serving a desktop window and a phone (the browser and
the installed PWA). A missing phone layout therefore has no file whose absence
would remind you of it: the feature is already "in" the phone build, just
unusable there. Build both widths in the change that introduces the feature,
or say in your final report which part is still desktop-only and why. The
retrofits this rule exists to prevent were two follow-up commits on the /new
palette, and the list below is what they had to add.

The mechanisms, by name:

- the 720px boundary, spelled `"@media (max-width: 720px)"` (phone) and
  `"@media (min-width: 721px)"` (desktop) as StyleX keys, and
  `PHONE_QUERY` (`lib/breakpoints.ts`) for `matchMedia`
- `PHONE_QUERY` (`lib/breakpoints.ts`) is the same boundary for `matchMedia`,
  pinned to the stylesheet by `breakpoints.test.ts`. Do not write the query
  again in a component.
- `useIsPhone()` (`hooks/useIsPhone.ts`) to swap a surface for a different one.
- `isTouchPrimary` (`lib/platform.ts`) for input-shape questions: whether the
  client has a hover, a physical keyboard, a right-click. A narrow desktop
  window is not a phone, and an iPad with a keyboard is not a desktop.
- `ResponsiveDialog` / `BottomSheet` (`ui/sheet.tsx`): one content, centered
  modal on desktop and bottom sheet on phone, with dismissal, focus and
  animation already handled. Reach for this before hand-rolling a phone branch.
- `toolFitsViewport()` (`lib/sidebar-tools.ts`) is the one place a whole
  surface is deliberately width-gated. A new one belongs there, not inline.

What a desktop-shaped surface is usually missing at 390px:

- **Touch targets.** 44px minimum (`min-h-11`, `size-11`). Desktop rows of 28
  to 36px controls are all under it.
- **A way out.** A phone has no Esc and no click-outside habit, so a dialog or
  sheet needs a visible close control.
- **The bottom edge.** Anything resting on it clears the home indicator with
  `env(safe-area-inset-bottom)`; `ui/sheet.tsx` already does, a hand-rolled
  footer does not.
- **Room for a label.** A trigger that truncates to two characters needs its
  label above it at phone width. Do not solve it by shrinking the type.
- **A row that fits.** `justify-between` with `max-w-[46%]` siblings is a
  desktop shape; on a phone it becomes a labelled column or grid.
- **A tap path.** A control revealed on hover, a native `title` tooltip, or a
  submenu that opens on hover does not exist on a phone.
- **16px text inputs** (`--text-input-phone`), or iOS zooms the page on focus.
- **The right send key.** `effectiveSendKey()` (`lib/send-key.ts`): a soft
  keyboard has no Shift+Enter, so Enter cannot also send.

`phone:hidden` is the last resort, not the phone layout. When you use it, the
same change says where that thing went instead.

Verify at the real width rather than by reasoning about the classes:

```
bun scripts/capture-ui.ts /tmp/after-phone.png --route /new --width 390 --height 844
```

Any width at or below 720 captures at phone density with the desktop chrome
off. `bun scripts/css-shots.ts <name>` sweeps routes x {desktop, mobile} x
{dark, light} and `--diff` compares two runs, which is what keeps a phone
layout from regressing once it exists.

## Styling

- Style components with StyleX: a `const sx = stylex.create({ … })` beside the
  component, composed onto the element with `{...stylex.props(sx.a, sx.b)}`.
  Conditional styling is composition (`stylex.props(sx.base, active && sx.on)`),
  never string building. `styles/STYLEX-MIGRATION.md` is the full contract.
  A class name left on the markup is a hook for something else (a residual
  rule in `styles/residual.css`, base.css, a `closest()` call, another
  module's `[.that-class_&]`) — say which, in a comment, or drop the name.
- Use the semantic tokens from `styles/tokens.stylex.ts` (`tokens.panel`,
  `tokens.fg`, `tokens.dim`, `tokens.line`, …), which resolve through the
  base.css custom properties so theming stays in one place. Never add raw
  color values to product UI. Type comes from the shared scale
  (`styles/typography.stylex.ts`): compose `typography.body`,
  `typography.meta`, … instead of writing font sizes.
- Do not frame a section, card, or tile in a border. A block that sits on its
  own fill (`bg-panel` on `bg-surface`) is already separated from the page, and
  a hairline around it adds a second edge that makes a page of them read as a
  form. Separate by surface, spacing, and radius instead. Borders stay for the
  things that are genuinely a line: a divider between rows, the edge of an
  input or a control, a table rule. The one carve-out is a surface whose fill
  has deliberately been taken below where a fill alone holds its shape, which
  today is the settings plate (`--settings-plate`, `ui/settings.tsx`): there
  the hairline replaces the weight the fill gave up rather than adding to it,
  and the pair is quieter than the full L1 grey was on its own. It takes
  `border-divider-soft`, a third-strength outline, not the `border-line` its own
  rows take: closing a block's shape asks less of a line than separating rows,
  and at the row weight the outline was the loudest thing on the page. That is
  a trade, not a licence. It does not extend to `Card`, which stays
  borderless, and a card that still carries a normal fill has nothing to
  trade.
- Round generously, and scale the radius with the box. The named corners live
  in `tokens.stylex.ts` (`radiusControl` / `radiusRow` 12, `radiusPopup` 16),
  authored as `calc(<n>px * var(--rf))`, so a browser with `corner-shape`
  support renders them 1.35x larger. A small control keeps a small corner; a
  card takes a step up, and a container that holds cards a step above that.
  Never write an arbitrary radius, and never give one surface two different
  corners.
- Keep nested corners concentric: an inner radius plus the padding around it
  should equal the outer radius. A child rounded as hard as its parent pinches
  the gap between them, and a square child inside a round parent reads as a
  mistake at the corner.
- Corners are squircles. `base.css` grants `corner-shape: squircle` to anything
  carrying a `rounded-*` class, with one exception: `rounded-full` opts out. Use
  `rounded-[999px]` for a pill or circle that should stay a squircle, and
  `rounded-full` only where a true circle is wanted.
- Align a heading with the content inside the rows under it, not with the row's
  outer edge. A grouped list reads as a label over its items only when the two
  share an x. Row pages get there by outdenting the list past the content edge
  (`-mx-3` with `px-3` on rows and labels, see `lib/archived-classes.ts`); card
  pages get there by indenting the headings by the card's padding (see
  `PEOPLE_INSET`). Pick one inset per page and use it for both.
- Compose classes with `cn()`. Accept and merge `className` in shared
  primitives so callers can adjust layout without copying the component.
- Paint interaction states with the hover washes — `hover:bg-hover` /
  `bg-pressed` in Tailwind, `var(--hover)` / `var(--hover-strong)` in
  `base.css`. They are translucent ink, so one token reads at the same
  strength on any surface. Do not use `--bg-hover` or `--bg-raised` as a hover:
  they are absolute surfaces, so they land as a heavy wash on `--bg` and a
  nearly invisible one on `--bg-panel`, and `--bg-raised` steps the wrong way in
  one theme. `--bg-hover` stays for the few real surfaces built on it (the
  segmented-control track, the scroll-fade `box-shadow` masks).
- Keep a hover wash proportional to the control. A small icon button should
  paint roughly the box its neighbours do, not its whole 40px target — see
  `paletteIconBtn` in `lib/palette-classes.ts`, which paints on a
  pseudo-element inset by 4px (`before:inset-1`).
- Follow the existing spacing, type, radius, border, and icon scales. Prefer a
  nearby shared component or token over a new arbitrary value.
- Reach for the breakpoint by its exact media key: `"@media (max-width: 720px)"`
  (phone, 720 included) and `"@media (min-width: 721px)"` (desktop). The two
  spellings are pinned by `styles/stylex-parity.test.ts`; a third spelling of
  the same boundary is how the layouts drift apart at exactly 720px.
- Match the surrounding surface before adding visual emphasis. Accent colors,
  raised surfaces, shadows, and animation should communicate meaning, not make
  a new feature louder than its neighbors.
- Add rules to `styles/base.css` only when they are truly global or
  theme-level — tokens, resets, platform chrome, and the keyframes and
  `@property` registrations that have no element to hang a utility on. Never
  add to `styles/legacy.css`: it is empty on purpose. Component styling belongs
  with the component, as utilities or a primitive in `ui/`.

## Interaction and accessibility

- Use semantic HTML first. Every interactive element must work with a keyboard
  and expose an accessible name; do not make a clickable `div`.
- Preserve visible focus, disabled, loading, error, empty, hover, and pressed
  states. Hover may enhance a control but cannot be the only way to discover or
  operate it.
- Give anything a finger operates a 44px target, and treat a desktop-only
  success as an unfinished UI change. See "Both widths, one change" above.
- Use the motion guidance and shared presets from the root `AGENTS.md`. Motion
  should clarify state or spatial relationships, remain interruptible where
  appropriate, and respect reduced-motion preferences.
- Keep destructive actions clearly named and visually distinct. Confirm only
  actions that are difficult or impossible to undo.

## React and verification

- Follow the existing React 19 patterns. The build runs the React Compiler
  (oxc Rust port, wired as a Bun plugin in `frontend-build.ts`), and all hand
  memoization has been removed: do not add `useMemo`, `useCallback`, or
  `React.memo`. The compiler preserves value and callback identity across
  renders, which is what those hooks were doing by hand. The one measured
  exception is callback refs passed to DOM elements (`ref={...}`): keep those
  stable yourself if both calls update state — see `useSessionScroll.ts`.
  Do not use `"use no memo"`: `bun run lint` compiles every frontend source and
  fails on any bailout, and production builds enforce the same invariant.
  Rules-of-hooks and exhaustive-deps are errors in CI (oxlint). Use
  `useEffectEvent` for non-reactive logic that must read the latest props or
  state without restarting an effect. Note the compiler only runs on the
  prod/release bundle; Bun's dev HMR server has no plugin hook, so dev serves
  uncompiled sources.

  Exception — explicit identities are load-bearing in three files and must not
  be de-memoized (removing them caused React #185 render loops, and closed the
  live WebSocket before `transcript_init` could arrive):
  `components/SessionViewer.tsx`, `hooks/useWebSocket.ts`,
  `hooks/useSessionScroll.ts`. Leave their `useMemo`/`useCallback` in place.
  The same care applies anywhere a callback ref sets state: an unstable
  identity detaches and reattaches the ref every render.

- Keep component files component-only: put non-component helpers/constants in
  `lib/` or `ui/` modules, because mixed component+helper exports disqualify a
  module from React Fast Refresh and downgrade every edit to a full page
  reload.
- Keep state close to where it is used. Do not add a new context, store, or
  abstraction for state that belongs to one component tree.
- Run `bun run typecheck` and the relevant `bun test` targets after code
  changes. For visible changes, capture the real page at both 1440x900 and
  390x844 with `scripts/capture-ui.ts` and look at each, then exercise
  keyboard interaction, loading, empty, and error states that the change
  affects. The phone capture is the one that catches what reasoning about the
  classes does not.
