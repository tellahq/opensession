---
name: opensession-ui
description: Design, build, and visually critique Open Session web UI changes so they match the app's native visual language across desktop, phone, dark, and light themes. Use before writing or modifying any frontend component, dialog, panel, chip, tab, or settings page under packages/core/opensession-server/src/frontend/.
---

# Open Session UI

Open Session has a quiet, native-feeling visual language built on surface elevation, squircle radii, smooth shadows, and restrained chrome. Generic Tailwind/shadcn patterns (outlined cards, heavy `backdrop-blur-md` + `shadow-lg` boxes, guessed `border-border` or `bg-canvas` tokens, `text-[11px]` labels) immediately look foreign.

Follow this workflow for every user-visible web change:

1. **Look before building.** Read the closest existing component on the same surface (or open `/design-system` in a dev/demo instance) and reuse its exact surface, spacing, control height, and primitive.
2. **Use only real tokens and `frontend/ui/` primitives.** Never invent a token name or hand-roll a button, input, tab strip, or overlay.
3. **Build desktop and phone in the same change.** Use `phone:` / `desktop:` (720px boundary), `ResponsiveDialog`, 44px touch targets (`min-h-11`), and `text-input-phone` for inputs.
4. **Run static checks.** `bun scripts/ui-audit.ts` must pass with zero regressions.
5. **Inspect all 4 screenshots and critique them.** Capture desktop + phone × dark + light via `verify-opensession visual-check`, open every PNG with `read`, and run the critique checklist below. If something looks noisy, cramped, or out of place, fix it and re-capture before finishing.

---

## Token cheat sheet (`styles/tailwind.css`)

Every utility below is real and theme-aware across dark and light mode.

### Surfaces (monotonic elevation ramp)
| Token | Role |
|---|---|
| `bg-bg` / `bg-surface` | Page canvas (L0) |
| `bg-raised` / `bg-sidebar` | Chrome behind content: sidebar, top bar (L1) |
| `bg-panel` | Cards, bubbles, tool rows, inset blocks (L2) |
| `bg-panel-surface` | Right-hand side panel column |
| `bg-settings-plate` | Settings group container (only surface paired with `border-divider-soft`) |
| `bg-control` | Filled chips, inputs, option rows (L3) |
| `bg-button` | Pressable control plate |
| `bg-popup` / `bg-popup-glass` | Floating menus, popovers, hover cards (`bg-popup-glass` pairs with `[backdrop-filter:var(--popup-blur)]`) |
| `bg-palette-glass` | Command palette over a dimming scrim |
| `bg-bubble-user` | User prompt bubble wash |
| `bg-code-well` | Code/tool input-output well |

### Interaction washes
- `hover:bg-hover` — translucent hover wash (works on any surface; never use `hover:bg-raised`)
- `bg-pressed` / `active:bg-pressed` — active press wash
- `bg-selected` — persistent selected row (quieter than pressed)
- `bg-active` — opaque track surface (switches, meters, neutral badges)

### Text
- `text-fg` — primary ink
- `text-dim` — secondary labels and metadata
- `text-faint` — tertiary hints, icons, placeholders
- `text-accent` — readable accent ink (never pair raw `bg-accent` with `text-white`; use `text-on-accent`)
- `text-link` — inline links inside prose
- Status ink + soft fills: `text-green` / `bg-green-soft`, `text-yellow` / `bg-yellow-soft`, `text-blue` / `bg-blue-soft`, `text-red` / `bg-red-soft`, `text-purple`

### Borders and dividers (the word is `line` / `divider`, NEVER `border-border`)
- `border-line` — control edges, input borders, dividers between rows
- `border-line-strong` — hovered/emphasized control border
- `border-divider` / `bg-divider` — chrome seams (top bar, sidebar edge, panel header, hairline rules)
- `border-divider-soft` — quiet outline on `bg-settings-plate` only

### Type scale (auto-promotes on phone — never write `text-[Npx]`)
| Class | Desktop / Phone | Use |
|---|---|---|
| `text-meta` | 11 / 13 | Timestamps, counts, badges |
| `text-label` / `text-supporting` / `text-xs` / `text-sm` | 13 / 14 | Control labels, helper copy |
| `text-item-title` | 14 / 15 | Scannable row titles |
| `text-body` / `text-base` | 15 / 17 | Reading prose |
| `text-dialog-title` | 17 / 19 | Modal / sheet / overlay headings |
| `text-section-title` | 19 / 24 | Section headings inside a page |
| `text-page-title` | 24 / 28 | Page title (pair with `font-title`, not `font-semibold`) |
| `text-stat` | 28 / 34 | Metric display figures |
| `text-input-phone` | 16 / 17 | Phone text inputs (prevents iOS zoom) |

