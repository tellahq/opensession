# Design system

The web UI is moving from Tailwind utilities on every element to
[StyleX](https://stylexjs.com/) primitives with closed scales. This file is
the reasoning and the plan. The values themselves live in
`packages/core/opensession-server/src/frontend/ui/tokens.stylex.ts`, and the
rules for writing UI are in `packages/core/opensession-server/src/frontend/AGENTS.md`.

## Why

The colour tokens were never the problem: the audit has counted zero stock
palette colours and zero stock shadows for months. The drift is in sizes and
in who decides them. When the migration started, the frontend had:

| Signal                                                     |        Count |
| ---------------------------------------------------------- | -----------: |
| One-off pixel values (`h-[31px]`, `px-[9px]`, `gap-[7px]`) |          768 |
| Distinct heights / horizontal paddings / opacities         | 39 / 30 / 15 |
| Exported per-feature class strings in `lib/*-classes.ts`   |          487 |
| Raw `<button>` outside `ui/`                               |          303 |
| Visual utilities passed to `<Button className>`            |          581 |
| Cross-component selectors (`[.x_&]:`, `[&_...]:`)          |          313 |

Any caller can restyle any primitive, so each feature became its own small
design system, and new UI (human or generated) copies the nearest example with
its odd values. A rule in a document does not stop that. A type does.

## Shape

1. **Tokens** (`ui/tokens.stylex.ts`). The only place a length, a colour, a
   radius, a type size or a duration is written. Every scale is closed.
   Icon sizes are the same idea as a type: `IconSize` and `DenseIconSize` in
   `components/icons.tsx`, so `size={17}` is a compile error rather than a
   number the icon silently clamps.
   Line height and tracking are closed on both sides: StyleX's `leading`
   and `tracking`, and the same names as Tailwind theme values
   (`leading-title`, `leading-body`, `tracking-tight`, `tracking-title`). A
   line box that must equal its control's height takes a spacing step
   (`leading-6.5`); `ui-audit`'s `arbitrary-leading` counts the rest.
   Stacking order is one list of named layers, bottom to top, in
   base-theme.css (`--layer-*`): Tailwind reads them as `z-<name>`
   (`z-sticky`, `z-chrome`, `z-modal`) and StyleX as `layer.<name>`. Inside a
   component's own stacking context, siblings take small integers (`-z-1` to
   `z-9`). `off-scale-z` counts any other z-index of 10 or more.
   Motion is named the same way: `duration-micro/standard/long`,
   `ease-standard`, `scale-press` (a control), `scale-press-plate` (a card)
   and `scale-grow` (a small mark's hover), the desk's `duration-pop` and
   `scale-pop`, and named animations (`animate-live`, `animate-waiting`,
   ...) in tailwind.css, matching StyleX's `motion`. Every press is
   `scale-press`, and every spinner is `animate-spin`, one turn a second,
   reduced motion included. `off-scale-motion` counts
   arbitrary or numbered durations, easings, scales and animations.
   Radius is the `--rf` scale (`rounded-xs` to `rounded-2xl`, `control`,
   `popup`) plus named shapes: `rounded-capsule` (a squircled pill),
   `rounded-composer`, `rounded-sheet`, and the new layout's round, unscaled
   `rounded-tab` and `rounded-pane`. Tailwind emits a theme value such as
   `--radius-popup` as a custom property only when some source references
   it, so an inline style or a stylesheet writes `calc(<step>px * var(--rf))`
   rather than depending on that.
   `off-scale-radius` counts raw lengths and steps off the scale.
   A translucent hue is an opacity step, not a hand-written `color-mix`:
   `bg-<hue>/6`, `/10` (soft), `/16`, `/22` (edge), `/34` (strong) and
   `/40` (a tinted line). A tone chip that has to stay solid takes
   `bg-tone-<hue>` and deepens with `bg-tone-hover`; a solid hue plate's
   edge is `border-<hue>-deep`. A theme color is written by name
   (`bg-red`, not `bg-[var(--red)]`). Shadows are the smooth-shadow tiers
   or a named one: `shadow-halo-<tone>` (a dot's or a focused field's 3px
   ring), `shadow-glow-blue`, `shadow-avatar`, `shadow-composer` and
   `shadow-header-control`, mirrored as `shadow.*` and `color.tone*` in
   StyleX. `off-scale-tint` and `arbitrary-shadow` count the rest.
   Column widths are named measures, the same in both systems:
   `max-w-page-narrow` (760, a conversation or a PR), `max-w-page` (860),
   `max-w-page-wide` (920, a feed or a list), `max-w-settings` (720) and
   `max-w-card` (560, a lone card in a column), with StyleX
   `geometry.page*` and `geometry.card`. An inline status dot is
   `size-dot-inline`. `arbitrary-size` counts every other raw length on a
   size, width or height utility.
   Spacing is StyleX's `space` scale, in Tailwind steps 0 to 12 (0 to
   48px, 2px apart up to 16, then 20, 24, 32, 40, 48) plus `px` for a
   hairline. `off-scale-spacing` counts arbitrary pixel spacing and steps
   off the scale; the odd values left (3, 5, 7, 9, 11px) are mostly
   border-compensated or optical insets, folded component by component as
   each area moves to StyleX, with a parity check per component.
   Keyboard focus is one ring, 2px of accent ink: `focus-ring` draws it
   2px outside the box, and `focus-ring-inset` draws the same ring inside,
   for a row whose rounded list clips anything outside it.
