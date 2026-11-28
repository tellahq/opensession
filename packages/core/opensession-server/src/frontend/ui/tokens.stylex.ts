/**
 * The design system's decisions, as the only values StyleX code may use.
 *
 * Every scale here is closed on purpose. A primitive that needs a size, a
 * colour or a corner picks one of these by name; there is no escape hatch for
 * "just this once 31px", because each of those is how the app ended up with
 * 39 control heights and 30 horizontal paddings. `bun scripts/ui-audit.ts`
 * rejects a raw length or colour inside `stylex.create` anywhere but this file.
 * See docs/design-system.md for the reasoning behind each scale.
 *
 * Colours and type are thin names over the theme properties in
 * styles/base-theme.css. They are `defineConsts`, not `defineVars`: StyleX
 * inlines them, so `var(--text)` still resolves wherever an ancestor re-points
 * `--text` (the side panel's plate, a popup's inverted surface), the way the
 * Tailwind tokens do. Light and dark keep switching in base-theme.css.
 */
import * as stylex from "@stylexjs/stylex";

/** Surface, ink, edge and status colours. Same roles as the Tailwind tokens. */
export const color = stylex.defineConsts({
  // Surfaces, L0 to L3.
  page: "var(--bg)",
  raised: "var(--bg-raised)",
  panel: "var(--bg-panel)",
  control: "var(--control-surface)",
  button: "var(--button-surface)",
  popup: "var(--popup-surface)",
  /** The popup surface held up to the light: translucent where the platform
   *  can blur behind it, solid where it cannot. */
  popupGlass: "var(--popup-glass)",
  popupRing: "var(--popup-ring)",
  // Interaction washes: translucent ink, so one value reads on any surface.
  hover: "var(--hover)",
  pressed: "var(--hover-strong)",
  selected: "var(--selected)",
  /** Opaque track surface: switches, meters, neutral badges. */
  active: "var(--bg-active)",
  // Ink.
  fg: "var(--text)",
  dim: "var(--text-dim)",
  faint: "var(--text-faint)",
  link: "var(--link)",
  // Edges.
  line: "var(--border)",
  lineStrong: "var(--border-strong)",
  divider: "var(--divider)",
  // Accent.
  accent: "var(--accent)",
  accentHover: "var(--accent-hover)",
  accentInk: "var(--accent-ink)",
  accentSoft: "var(--accent-soft)",
  onAccent: "var(--on-accent)",
  // Status ink and their soft plates.
  green: "var(--green)",
  greenSoft: "var(--green-soft)",
  yellow: "var(--yellow)",
  yellowSoft: "var(--yellow-soft)",
  red: "var(--red)",
  redSoft: "var(--red-soft)",
  blue: "var(--blue)",
  blueSoft: "var(--blue-soft)",
  /** A tone chip: a quarter of the hue over the control surface, solid on
   *  any page (Tailwind's `bg-tone-*`). Hovering deepens the chip's ink. */
  toneGreen: "color-mix(in srgb, var(--green) 24%, var(--control-surface))",
  toneYellow: "color-mix(in srgb, var(--yellow) 24%, var(--control-surface))",
  toneRed: "color-mix(in srgb, var(--red) 24%, var(--control-surface))",
  toneBlue: "color-mix(in srgb, var(--blue) 24%, var(--control-surface))",
  tonePurple: "color-mix(in srgb, var(--purple) 24%, var(--control-surface))",
  toneHover: "color-mix(in srgb, currentColor 34%, var(--control-surface))",
  // Ink on a dark media scrim, where the theme does not apply.
  onScrim: "#fff",
  /** Ink on a solid red or yellow plate (a phone row's swipe actions). */
  onRed: "#fff",
  onYellow: "#17130a",
  transparent: "transparent",
  /** The sidebar's hover wash pre-composited onto its surface: an action
   *  chip floating on a hovered row (see base.css). */
  rowChip: "var(--row-chip)",
  current: "currentColor",
  /** A switch knob: white on every track, in both themes. */
  knob: "#fff",
  /** The "on" fill of a switch, checkbox or radio. Two accents (white and
   *  yellow) swap it for blue, where the accent itself reads as off. */
  accentControl: "var(--accent-control, var(--accent))",
  onAccentControl: "var(--on-accent-control, var(--on-accent))",
  panelSurface: "var(--panel-surface)",
  /** A palette: denser glass than a menu, since it sits over a scrim. */
  /** The hairline a shell on a scrim needs: firmer than a menu's. */
  dialogRing: "var(--dialog-ring)",
  /** The dimming under a dialog, and the lighter one under a glass palette
   *  (the palette composites the scrim through its own fill). */
  scrim: "rgb(0 0 0 / 0.25)",
  scrimLight: "rgb(0 0 0 / 0.22)",
  /** The heavier dimming under a bottom sheet or sheet-style dialog. */
  scrimSheet: "rgb(0 0 0 / 0.45)",
  /** Opaque ink for a mask gradient: only its alpha matters. */
  mask: "#000",
  purple: "var(--purple)",
  tooltip: "var(--tooltip-bg)",
  tooltipFg: "var(--tooltip-fg)",
  segmentedKnob: "var(--segmented-knob-surface)",
  segmentedKnobEdge: "var(--segmented-knob-edge)",
  /** A settings group's plate: lighter than `raised`, held by a soft edge. */
  settingsPlate: "var(--settings-plate)",
  settingsPlateEdge: "var(--settings-plate-edge)",
  settingsCanvas: "var(--settings-canvas)",
  settingsNav: "var(--settings-nav)",
  /** `line` at a third: closes a block's shape without reading as a rule. */
  dividerSoft: "var(--divider-soft)",
  /** A control over an image: white in both themes. */
  overlaySurface: "#fff",
  /** The app's chrome column (sidebar, and the phone top bar at rest). */
  sidebar: "var(--sidebar-bg)",
  /** The phone top bar's floating controls: a thinned fill, its edge. */
  headerControl: "var(--mobile-header-control-surface)",
  headerControlEdge: "var(--mobile-header-control-border)",
});

