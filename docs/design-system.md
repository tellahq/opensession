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
`Checkbox`, `Radio`, `Segmented` and both `Tabs` styles. Shared pieces:
`ui/sx.ts` (merges a primitive's StyleX props with a caller's legacy
`className`, and defines the `LayoutStyles` type every `xstyle` uses),
`ui/choice-styles.ts` (the box a Checkbox and a Radio share), and
`ui/markers.stylex.ts` (named markers for `stylex.when.ancestor`, so a tab's
inner plate reacts to its own tab's hover, not to any ancestor's). Three
things to know when porting:

- base.css squircles any element whose class contains `rounded-`. StyleX
  classes don't match, so a rounded StyleX element sets
  `["cornerShape"]: corner.squircle` itself. The key is quoted because the
  lint bans "shape" in symbol names.
- Values that are measured off a native control, not picked from a scale
  (the macOS switch track and knob, the checkbox box), live in `geometry`.
- A primitive that sets `data-progress` keeps spinning under reduced motion,
  as `.animate-spin` did.

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