2. **Primitives** (`ui/*.tsx`). Authored in StyleX against the tokens. Each
   one owns its look completely and exposes `variant` / `size` for the
   choices the system has made, plus an `xstyle` prop whose type only accepts
   placement (margin, flex, grid, width). A caller cannot change a primitive's
   height, padding, colour or corner, and `bun run typecheck` says so.
3. **Features** (`components/`). Compose primitives and lay them out. No
   visual styling of their own; a surface that needs a look the system lacks
   adds a variant to the primitive, once, for everyone.

StyleX is a good fit for that shape: styles are typed objects (so a token is
an import, not a string that may not exist), there are no descendant
selectors (so one component cannot restyle another from outside), the last
style passed wins deterministically (no tailwind-merge rules to remember), and
the compiler emits one atomic class per declaration, so the sheet stops
growing with the number of screens.

## Decisions

| Scale          | Values                                                                             | Notes                                                                                  |
| -------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Control height | 26 / 32 / 36, touch 44                                                             | `controlHeight.sm/md/lg/touch`. Nothing in between; every Button is 44 at phone width. |
| Spacing        | 0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 40, 48                                  | `space.s<px>`. A 2px step to 16, then 4, then 8. No odd values.                        |
| Radius         | 2, 4, 7, 12 (control), 14, 16 (popup), 18, 22, pill                                | Nothing past 22. Each `calc(<n>px * var(--rf))`, so squircle browsers get 1.35x.       |
| Type           | meta 11, label 13, item title 14, body 15, dialog 17, section 19, page 24, stat 28 | Roles, not sizes. Each promotes one rung on phone.                                     |
| Weight         | regular 400, medium 500, title (500 dark / 600 light)                              | Semibold and bold are for prose, not chrome.                                           |
| Opacity        | disabled 0.4, muted glyph 0.6, glyph on a tone 0.8                                 | Named by meaning.                                                                      |
| Focus          | 2px accent-ink ring, 2px offset                                                    | One treatment for every control.                                                       |
| Motion         | `var(--ease)`, `var(--dur-micro)`, press scale 0.96                                |                                                                                        |
| Breakpoint     | phone at 720px and below, desktop above                                            | `media.phone` / `media.desktop`.                                                       |

Colours and type are `defineConsts` aliases over the theme custom properties
in `styles/base-theme.css`, so light and dark (and any subtree that re-points a
property, like the side panel plate) keep working unchanged.

### Decided since the first port