/**
 * Control heights. Four on desktop and one touch target: a control is 26
 * (chips, inline actions), 32 (the default), 36 (a page's primary row) or 40
 * (a tile on the new layout's minibar), and anything a finger operates on a
 * phone is 44. Nothing in between.
 */
export const controlHeight = stylex.defineConsts({
  sm: "26px",
  md: "32px",
  lg: "36px",
  xl: "40px",
  touch: "44px",
});

/**
 * Spacing, in px. A 2px step up to 16, then 4px, then 8px. The name is the
 * value, so a review can see what was picked. Odd values (3, 5, 7, 9, 11,
 * 13) are not on the scale: they are a 1px nudge standing in for a decision.
 */
export const space = stylex.defineConsts({
  s0: "0px",
  s2: "2px",
  s4: "4px",
  s6: "6px",
  s8: "8px",
  s10: "10px",
  s12: "12px",
  s14: "14px",
  s16: "16px",
  s20: "20px",
  s24: "24px",
  s32: "32px",
  s40: "40px",
  s48: "48px",
});

/**
 * Corner radii, chosen by the size of the box. Each scales with `--rf`, so a
 * browser with `corner-shape: squircle` draws them 1.35x larger. `pill` is a
 * true circle at the ends and opts out of the squircle; there is no other
 * escape. A child inside a rounded parent takes parent radius minus padding.
 */
export const radius = stylex.defineConsts({
  xs: "calc(2px * var(--rf))",
  sm: "calc(4px * var(--rf))",
  md: "calc(7px * var(--rf))",
  control: "calc(12px * var(--rf))",
  lg: "calc(14px * var(--rf))",
  popup: "calc(16px * var(--rf))",
  /** A row inside a popup: the popup's corner minus its 6px padding, so the
   *  lit row's corner runs concentric with the popup's. */
  popupRow: "calc(10px * var(--rf))",
  xl: "calc(18px * var(--rf))",
  xxl: "calc(22px * var(--rf))",
  pill: "calc(infinity * 1px)",
  /** A bottom sheet's top corners, which a surface can override through
   *  `--sheet-radius`. */
  sheet: "calc(var(--sheet-radius, 34px) * var(--rf))",
  /** A pill that keeps the squircle (Tailwind's `rounded-capsule`). */
  capsule: "999px",
  /** The composer's own corner (base-theme.css). */
  composer: "var(--composer-radius)",
  /** The new layout's tab and pane corners: round, unscaled. */
  tab: "8px",
  pane: "10px",
});

/**
 * The corner shape every radius except `pill` takes: `squircle` where the
 * browser supports it, plain `round` elsewhere (base-global.css sets `--cs`).
 * Tailwind gets the same through `[class*="rounded-"]`; StyleX elements carry
 * no such class, so they ask for it.
 */
export const corner = stylex.defineConsts({
  squircle: "var(--cs)",
});

/**
 * Type roles. Pick by purpose, not by nearest number. Each promotes one rung
 * at phone width through base-theme.css, so no call site writes a phone size.
 */
export const text = stylex.defineConsts({
  meta: "var(--type-meta)",
  label: "var(--type-label)",
  itemTitle: "var(--type-item-title)",
  body: "var(--type-body)",
  dialogTitle: "var(--type-dialog-title)",
  sectionTitle: "var(--type-section-title)",
  pageTitle: "var(--type-page-title)",
  stat: "var(--type-stat)",
  /** A lone emoji that is the whole illustration of a screen. */
  glyphHero: "2.25rem",
  inputPhone: "var(--type-input-phone)",
});