### Radii (all `rounded-*` are squircles except `rounded-full`)
- `rounded-sm` (4) — badges, compact tags
- `rounded-md` (7) — inline code, small chips
- `rounded-xs` (2) — keycaps, hairline chips
- `rounded-control` (12) — inputs, selects, selectable list rows
- `rounded-lg` (14) — segmented tracks, medium panels, tooltips
- `rounded-popup` (16) — floating popovers, menus, PiP/hover cards
- `rounded-xl` (18) — cards (`Card`)
- `rounded-2xl` (22) — card containers (`SettingCard`, dialogs)
- `rounded-[999px]` — squircle pill; `rounded-full` — true pill/circle (`Button`, avatars, dots)
- Keep nested corners concentric: `inner radius + padding ≈ outer radius`.

### Shadows (NEVER use stock Tailwind `shadow-sm` / `shadow-md` / `shadow-lg`)
- `smooth-shadow-xs` — controls resting in the page (toolbar buttons, filter chips)
- `smooth-shadow-sm` — compact floating controls (pills, segmented knob)
- `smooth-shadow-md` / `smooth-shadow-ring-md` — menus, popovers, floating cards
- `smooth-shadow-lg` / `smooth-shadow-ring-lg` — modals, palettes, large overlays
- The `smooth-shadow-ring-*` tiers already include a 1px theme-resolved hairline ring. **Never add `border` or `ring-*` on top of a `smooth-shadow-ring-*` element.**

---

## StyleX primitives (`ui/tokens.stylex.ts`)

Primitives in `ui/` are moving to StyleX (see `docs/design-system.md`); `Button` is the first. When writing or porting one:

- Import every value from `ui/tokens.stylex.ts`: `color.*`, `space.s<px>`, `controlHeight.sm/md/lg/touch`, `radius.*`, `text.*`, `weight.*`, `opacity.*`, `focus.*`, `motion.*`, `shadow.*`, `media.*`. A raw `31`, `"9px"` or `"#fff"` inside `stylex.create` fails `stylex-raw-value`.
- Gate hover behind `media.hover` (`":hover": { default: null, [media.hover]: value }`), as Tailwind's `hover:` does.
- Expose `xstyle?: StyleXStyles<{ margin…, flex…, width… }>` for placement only, and keep merging a caller's `className` last while call sites migrate.
- Prove parity: dump computed styles of every instance on the same routes against `main` (both widths, both themes) and diff them before calling a port done.

On a `<Button>`, place it with `xstyle` and pick its look with `variant` / `size`. Visual utilities on `<Button className>` are counted by `button-restyle`.

---

## Never write these (caught by `bun scripts/ui-audit.ts`)

| Don't write | Write instead |
|---|---|
| `border-border`, `border-border-subtle`, `border-border-strong` | `border-line`, `border-divider`, `border-divider-soft`, `border-line-strong` |
| `bg-canvas`, `bg-background`, `bg-card`, `bg-muted` | `bg-surface` / `bg-bg`, `bg-panel`, `bg-raised`, `bg-hover` |
| `text-foreground`, `text-muted-foreground`, `text-secondary` | `text-fg`, `text-dim`, `text-faint` |
| `text-title`, `text-input`, `text-[11px]` | `text-dialog-title`, `text-body` / `text-input-phone`, `text-meta` |
| `bg-zinc-900`, `text-slate-400`, `border-gray-200`, `bg-[#...]` | Semantic tokens from `styles/tailwind.css` |
| `shadow-sm`, `shadow-md`, `shadow-lg` | `smooth-shadow-sm`, `smooth-shadow-md`, `smooth-shadow-ring-md`, `smooth-shadow-lg` |
| Raw `<button>`, `<input>`, `<textarea>`, `<select>`, `fixed inset-0` | `Button`, `Input`, `Textarea`, `Select`, `Modal` / `ResponsiveDialog` |

---

## Primitive picker (`packages/core/opensession-server/src/frontend/ui/`)

Search `ui/` before creating anything new:

- **Actions**: `Button` (`ui/button.tsx`) — variants `default`, `primary`, `soft`, `ghost`, `overlay`, `success`, `danger`, `warning`, `danger-strong`, `success-strong`; sizes `sm` / `md` / `lg`; supports `icon`, `caret`, `trailing`, `render={<a />}`.
- **State labels (non-interactive)**: `Badge` (`ui/badge.tsx`) — tones `neutral`, `accent`, `success`, `warning`, `danger`, `info`; `soft` (default) or `outline`, optional `dot`. Never use a badge for a clickable control.
- **Containers**: `Card` / `CardList` (`ui/card.tsx`, always borderless); `SettingCard` / `SettingGroup` / `SettingsHeader` / `SettingsGroupLabel` (`ui/settings.tsx`); `SettingRow` / `SwitchRow` / `ValueRow` (`ui/setting-row.tsx`).
- **Page shell**: `PageLayout` / `PageSection` (`ui/page.tsx`) + `PageHeader` / `PageTitle` / `PageDescription` (`ui/page-header.tsx`).
- **Switching / navigation**:
  - 2–4 short exclusive setting options → `Segmented` + `SegmentedOption` (`ui/segmented.tsx`)
  - Page views sitting on a divider → `UnderlineTabs` (`ui/tabs.tsx`)
  - Side-panel views with icons/attention dots → `PlateTabs` (`ui/tabs.tsx`)
  - Long option lists → `Select` (`ui/select.tsx`) or `Menu` (`ui/menu.tsx`)