1. **Phone touch height.** Every Button is 44px tall at phone width, and an
   icon-only one 44px square. The 124 call sites that patched
   `phone:min-h-11` / `phone:size-11` onto a Button no longer do.
2. **Label line height.** One `leading.label` for every Button size.
3. **Radius aliases.** `rounded` became `rounded-xs`, `rounded-row` became
   `rounded-control`, `rounded-panel` became `rounded-lg`, and the two
   surfaces on `rounded-section` / `rounded-3xl` (the first-run and sign-in
   cards) take `rounded-2xl`. The aliases are gone from the theme and
   `off-scale-radius` counts any that come back.
4. **Caret opacity.** The menu chevron takes the same 0.6 as every muted glyph.

### Open decisions

1. **Type roles own their line height.** `text-label`, `text-meta` and the
   other roles set a size but no line height, so they inherit `normal`, while
   `text-xs` / `text-sm` / `text-base` (137 uses) carry Tailwind's stock
   leading. Folding the aliases into the roles needs the roles to decide a
   line height first, and that moves every row in the app by a pixel or two.

## Migration

While both systems exist, the StyleX sheet sits between `base.css` and the
Tailwind utilities, all unlayered (see `stylexCss()` in
`src/server/stylex-transform.ts`). A primitive's StyleX classes beat the
element resets, and a caller's Tailwind class of equal specificity still wins
on source order, which is what tailwind-merge gave callers before. That is why
a primitive can be ported without touching its call sites, and why the port of
`Button` renders identically: every computed style of every button on nine
routes, at both widths and in both themes, matched the Tailwind version.