/**
 * Line heights, as unitless ratios. `label` is every single-line control
 * label (buttons, chips, tabs): 18.6px on a 13px label, 21.4px on a 15px one.
 */
export const leading = stylex.defineConsts({
  label: "calc(1.25 / 0.875)",
  /** One line exactly the size of the type: a single-line input centred in
   *  its box. */
  none: "1",
  /** Running text: a textarea, a description. */
  body: "1.5",
  /** Headings: a dialog title. */
  tight: "1.25",
  /** Supporting prose under a heading. */
  relaxed: "1.625",
  /** A tooltip's line, a little tighter than running text. */
  snug: "1.375",
  /** `text.glyphHero`'s own line. */
  hero: "calc(2.5 / 2.25)",
  /** A compact title, or a line of metadata pinned under one. */
  title: "1.1",
  /** A field's small step, which keeps Tailwind's `text-xs` leading. */
  small: "calc(1 / 0.75)",
});

/**
 * Weights. Medium is the app's regular; metadata and supporting copy drop to
 * regular; headings take `title` (500 in dark, 600 in light). Semibold and
 * bold are for prose emphasis, not chrome.
 */
/** Font families: the app's own stack is inherited, so only the exceptions
 *  are named. */
export const font = stylex.defineConsts({
  mono: "var(--mono)",
});

/** Letter spacing. `tight` pulls small bold labels together a hair. */
export const tracking = stylex.defineConsts({
  tight: "-0.01em",
  /** A page's own title. */
  title: "-0.02em",
  /** A stamped word in capitals' spirit, spaced out. */
  wide: "0.025em",
});

export const weight = stylex.defineConsts({
  regular: "400",
  medium: "500",
  /** The selected underline tab, and emphasis inside prose. */
  strong: "600",
  /** A code to read out and type elsewhere. */
  bold: "700",
  /** Group labels and section kickers. */
  heading: "600",
  title: "var(--title-weight)",
});

/** The few opacities that mean something. */
export const opacity = stylex.defineConsts({
  disabled: "0.4",
  /** A supporting glyph beside a label on a neutral control, and the
   *  trailing chevron of a menu trigger. */
  glyphMuted: "0.6",
  /** The same glyph on a tinted or solid plate, where 0.6 reads as dirt. */
  glyphOnTone: "0.8",
  /** A trailing glyph that only firms up under the pointer. */
  glyphResting: "0.45",
  /** A day outside the range a calendar allows. */
  outOfRange: "0.45",
  /** The body under an alert's title, a step behind it. */
  secondary: "0.9",
  /** A glass control in the phone top bar under the thumb, and a segment of
   *  a grouped one (thinner, as the capsule around it stays put). */
  pressedGlass: "0.4",
  pressedSegment: "0.35",
  /** Text that is itself the tap target (the session title) while pressed. */
  pressedText: "0.6",
});

export const motion = stylex.defineConsts({
  ease: "var(--ease)",
  micro: "var(--dur-micro)",
  /** Whole-control press tick. */
  pressScale: "0.96",
  /** The desk popping open from its launcher (Tailwind `duration-pop`,
   *  `scale-pop`). */
  pop: "100ms",
  popScale: "0.9",
  /** A sliding indicator (the underline under a tab). */
  slide: "200ms",
  easeOut: "cubic-bezier(0, 0, 0.2, 1)",
  /** One turn of a progress spinner. */
  spin: "1s",
  /** Spatial changes that cross the screen: a sheet sliding up. */
  long: "var(--dur-lg)",
  /** A dialog's enter and exit, a step slower than a control's. */
  standard: "var(--dur)",
  /** A palette drops in from just above its resting place. */
  paletteDrop: "0 -6px",
  paletteScale: "0.99",
  /** A dialog pops in from a touch smaller, and leaves a touch less so. */
  dialogEnterScale: "0.96",
  dialogExitScale: "0.97",
  /** A popup's enter and exit. */
  popup: "120ms",
  /** One breath of a liveness dot. */
  pulse: "1.4s",
  /** A waiting dot breathes a touch quicker: it is asking for someone. */
  pulseWaiting: "1.2s",
  /** How far a popup or tooltip grows into place. */
  popupScale: "0.97",
  /** A pressed plate that gives slightly, less than a button does. */
  pressPlateScale: "0.98",
  tooltipScale: "0.96",
  /** A skeleton's slow breath, and how long it holds back before showing. */
  breath: "2s",
  breathEase: "cubic-bezier(0.4, 0, 0.6, 1)",
  ghostDelay: "180ms",
  /** A toast settling into its stack: a long, soft ease-out. */
  toastEase: "cubic-bezier(0.23, 1, 0.32, 1)",
  /** How far a toast rises and grows as it arrives and leaves. */
  toastDrop: "0 8px",
  toastScale: "0.96",
});

