# Tailwind → StyleX migration contract

Branch: `port/stylex`. Foundation commits explain the machinery:
`4790dacfd` (compiler pass), `641ea2144` (tokens), `443b571dc` (static
conversion codemod). Read this file before converting anything.

## What is already done

Every STATIC `className="…"` string was mechanically converted by
`scripts/stylex-codemod.ts`: each token became a `stylex.create` entry named
after the original token (`flex`, `textDim`, `hoverTextFg`, …), composed
through `{...stylex.props(sx.a, sx.b)}`. Do not redo those; your job is the
dynamic remainder and the polish.

## Your job: dynamic className sites

Files (or elements) whose styling is computed — `cn(…)`, template literals,
ternaries, maps over class strings, and the exported string constants in
`lib/*-classes.ts`. Rules:

1. **Behavior-preserving, interface-preserving.** Props in, DOM out, event
   handlers, aria/data attributes, and rendered structure must not change.
   A component that accepts `className` KEEPS accepting `className`
   (residual classes flow through it) — do not migrate primitive APIs in
   this wave; callers elsewhere still pass strings.
2. **Static parts become `sx` entries** exactly like the codemod output:
   semantic-ish names mirroring the old tokens, one entry per token, merged
   with `stylex.props(...)`.
3. **Conditional styling uses composition, not string building:**
   `cn("px-2", active && "bg-active")` becomes
   `stylex.props(sx.px2, active && sx.bgActive)` — falsy args are fine.
4. **Variant keys are exact.** Pseudos: `":hover"`, `":focus"`,
   `":focusVisible"`, `":focusWithin"`, `":active"`, `":disabled"`,
   `"::before"`, `"::after"` (`::before`/`::after` need `content: '""'`).
   Every Tailwind `hover:` rule was emitted inside `@media (hover: hover)`;
   preserve that gate in StyleX by nesting the `":hover"` block under
   `"@media (hover: hover)"`. A bare `":hover"` changes sticky-hover behavior
   on touch devices and is not parity.
   Media queries, spelled EXACTLY: `"@media (max-width: 720px)"` (phone),
   `"@media (min-width: 721px)"` (desktop), plus prefers-reduced-motion /
   pointer-coarse queries as needed. These two width literals are pinned by a
   guard test; never spell another width form of them.
5. **Type roles**: never hand-write font sizes. Import the shared scale —
   `import { type as typography } from "../styles/typography.stylex";`
   (aliased because many files have a local value named `type`) — and compose
   `typography.meta | label | supporting | controlLabel | body | itemTitle |
dialogTitle | sectionTitle | pageTitle | stat | inputPhone`.
6. **Colors/tokens**: values resolve through base.css custom properties.
   Prefer the token objects (`import { tokens } from "../styles/tokens.stylex"`)
   or literal `"var(--…)"` references; NEVER a raw hex/rgb color. Radii:
   `tokens.radiusControl / radiusRow / radiusPopup` (the `--rf`-scaled steps).
7. **Residual classes stay classes.** Anything StyleX cannot express —
   `data-[…]` variants Base UI drives, `group-hover:*`, arbitrary selectors
   `[&…]:`, `has-*`, structural pseudos (`first:`/`last:`), smooth-shadow
   utilities — remains in the `className` string unchanged. They will be
   carried verbatim into `styles/residual.css` at cutover. When an element
   mixes both forms:
   `<div className={cn("data-[popup-open]:bg-raised", open && "hidden")} {...stylex.props(sx.base)}>`.
8. **tailwind-merge conflicts no longer apply across the StyleX boundary.**
   Where a caller could previously override a utility (`cn("px-2",
className)` with `px-3`), the override now has to happen through
   `stylex.props` argument order — flag such spots in your report instead of
   redesigning the API.
9. **Animations**: express keyframes with `stylex.keyframes`; mind that an
   element needing BOTH `animation` and `animationDelay` gets them from ONE
   style entry or carefully ordered composition (delay resets were a
   Tailwind trap; in StyleX last-write-wins per property).
10. **lib/\*-classes.ts constants**: convert each exported constant to a
    `stylex.create` object in the same module and update every consumer IN
    YOUR ASSIGNED FILES ONLY; if a constant is consumed outside your file
    list, leave it and note the cross-file dependency in your report.

## Verification before you commit

- `bun run typecheck` from the repo root passes.
- No `className=` string you touched still contains a convertible Tailwind
  utility (residuals listed in rule 7 excepted).
- Diff review: every removed class's declarations must exist in the new
  style (compare against the compiled sheet if unsure — build it with
  `./node_modules/.bin/tailwindcss -i packages/core/opensession-server/src/frontend/styles/tailwind.css -o /tmp/tw-ref.css`).
- Commit ONLY your assigned files. Message: `Convert <scope> to StyleX`.

Follow the root and frontend AGENTS.md house rules (sentence case, no em
dashes, both widths matter, no new raw colors).