Ported so far: `Button`, `Badge`, `Card`, `Spinner`, `Switch`,
`Checkbox`, `Radio`, `Segmented`, both `Tabs` styles; the field family
(`Input`, `Textarea`, native `Select`, `Field`, and the select trigger, in
`ui/field-styles.ts`); the popup family (`Menu`, `ContextMenu`, `Select`,
`Combobox`, `Popover`, `Tooltip`, on `ui/popup-styles.ts`); the dialog
family (`Modal` in all three variants, `ResponsiveDialog` and the sheet
parts, `Confirm`, sharing `ui/dialog-styles.ts`); and the leaves
(`PulseDot`, `WorkingPill`, `ListRow`, the page layout and header,
`FloatingStatus`, `OverflowFadeText`, the collapsible panel, `Disclosure`,
`Fold`, `CopyCheck`, `DeviceCode`, `TextShimmer`, the setting rows,
`HoldToConfirmButton`'s fill, `DataGrid`); the settings primitives
(`ui/settings.tsx`: the header, group label, plate, rows, hint and form
parts); and the async states (`ui/state.tsx`: `EmptyState`, `LoadingState`,
`InlineAlert` and the skeletons, whose bars take a `width` and a `line`
rather than width utilities); `Toast`; `OverlayAction` (its preview spreads
`OVERLAY_ACTION_HOST`, a StyleX marker, instead of `group/overlay-action`);
the swipe decks' `SwipeCard` and `DeckDone`; and `DateRangePicker`. The
class-string helpers (`fieldClasses`,
`selectTriggerClasses`, `popupSurfaceClasses`, `collapsiblePanelClasses`,
`listRowClass`, `SETTING_ROW`, `rowMenuTriggerClasses` and friends) now
return StyleX class names, so the raw controls that use them moved too.

Hooks the settings port replaced: the phone sheet tells a panel's header to
leave its h1 out through the `SettingsInSheet` context, not a
`.settings-sheet` ancestor selector; a host restyles the plates inside it by
`[data-settings-surface]`, not `.bg-settings-plate`; and Settings sets row and
form titles' leading by `[data-setting-title]`. The inset rule between a
card's rows and the control column's `[&>*]` cap stay utilities, because they
style the caller's children.

Every primitive in `ui/` is now StyleX. The last one, `top-bar.tsx`, moved
with the phone app header: its values live in `ui/app-header-styles.ts`, and
`lib/app-header-classes.ts` reads them as the class strings feature code
composes. The header's glass (`glassEffects`, `glassFill`, `capsule`) is
defined once there, so Back, the title pill, the grouped actions and the
session tab strip cannot drift apart. What stays utilities is what reaches
past the element: the floating bar's `::before` fade and its `.app:has(...)`
offsets, the archived search collapse under `body.kb-open`, and the
`[&_svg]` glyph sizes.

Feature areas follow the same pattern, one area at a time. The settings page
and the phone settings sheet live in `lib/settings-classes.ts`; the sidebar
pieces settings borrows (the density scale, the 22px rail and the gap after
it, the hover layer, the group gap) are `sidebarStyles` in
`lib/sidebar-classes.ts`, with their numbers in `sidebarScale`. The sidebar's
containers and group headings followed: a heading is `sidebarHeader({ kind,
sticky, nested, navigates, selected, inert })` and its chevron is
`sidebarChevron(collapsed)`, each one StyleX call, so a caption's tighter gap
beats the base's by argument order and the chevron reveals off
`sidebarHeaderMarker` rather than a Tailwind group. The stuck backing and
fade (pseudo-elements keyed on `data-stuck`) and the new layout's quieter
caption (a sibling reach) stay utilities. Rows work the same way: every
family (session, workspace, PR, feed, report, draft) is `sidebarRow({ layout,
swipe, selected, chips, standing })`, where `chips` is how much of the right
end the hover actions take. Its parts (`SIDEBAR_ROW_TITLE`, `sidebarRowChip`,
`sidebarRowActions`, `sidebarRowTime`, the ticker, snooze badge and facepile)
read the row's hover and its `data-selected` / `data-waiting` / `data-unread`
state through `sidebarRowMarker`. A component that merges a caller's chip
into its own look, like `KeepInSidebarMark`, takes the chip as `xstyle` and
applies both in one `stylex.props` call, because a StyleX class string handed
to a Tailwind `cn()` loses to the component's own utilities. A phone row's
swipe actions are `sidebarSwipeAction({ side, open, dragging })`, and a
session's state dot is the `StatusDot` primitive in `ui/status.tsx`: an
element that has to keep animating under reduced motion carries a
`data-pulse` attribute that base-theme.css hands its duration back to, since
a class string cannot carry `!important`. Band headings are
`sidebarBandHeading()` around `SIDEBAR_BAND_TOGGLE`, whose chevron
(`sidebarBandChevron({ collapsed, brighten })`) reveals off
`sidebarBandMarker`; the Workspaces row is `sidebarWorkspacesBand(...)`
with `sidebarWorkspacesTitle(...)` and `sidebarHeaderButton({ phone,
filter })`, and a feed band's filter is `sidebarBandAction(active)`, its
set-filter dot a StyleX `::after`. Each class
string constant is `classString(...)` from `ui/sx.ts`: pass every style one
element wears in one call, so two styles that set the same property are
settled by argument order, not stylesheet order. Hooks that CSS or tests read
(`settings-nav`, `settings-content`, `settings-content-tool`,
`settings-drag-handle`, `wco-chrome`, `settings-title`) stay plain class
names beside the StyleX ones.

Other shared pieces: `ui/sx.ts` (merges a primitive's StyleX props with a
caller's legacy `className`, and defines the `LayoutStyles` type every
`xstyle` uses), `ui/choice-styles.ts` (the box a Checkbox and a Radio share),
`ui/focus-styles.ts` (the `focus-ring` utility as a style), and
`ui/markers.stylex.ts` (named markers for `stylex.when.ancestor`, so a part
reacts to its own control's hover or state, not to any ancestor's). A
primitive that is a Button with a twist passes its extra look as Button's
`skin` (the overlay action's white plate, a month step's disabled state);
feature code never does, and `ui-audit`'s `button-skin` count holds that at 0.

Things to know when porting:

- base.css squircles any element whose class contains `rounded-`. StyleX
  classes don't match, so a rounded StyleX element sets
  `["cornerShape"]: corner.squircle` itself. The key is quoted because the
  lint bans "shape" in symbol names.
- Values that are measured off a native control, not picked from a scale
  (the macOS switch track and knob, the checkbox box), live in `geometry`.
- A primitive that sets `data-progress` keeps spinning under reduced motion,
  as `.animate-spin` did.
- StyleX emits a rule inside `@media (hover: hover)` after every plain
  pseudo-class or attribute state, whatever order the object lists them in.
  A hover that shares a property with `:focus`, `:disabled` or an open state
  must exclude that state (`":enabled:hover"`,
  `":not([data-popup-open]):not(:focus):hover"`), or it wins under the
  pointer.
- tailwind-merge only dropped a primitive's class when the caller's class had
  the same variant. Now every caller utility lands after the StyleX sheet, so
  a caller's unprefixed `gap-3.5` also beats the primitive's phone gap, and a
  class tailwind-merge used to drop (a mistaken `text-input-phone` taken for
  a colour, an `h-10` under a variant height) applies again. The parity
  sweep finds these; decide each one, do not paper over it.
- A style merged after another replaces each property it names at every
  width. A phone-only override written `{ default: null, [media.phone]: x }`
  therefore wipes the desktop value it lands on: restate the default
  (`{ default: color.sidebar, [media.phone]: color.transparent }`), or pass
  the override as a separate class string when the two agree at phone
  width. Two class strings that set one property differently at the same
  width are the opposite mistake: which wins is stylesheet order, so merge
  them in one `stylex.props` call (`headerTitlePill()`).
- Some utility names are also hooks: base.css makes `.text-supporting` text
  selectable, and Settings tightens the leading of `.text-item-title` and
  friends from an ancestor. A port that drops the utility keeps the hook
  (`SELECTABLE` in `ui/dialog-styles.ts`) or the value it was given.

The order of work:

1. **Primitives.** Port `ui/` one primitive at a time, each with a locked
   `xstyle` type and a computed-style parity check against `main`.
2. **Call sites.** Move each feature off `className` overrides onto variants
   and `xstyle`, area by area (sidebar, session viewer, composer, settings),
   deleting its `lib/*-classes.ts` constants as it goes.
3. **Tailwind out.** When the last utility is gone, switch StyleX to
   `useLayers: true`, drop the coexistence workarounds, and remove Tailwind.

Two ratchets in `bun scripts/ui-audit.ts` keep it moving one way:
`stylex-raw-value` (zero, permanently: StyleX code uses tokens or nothing) and
`button-restyle` (visual utilities on `<Button className>`, which only goes
down). Port a primitive, add its own restyle signal.

## What stays CSS

Not everything can or should become StyleX:

- the token substrate (`base-theme.css`), until tokens move to `defineVars`;
- the reset, the scroll model, and platform chrome (Electron drag regions,
  safe areas, standalone PWA rules);
- keyframes and `@property` registrations with no element to hang on;
- styling for HTML that is not rendered by React components, chiefly markdown
  output (`base-markdown.css`, `styles/blocks/`). That moves only if markdown is
  rendered through components.

## Build

One transform (`src/server/stylex-transform.ts`) serves three paths:

- **Production** (`compileAssets` in `frontend-build.ts`): StyleX runs inside
  the React Compiler plugin's `onLoad`, first, because Bun gives a file to one
  `onLoad` only. Rules are collected per file and appended to the global sheet.
- **Dev** (`OPENSESSION_DEV=1`): `bunfig.toml` registers
  `stylex-dev-plugin.ts` with Bun's HTML-import server. It writes
  `.frontend-dist/.stylex-dev.css`, served at `/stylex.css` and linked just
  ahead of `/tailwind.css`. Reload the page to pick up new rules.
- **Tests**: `scripts/test-setup.ts` registers the same transform in StyleX's
  test mode, which names classes after their style keys
  (`button__styles.primary`) and emits no CSS.

Only files that import `@stylexjs/stylex` go through Babel.