/** The one keyboard focus treatment: a 2px accent-ink ring, 2px out. */
export const focus = stylex.defineConsts({
  ring: "2px solid var(--accent-ink)",
  offset: "2px",
  /** Inside a list or track that clips: the ring draws on the box's edge. */
  insetOffset: "-2px",
});

/**
 * Elevation, the same tiers as styles/smooth-shadow.css. Never a stock
 * shadow, and never a border on top of a ring tier: the ring IS the edge.
 * The shadow ink follows `--tw-shadow-color` and the ring follows
 * `--smooth-ring-color` / `--smooth-ring-width`, so a surface can re-tint
 * either the way it could with the utilities.
 */
export const shadow = stylex.defineConsts({
  /** The glow around a status dot that needs a person: failed, waiting. */
  glowRed: "0 0 6px var(--red)",
  glowBlue: "0 0 6px var(--blue)",
  /** A status dot's or a focused field's soft 3px ring in its tone
   *  (Tailwind's `shadow-halo-*`). */
  haloGreen: "0 0 0 3px var(--green-soft)",
  haloRed: "0 0 0 3px var(--red-soft)",
  haloAccent: "0 0 0 3px var(--accent-soft)",
  /** A lane lit up as a drop target. */
  dropRing: "inset 0 0 0 1px var(--accent, #6b8afd)",
  xs: "0 1px 2px -1px color-mix(in srgb, var(--tw-shadow-color, black) 5%, transparent), 0 2px 5px -3px color-mix(in srgb, var(--tw-shadow-color, black) 7%, transparent)",
  sm: "0 1px 3px -1px color-mix(in srgb, var(--tw-shadow-color, black) 6%, transparent), 0 4px 10px -4px color-mix(in srgb, var(--tw-shadow-color, black) 9%, transparent)",
  ringSm:
    "0 1px 3px -1px color-mix(in srgb, var(--tw-shadow-color, black) 6%, transparent), 0 4px 10px -4px color-mix(in srgb, var(--tw-shadow-color, black) 9%, transparent), 0 0 0 var(--smooth-ring-width, 1px) color-mix(in srgb, var(--smooth-ring-color) 80%, transparent)",
  md: "0 2px 6px -2px color-mix(in srgb, var(--tw-shadow-color, black) 5%, transparent), 0 10px 28px -8px color-mix(in srgb, var(--tw-shadow-color, black) 10%, transparent)",
  ringMd:
    "0 2px 6px -2px color-mix(in srgb, var(--tw-shadow-color, black) 5%, transparent), 0 10px 28px -8px color-mix(in srgb, var(--tw-shadow-color, black) 10%, transparent), 0 0 0 var(--smooth-ring-width, 1px) color-mix(in srgb, var(--smooth-ring-color) 65%, transparent)",
  lg: "0 4px 12px -4px color-mix(in srgb, var(--tw-shadow-color, black) 5%, transparent), 0 18px 48px -14px color-mix(in srgb, var(--tw-shadow-color, black) 11%, transparent)",
  ringLg:
    "0 4px 12px -4px color-mix(in srgb, var(--tw-shadow-color, black) 5%, transparent), 0 18px 48px -14px color-mix(in srgb, var(--tw-shadow-color, black) 11%, transparent), 0 0 0 var(--smooth-ring-width, 1px) color-mix(in srgb, var(--smooth-ring-color) 50%, transparent)",
  /** A bottom sheet's drop shadow, cast upward. */
  sheet: "0 -12px 40px rgba(0, 0, 0, 0.35)",
  /** The seam under a sticky bar once content scrolls beneath it. */
  stickySeam: "inset 0 -1px 0 var(--divider)",
  /** The tooltip chip: a soft drop plus its own ring colour. */
  tooltip:
    "0px 10px 38px -10px rgba(14, 18, 22, 0.35), 0px 10px 20px -15px rgba(14, 18, 22, 0.2), 0 0 0 1px var(--tooltip-ring)",
  /** The switch knob: a tight contact shadow plus a hairline, on white. */
  knob: "0 1px 3px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(0, 0, 0, 0.07)",
  /** Top-down shading that gives a solid plate a face (Tailwind's `plate-sheen`). */
  plateSheen:
    "linear-gradient(to bottom, transparent, rgb(255 255 255 / 0.035) 35%, rgb(255 255 255 / 0.01) 55%, rgb(0 0 0 / 0.05))",
  /** The forced-colors stand-in for a ring tier, which Windows High Contrast
   *  strips along with every box-shadow. */
  ringForced: "var(--smooth-ring-width, 1px) solid CanvasText",
  /** A floating control in the phone top bar. */
  headerControl: "var(--mobile-header-control-shadow)",
  /** A card lifted off the page while you handle it (the swipe decks). */
  lifted:
    "0 3px 10px -3px color-mix(in srgb, var(--tw-shadow-color, black) 4%, transparent), 0 20px 56px -16px color-mix(in srgb, var(--tw-shadow-color, black) 12%, transparent)",
  ringForcedOffset: "calc(-1 * var(--smooth-ring-width, 1px))",
});