- **Forms**: `Input`, `Textarea`, `Field` (`ui/input.tsx`), `Switch` (`ui/switch.tsx`), `Checkbox` (`ui/checkbox.tsx`), `Radio` (`ui/radio.tsx`).
- **Overlays**: `ResponsiveDialog` / `BottomSheet` (`ui/sheet.tsx` — modal on desktop, bottom sheet on phone), `Modal` (`ui/modal.tsx`), `Popover` (`ui/popover.tsx`), `Menu` (`ui/menu.tsx`), `Tooltip` (`ui/tooltip.tsx`), `Confirm` (`ui/confirm.tsx`).
- **Async states**: `EmptyState`, `LoadingState`, `Alert`, `ListSkeleton`, `TranscriptSkeleton` (`ui/state.tsx`).
- **Icons**: `components/icons.tsx` only (iconic-pro 24px grid, shared `stroke` object). Never inline raw `<svg>` icons.

---

## Visual taste rules

- **No bordered cards.** A `bg-panel` block on `bg-surface` is already separated by fill and radius. Adding `border border-line` turns the page into a noisy wireframe form.
- **No double-edges on floating surfaces.** Floating popups/cards use `bg-popup` or `bg-popup-glass [backdrop-filter:var(--popup-blur)]` + `[--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-md` — no extra `border`.
- **Match neighboring chrome.** New elements should sit quietly at the same density, corner radius, and ink weight as the surface they join. If you're pinning or summarizing an existing object (e.g. a user bubble, a tab strip, a PR chip), echo that object's surface rather than inventing a new floating box.
- **Align headings to content, not outer edges.** A section label over a card or list shares the x-coordinate of the text inside the rows below it (`px-5` on `SettingsGroupLabel` matches `SettingRow`'s `px-5`).
- **Use `font-title` on headings** (500 in dark, 600 in light) so dark mode headings don't read overly heavy.
- **Copy is short, direct, sentence case, no em dashes.**

---

## Mandatory verification and visual critique loop

Do **not** use `bun scripts/capture-ui.ts` against default port `3850` for uncommitted changes — port `3850` serves the immutable live release, not your worktree.

Instead, use the isolated demo instance from `.agents/skills/verify-opensession/`:

```bash
export RUN_ID="ui-$(date +%Y%m%d-%H%M%S)-$$"
./.agents/skills/verify-opensession/bin/verify-opensession launch "$RUN_ID"
./.agents/skills/verify-opensession/bin/verify-opensession doctor "$RUN_ID"

# Capture all 4 frames (desktop + phone × dark + light)
./.agents/skills/verify-opensession/bin/verify-opensession visual-check "$RUN_ID" \
  --route /your-route --prefix feature-after
```

Need a live reference for how Open Session primitives look? Open `/design-system` on the same isolated run:

```bash
./.agents/skills/verify-opensession/bin/verify-opensession visual-check "$RUN_ID" \
  --route /design-system --prefix design-system --full-page
```

After capturing, **open all 4 PNGs with the `read` tool** and run this critique before finishing:

1. **Theme parity (dark & light):** Are surfaces monotonically lifted in both themes? Does anything look muddy, invisible, washed out, or harshly outlined in light mode or dark mode?
2. **No accidental borders / double rings:** Did any card, tile, or floating element pick up a harsh `currentColor` border or a border on top of a `smooth-shadow-ring-*`?
3. **Alignment & rhythm:** Do headings line up with the content below them? Are row baselines, icon centers, and gap rhythm consistent with neighboring UI?
4. **Concentric corners:** Do inner elements have smaller radii than their container (`inner + padding ≈ outer`)? Are pills/cards squircles rather than mismatched sharp rectangles?
5. **Hierarchy & quietness:** Does the new element blend into its surrounding surface instead of shouting with excess elevation, bright borders, or extra wrapper boxes?
6. **Phone layout (390×844):** Are touch targets at least 44px? Is there zero horizontal overflow, awkward wrapping, or clipped text? Is there a clear way to dismiss dialogs/sheets?
7. **Interactive states:** If the feature has empty, loading, error, hover, or open-menu states, capture and check those too.

If any item fails, fix it, re-capture, and re-inspect. Run `cleanup "$RUN_ID"` when finished and include the before/after proof (`OPENSESSION_COMPARE` / `OPENSESSION_IMAGE` + `publish_walkthrough`).