/**
 * Fixed control geometry measured off a native reference rather than picked
 * from the scales. The switch is macOS 26's NSSwitch: a 54x24 track with a
 * 2px inset and a 32x20 capsule knob; `sm` is the same switch at 44x20.
 */
export const geometry = stylex.defineConsts({
  /**
   * How far a hit area reaches past a control to make it 44px tall (the
   * phone touch target), as a top/bottom inset on an absolute ::after inside
   * it. Never positive, so a taller control keeps its own box.
   */
  touchBleed: "min(0px, calc((100% - 44px) / 2))",
  switchTrackW: "54px",
  switchTrackH: "24px",
  switchThumbW: "32px",
  switchThumbH: "20px",
  switchTravel: "18px",
  switchTrackWSm: "44px",
  switchTrackHSm: "20px",
  switchThumbWSm: "26px",
  switchThumbHSm: "16px",
  switchTravelSm: "14px",
  /** Checkbox and radio box, and the check glyph inside it. */
  checkBox: "16px",
  checkGlyph: "12px",
  radioDot: "6px",
  /** A floating list: never narrower than a short label plus its glyph, and
   *  never taller than the room the positioner reports. */
  popupMinWidth: "220px",
  popupMaxHeight: "min(60dvh, 420px, var(--available-height))",
  /** On a phone a row is a 44px finger target, so a menu gets most of the
   *  screen before it scrolls. */
  popupMaxHeightPhone: "min(80dvh, var(--available-height))",
  /** A menu with a docked footer gets more room, since the footer does not
   *  scroll with the list. */
  popupMaxHeightFooter: "min(80dvh, 560px, var(--available-height))",
  /** A popover's pointer: a 10px square on its point, hanging half off
   *  the edge (one pixel less on the right, where the hairline sits). */
  arrow: "10px",
  arrowHang: "-6px",
  arrowHangRight: "-5px",
  /** The widest a tooltip runs before it truncates, or wraps when it is
   *  multiline. */
  tooltipMax: "280px",
  tooltipMaxMultiline: "360px",
  tooltipMaxHeight: "50vh",
  /** Room for ascenders and descenders around a cap-trimmed line that also
   *  clips (a truncating tooltip label): padded in, margined back out. */
  inkRoom: "0.3em",
  /** A key cap inside a tooltip. */
  keyCap: "16px",
  keyCapPad: "3px",
  /** The centered dialog: most of a phone's width, ~28rem on a desktop,
   *  and never taller than the viewport leaves room for. */
  dialogWidth: "90vw",
  dialogMaxWidth: "28rem",
  dialogMaxHeight: "85dvh",
  /** A palette, and how far below the top it rests (less on a short
   *  window). */
  paletteWidth: "min(820px, 100%)",
  paletteTop: "11vh",
  paletteTopNarrow: "7vh",
  /** A bottom sheet stops short of the top, and its sheet-style desktop
   *  dialog is a little wider than a modal's. */
  sheetMaxHeight: "94dvh",
  sheetDialogWidth: "92vw",
  sheetDialogMaxWidth: "30rem",
  sheetDialogMaxHeight: "85vh",
  /** The grabber pill at the top of a bottom sheet. */
  grabberWidth: "36px",
  grabberHeight: "5px",
  /** An iOS action-sheet row: a 13px icon gap and 15px of block padding. */
  sheetRowGap: "13px",
  sheetRowPad: "15px",
  /** A surface as tall as the dynamic viewport. */
  fullHeight: "100dvh",
  /** The safe areas a full-height surface keeps clear of. */
  safeTop: "env(safe-area-inset-top)",
  safeBottom: "env(safe-area-inset-bottom)",
  /** A liveness dot: the chat's busy row, standalone, and inline in text or
   * a pill. */
  dotLarge: "9px",
  dot: "8px",
  dotInline: "7px",
  /** The fade at the end of a clipped single line. */
  fadeEdge: "24px",
  /** Page column widths. */
  pageNarrow: "760px",
  pageDefault: "860px",
  pageWide: "920px",
  /** A lone card set in a column (Tailwind `max-w-card`). */
  card: "560px",
  /** A page's own padding, and the gaps under its header and filters. These
   *  sit off the spacing scale on purpose for now; folding them in is an
   *  open decision (docs/design-system.md). */
  pageTop: "28px",
  pageBottom: "60px",
  pageTopNarrow: "18px",
  pageHeaderGap: "22px",
  pageFiltersGap: "18px",
  /** The Running pill's block padding. */
  pillPadBlock: "3px",
  /** A device code's letter spacing, handed back after the last letter so
   *  the code stays centred. */
  codeTracking: "0.14em",
  codeTrackingBack: "-0.14em",
  /** Half a pixel down: a word reads a touch high at the geometric centre. */
  opticalNudge: "0 0.5px",
  /** A data grid's widest header label and widest cell before truncating. */
  gridHeaderMax: "320px",
  gridCellMax: "420px",
  /** A divider rule. */
  hairline: "1px",
  /** A select's popup is never narrower than its trigger. */
  anchorWidth: "var(--anchor-width)",
  /** A searchable list: room for a query even off a narrow trigger. */
  searchPopupMinWidth: "max(var(--anchor-width), 16rem)",
  /** The tick column on a selectable row, the glyph's own box. */
  tick: "17px",
  /** A row's leading glyph. */
  rowIcon: "16px",
  /** A settings page's reading column. */
  settingsColumn: "720px",
  /** The space above a settings group's label: what separates the groups. */
  settingsGroupGap: "36px",
  /** A row's quiet overflow-menu trigger. */
  rowMenuTrigger: "28px",
  /** A status chip's dot. */
  dotSmall: "6px",
  /** A link's underline, clear of descenders. */
  underlineOffset: "2px",
  /** Ghost rows: the padding of the row each one stands in for. */
  ghostCardPadBlock: "11px",
  ghostRowPadBlock: "13px",
  /** The transcript's reading column, and the space between two turns. */
  sessionColumn: "var(--session-col)",
  turnGap: "18px",
  /** A toast: as wide as its message, up to 480px, never past the window. */
  toastMaxWidth: "min(480px, calc(100vw - 32px))",
  toastMaxWidthPhone: "calc(100vw - 24px)",
  toastFrontHeight: "var(--toast-frontmost-height)",
  /** How far each toast behind the front one peeks out, and shrinks. */
  toastStackStep: "8px",
  toastStackShrink: "0.04",
  /** A swipe card's intent stamp, under the card's header. */
  stampInset: "16px",
  stampTop: "64px",
  stampBorder: "2px",
  /** A line of prose under a headline, centred. */
  measureNarrow: "20rem",
  /** The phone top bar: its height (base.css owns it, with the 8px inset its
   *  40px segments assume), and the safe area it clears. */
  headerHeight: "var(--header-h)",
  headerSafeTop: "env(safe-area-inset-top, 0px)",
  headerSafeTopPhone: "max(env(safe-area-inset-top, 0px), 8px)",
  /** The title pill's optical padding: the repo tile's side is tighter, and
   *  the name sits 9px from the tile and 7px from its badges. */
  headerPillPadBlock: "5px",
  headerPillPadStart: "11px",
  headerPillGap: "9px",
  headerTitleGap: "7px",
  /** A grouped bar control's segment: wider than tall, so the target the
   *  thumb meets stays past 44px across. */
  headerSegmentWidth: "52px",
  headerSegmentHeight: "40px",
  /** The middle dot between runs of metadata: glyph geometry, sized so it
   *  lands centred against 11px text. */
  metaDot: "16px",
  /** The model name in the session subtitle gives way before the cost. */
  headerModelMax: "45vw",
  /** The connection dot on the organization mark, and its cut-out ring. */
  logoStatusDot: "10px",
  logoStatusRing: "2px",
  logoStatusOffset: "-2px",
  /** The settings page: its nav column, the air above its content, the
   *  catalog column the Library takes, and the bottom air under a panel. */
  settingsNavWidth: "232px",
  settingsModalMaxWidth: "1440px",
  settingsContentTop: "44px",
  settingsColumnWide: "980px",
  settingsPanelBottom: "88px",
  /** The phone settings sheet: the list's bottom room for the search bar,
   *  the inset of a row's rule (past the glyph), and the search glass's
   *  reach above the bar. */
  settingsSheetListBottom: "72px",
  settingsSheetRuleInset: "54px",
  settingsSheetGlyph: "28px",
  settingsSheetGlassReach: "calc(100% + 30px)",
  /** The desktop titlebar strip, and the shadow on the content's left edge
   *  (`none` in dark). */
  desktopHeaderHeight: "var(--desktop-header-h)",
  contentEdgeShadow: "var(--content-edge-shadow)",
  /** A month grid: 36px day columns, 44px on a phone (still inside 390px). */
  monthWidth: "252px",
  monthWidthPhone: "308px",
});

/** The one breakpoint (720px, inclusive on the phone side) and hover gating. */
/**
 * Stacking layers, bottom to top: base-theme.css `--layer-*`, the same values
 * Tailwind reads as `z-<name>`. A feature that needs a new layer adds it
 * there, named for what it sits above. Inside a component's own stacking
 * context, order siblings with small integers instead. The top two are
 * numbers: through var(), Chrome rounds both to 2147480000, which ties them.
 */
export const layer = stylex.defineConsts({
  /** A sticky bar or a veil over a surface's own content. */
  sticky: "var(--layer-sticky)",
  /** A surface's own floating controls and band headings, over its sticky bars. */
  float: "var(--layer-float)",
  /** The session header's actions, over its title's floats. */
  headerActions: "var(--layer-header-actions)",
  /** The content pane beside the sidebar, and a side panel floating over it. */
  shellPane: "var(--layer-shell-pane)",
  /** Over the shell panes: the sidebar's resize edge, the comments pane, a pane-wide confirm. */
  shellOverlay: "var(--layer-shell-overlay)",
  /** The session tab strip, over the shell overlays it docks beside. */
  tabStrip: "var(--layer-tab-strip)",
  /** App chrome over a pane: the phone header overlay and the composer's menus. */
  chrome: "var(--layer-chrome)",
  /** A phone side panel, a drawer over the chrome. */
  drawer: "var(--layer-drawer)",
  /** A docked call window. */
  dock: "var(--layer-dock)",
  /** A full-screen phone sheet inside the session viewer. */
  sheet: "var(--layer-sheet)",
  /** Development readouts. */
  debug: "var(--layer-debug)",
  /** The voice session controls. */
  voice: "var(--layer-voice)",
  /** A dragged element's ghost. */
  dragGhost: "var(--layer-drag-ghost)",
  /** Notification banners. */
  notice: "var(--layer-notice)",
  /** A small modal's scrim, and a phone filter sheet's. */
  sheetScrim: "var(--layer-sheet-scrim)",
  /** The small modal or phone sheet over that scrim. */
  sheetPopup: "var(--layer-sheet-popup)",
  /** The phone's floating action button. */
  fab: "var(--layer-fab)",
  /** A float anchored to content: a selection's toolbar, a chart's tooltip. */
  inlineFloat: "var(--layer-inline-float)",
  /** A hand-rolled right-click menu. */
  contextMenu: "var(--layer-context-menu)",
  /** A panel you keep open (above the page and its floating triggers). */
  panel: "var(--layer-panel)",
  /** A palette's scrim. */
  paletteScrim: "var(--layer-palette-scrim)",
  /** A palette over its scrim. */
  palette: "var(--layer-palette)",
  /** Toasts, under the modal tier. */
  toast: "var(--layer-toast)",
  /** The modal tier: a dialog's scrim, and full-screen blocking overlays. */
  modalScrim: "var(--layer-modal-scrim)",
  /** A dialog over its scrim. */
  modal: "var(--layer-modal)",
  /** What shows through the lightbox's composer hole. */
  lightboxUnder: "var(--layer-lightbox-under)",
  /** The media lightbox. */
  lightbox: "var(--layer-lightbox)",
  /** The composer riding over the lightbox. */
  lightboxComposer: "var(--layer-lightbox-composer)",
  /** The full-page file drop target. */
  dropTarget: "var(--layer-drop-target)",
  /** A live frame's hole, and the pinned workspace summary's popover, just under floating. */
  frameHole: "2147483646",
  /** The app's top interaction layer: every menu, select, tooltip and hover preview. */
  floating: "2147483647",
  /** A sticky table head over its own rows (local). */
  tableHead: "1",
  /** An action pinned over a preview it belongs to (local). */
  overPreview: "1",
});

/** Backdrop blurs: the faint one under a dialog's scrim, the heavier one
 *  under a palette's. */
export const blur = stylex.defineConsts({
  scrim: "blur(1px)",
  paletteScrim: "blur(6px)",
  /** The phone top bar's glass. base-theme.css swaps the fill when the
   *  browser has no backdrop-filter or the person asks for less transparency. */
  headerControl: "var(--mobile-header-control-blur)",
  /** The phone settings sheet's search bar glass. */
  sheetSearch: "blur(16px) saturate(1.35)",
});

export const media = stylex.defineConsts({
  phone: "@media (max-width: 720px)",
  desktop: "@media (min-width: 721px)",
  hover: "@media (hover: hover)",
  /** A touch-first device: what a pointer would reveal stands instead. */
  touch: "@media (hover: none)",
  forcedColors: "@media (forced-colors: active)",
  /** A short or narrow window that pulls a palette up. */
  narrow: "@media (width < 560px)",
  /** Where a two-column form folds to one. */
  small: "@media (width < 40rem)",
  reducedMotion: "@media (prefers-reduced-motion: reduce)",
});

/**
 * The sidebar's scale. The values the "Compact sidebar" preference swaps live
 * in custom properties set on the rail's root (`SIDEBAR_DENSITY_VARS` in
 * lib/sidebar-classes.ts); a row reads them through the `*Var` entries so one
 * attribute retunes every row. The 22px rail and the 7px gap after it do not
 * move with density: they are the left edge every title shares.
 */
export const sidebarScale = stylex.defineConsts({
  rowPad: "7px",
  rowPadCompact: "4px",
  toolPad: "5px",
  toolPadCompact: "4px",
  lineHeight: "36px",
  lineHeightCompact: "30px",
  caption: "28px",
  captionCompact: "24px",
  bandSlot: "32px",
  bandSlotCompact: "28px",
  groupGap: "14px",
  groupGapCompact: "8px",
  rowAction: "26px",
  rowActionCompact: "24px",
  rail: "22px",
  railGap: "7px",
  rowPadVar: "var(--sidebar-row-pad)",
  captionVar: "var(--sidebar-cap-h)",
  groupGapVar: "var(--sidebar-group-gap)",
  lineHeightVar: "var(--sidebar-line-h)",
  bandSlotVar: "var(--sidebar-band-slot)",
  /** The air between the column's edges and the boxes in it (the pill, the
   *  bands), and the left pad that puts a box's mark back on the rail. */
  navX: "6px",
  navXDesktop: "10px",
  navXVar: "var(--sidebar-nav-x)",
  railPadVar:
    "calc(var(--sidebar-icon-left, 16px) - var(--sidebar-nav-x, 6px))",
  /** The list's top hairline of air, so a first row's pill clears the edge. */
  listTop: "1px",
  /** Headings: the rounded box, a phone heading's taller tap padding, and a
   *  lane caption's tighter gap and phone padding. */
  headerRadius: "calc(10px * var(--rf))",
  headerPadPhone: "11px",
  laneGap: "5px",
  lanePadTopPhone: "9px",
  lanePadBottomPhone: "5px",
  /** A pinned lane caption sits under the band slot; one nested under a repo
   *  band sits a step lower in the stack. */
  laneLayer: "15",
  nestedLaneLayer: "14",
  /** The liveness dot a lane or automation heading leads with. */
  dot: "7px",
  dotOpacity: "0.85",
  /** Rows: a phone row's tap padding, and its left inset onto the 16px
   *  rail (written against `--sidebar-icon-left` so a nested family indents
   *  at phone width too). */
  rowPadPhone: "13px",
  rowInsetPhone: "calc(var(--sidebar-icon-left, 16px) - 12px)",
  /** The right end a row gives up to its chips: 8px of edge plus 30px per
   *  chip, and a standing chip's 44px touch box plus that edge on phones. */
  reserve1: "38px",
  reserve2: "68px",
  reserve3: "98px",
  reserve4: "128px",
  reserveStandingPhone: "52px",
  /** A row title: its leading, and where its trailing fade starts. */
  titleLeading: "1.35",
  titleFade: "calc(100% - 24px)",
  /** A row's hover chip: its density-following box, the glyph metric inside
   *  it, and the two slots it takes (the row's edge, and one chip in from
   *  it plus the 4px between them). */
  rowActionVar: "var(--sidebar-row-action, 26px)",
  chipGlyph: "15px",
  chipEdge: "7px",
  chipSecond: "calc(var(--sidebar-row-action, 26px) + 11px)",
  touchTarget: "44px",
  /** A row's trailing time, ticker and facepile. */
  timeMin: "28px",
  timeMinDesktop: "34px",
  faceOverlap: "-6px",
  faceRing: "var(--sidebar-bg)",
  faceRingHover: "var(--sidebar-row-hover)",
  faceRingSelected: "var(--sidebar-row-selected)",
  faceRingSelectedHover: "var(--sidebar-row-selected-hover)",
  /** A phone row's swipe action: as wide as the drag has pulled it. */
  swipeActionWidth: "var(--swipe-action-w, 82px)",
  /** A lane that would take a drop but holds nothing yet. */
  laneEmpty: "0.55",
  /** A pinned entry being dragged rides above its neighbours. */
  dragLayer: "5",
  /** The urgent count on a band: a glyph metric, and the line it centres on. */
  attnText: "10px",
  attnLeading: "16px",
  /** An automation's runs indent their marks one step past the heading's. */
  nestedIconLeft: "28px",
  /** Band headings: the toggle's corner, the filter button's box, and the
   *  dot that marks a set filter (inset from the button's corner). */
  bandRadius: "calc(8px * var(--rf))",
  bandAction: "28px",
  filterDot: "6px",
  filterDotInset: "5px",
  /** The Workspaces header's icon buttons and their glyph metric, stepped up
   *  on phones where the whole sidebar is a tap surface. */
  headerButton: "34px",
  headerButtonPhone: "38px",
  headerGlyph: "20px",
  headerGlyphPhone: "22px",
  /** The automation cog: a 24px slot that eats the heading's 4px padding so
   *  its target runs the row's full height. */
  cogWidth: "24px",
  cogBleed: "-4px",
  /** The sticky band slot rides above the pinned lanes. */
  bandLayer: "var(--layer-float)",
});
