import * as React from "react";
import * as stylex from "@stylexjs/stylex";
import { cn } from "./cn";
import { SELECTABLE } from "./dialog-styles";
import { fieldClasses } from "./input";
import { markTileClass } from "../lib/mark-tile";
import { Skeleton, SkeletonBar } from "./state";
import { sx } from "./sx";
import {
  color,
  corner,
  geometry,
  leading,
  media,
  motion,
  radius,
  space,
  text,
  tracking,
  weight,
} from "./tokens.stylex";

/**
 * True inside the phone settings sheet, which names the section in its own
 * nav bar, so a panel's header leaves its h1 out there.
 */
export const SettingsInSheet = React.createContext(false);

export function SettingsPanel({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return <div {...props} {...sx(styles.panel, className, style)} />;
}

/**
 * A settings page's header: its title, an optional sentence of context, and
 * optional actions on the right. Every panel opens with one, so pages share a
 * top rhythm no matter who wrote them. The h1 hides inside the phone sheet,
 * which already names the section in its own nav bar.
 */
export function SettingsHeader({
  title,
  description,
  actions,
  className,
  style,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"header">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const inSheet = React.useContext(SettingsInSheet);
  return (
    <header {...props} {...sx(styles.header, className, style)}>
      <div {...stylex.props(styles.shrinkable)}>
        {!inSheet && <h1 {...stylex.props(styles.pageTitle)}>{title}</h1>}
        {description && (
          <p
            {...sx(
              [styles.headerDescription, !inSheet && styles.belowTitle],
              SELECTABLE,
            )}
          >
            {description}
          </p>
        )}
      </div>
      {actions && <div {...stylex.props(styles.actions)}>{actions}</div>}
    </header>
  );
}

/**
 * The label above a group of settings, with optional actions on its right —
 * the group's own "add"/"refresh" buttons. Pages kept re-deriving that row
 * (a flex override here, a local `SectionHeader` there), which is how the
 * groups drifted apart; the slot keeps one shape.
 */
export function SettingsGroupLabel({
  actions,
  className,
  style,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & { actions?: React.ReactNode }) {
  return (
    <div
      data-settings-group-label=""
      {...props}
      {...sx(styles.groupLabel, className, style)}
    >
      <span {...stylex.props(styles.shrinkable)}>{children}</span>
      {actions && <div {...stylex.props(styles.groupActions)}>{actions}</div>}
    </div>
  );
}

/** The surface every settings group sits on: a soft fill and quiet outline.
 * Together they separate a group from the page, so a page of settings reads as
 * a few blocks rather than a stack of outlined boxes.
 *
 * It is `Card`'s surface with three changes: the corner, the fill and the
 * outline. A settings group is a CONTAINER of rows rather than a single card,
 * and the scale gives a container the largest step: `radius.xxl` (22px × --rf),
 * the same corner the phone sheet's section list already carries.
 *
 * The fill is `settings-plate`, not `raised`: a page of these is a column of
 * blocks, and at the full L1 grey the column reads as the page's material
 * rather than as a few quiet groups on paper. See base.css.
 *
 * That fill is deliberately below where a fill alone holds a shape, which is
 * why this surface carries a hairline where the house rule says a card should
 * not (see src/frontend/AGENTS.md). The edge REPLACES the weight the fill gave
 * up rather than adding to it: the two together are quieter than the L1 grey
 * was on its own. Do not restore the heavier fill and keep the edge, and do
 * not add the edge back to `Card`, which is borderless for the reason the rule
 * gives.
 *
 * It takes `divider-soft` rather than the `line` the rules inside take. Those
 * are two different jobs at the same scale: a rule between groups has content
 * on both sides and has to be read as a separation, while this one only has to
 * close the block's shape, and the fill under it is already saying where the
 * block is. At the row weight the outline was the loudest thing on the page.
 * `divider-soft` is `line` at a third, so it lands well under the rules it
 * contains and the block reads as one object rather than a frame.
 *
 * `data-settings-surface` is the hook a host restyles every plate inside it
 * by (onboarding flattens them onto its own panel). */
const SURFACE = { "data-settings-surface": "" };

/**
 * The rule between two groups of rows: inset from the card's edges, so it
 * separates the rows without cutting the block in half. An edge-to-edge rule
 * makes every seam as strong as the card's own outline, and a card of eight of
 * them reads as a table rather than a list of settings.
 *
 * It is drawn as a pseudo-element rather than a `border-t`, because a border
 * cannot be inset: it would need padding on the row, which would move the
 * text. `inset-x-5` matches `SettingRow`'s own 20px inline padding, so the
 * rule starts where a title starts and ends where a control ends.
 *
 * It stays a Tailwind string because it styles the card's children, which a
 * StyleX style on the card cannot reach, and the children are whatever the
 * caller puts there, not only `SettingRow`.
 */
const settingGroupRule =
  "[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-5 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-line [&>*+*]:before:content-['']";

/**
 * A settings group's card. Its DIRECT children are separated by an inset rule,
 * so what a rule means is "a different setting begins here." Put rows that
 * answer one question inside a single `SettingGroup` and they sit together
 * with no seam between them.
 *
 * A card whose children are all bare rows still divides every row, which is
 * right for a list of like things (repos, accounts, tools) and wrong for a
 * page of preferences, where consecutive rows are often facets of the same
 * choice.
 */
export function SettingCard({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...SURFACE}
      {...props}
      {...sx(
        [styles.surface, styles.clip],
        cn(settingGroupRule, className),
        style,
      )}
    />
  );
}

/**
 * Rows that answer one question, carried as a single child of `SettingCard`:
 * no rule between them, one rule above the group. "Group by" and "Group by
 * project" are one setting asked twice, not two settings.
 */
export function SettingGroup({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return <div {...props} {...sx(styles.group, className, style)} />;
}

/**
 * The rows of a settings group that hasn't arrived, standing in for the rows
 * it will become.
 *
 * A settings page is a column of groups, and a group that answers with a
 * centred spinner takes its whole block out of the page until it resolves —
 * so a page with three of them is three holes that fill in at different
 * moments, each one shoving what is under it. Ghost rows keep the block's
 * shape, so the page arrives once.
 *
 * Built out of the real `SettingCard` and `SettingRow` rather than beside
 * them: the seams come from SettingCard's own divider rule and the padding from
 * the row itself, so a change to either is inherited here instead of being
 * something to remember. That is what the hand-tuned `rowClassName` on the
 * one call site that nested `ListSkeleton` inside a card was already drifting
 * away from.
 *
 * No ghost control on the right. Every real row has one, but they are all the
 * same right-aligned pill, and a column of identical grey pills reads as
 * broken buttons where ragged text bars read as titles about to arrive — the
 * argument `SKELETON_WIDTHS` makes in ui/state. Controls are `ml-auto`, so
 * nothing on the left moves when they land.
 *
 * A leading tile is the opposite case and `icon` draws one: it sets where the
 * text starts, so leaving it out on a list that has one means every bar slides
 * right as the rows arrive — the one thing a placeholder exists to prevent.
 * Pass the size the real `IconTile` takes; the corner comes from the tile's own
 * rule, so the two can't drift.
 */
export function SettingCardSkeleton({
  rows = 3,
  icon,
  label = "Loading",
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & {
  rows?: number;
  /** Tile size in px, matching the `IconTile` these rows carry. */
  icon?: number;
  label?: string;
}) {
  return (
    <Skeleton label={label} className={className} {...props}>
      <SettingCard>
        {GHOST_ROWS.slice(0, rows).map((row) => (
          <div
            key={row.title}
            {...stylex.props(styles.row, icon !== undefined && styles.rowTile)}
          >
            {icon !== undefined && (
              // Inline size, like IconTile's own: the tile scale is a
              // number a caller passes, not a step in the class scale.
              <SkeletonBar
                className={markTileClass(icon)}
                style={{ width: icon, height: icon }}
              />
            )}
            <SettingRowText>
              <SkeletonBar width={row.title} />
              <SkeletonBar width={row.description} line="supporting" />
            </SettingRowText>
          </div>
        ))}
      </SettingCard>
    </Skeleton>
  );
}

/**
 * A short name over a long sentence, which is the proportion a real settings
 * row has — the title is a repo or a tool, the description is a line of prose
 * about it. Ragged for the reason ui/state gives, and paired rather than drawn
 * from one pool so a title never comes out longer than the sentence under it.
 */
const GHOST_ROWS = [
  { title: "34%", description: "78%" },
  { title: "22%", description: "54%" },
  { title: "41%", description: "67%" },
  { title: "27%", description: "85%" },
  { title: "36%", description: "61%" },
  { title: "24%", description: "73%" },
];

/** A section for content that isn't a list of rows — an editor, a picker, a
 * filter bar. Same surface SettingCard gives rows, so a page of prose sits in
 * the page's rhythm instead of floating on it. */
export function SettingsSection({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...SURFACE}
      {...props}
      {...sx([styles.surface, styles.sectionPad], className, style)}
    />
  );
}

/**
 * One setting: its label and description on the left, its control on the
 * right. On a phone, text keeps at least 45% of the row and controls cap at
 * 50%, leaving room for the gap. Compact controls stay beside the text while
 * wider controls truncate or wrap within their side instead of taking a new
 * row.
 *
 * Rows are centered, which is right while the text is a title and one line of
 * description. A row that grows past that (an account with usage bars) should
 * pass `items-start`: an avatar and a control floating in the middle of a tall
 * row read as unanchored, and top-aligning ties them to the title they belong
 * to.
 */
export function SettingRow({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return <div {...props} {...sx(styles.row, className, style)} />;
}

export function SettingRowText({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return <div {...props} {...sx(styles.rowText, className, style)} />;
}

export function SettingRowTitle({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  // data-setting-title mirrors data-setting-description below: a hook a
  // surface can scale from outside (FirstMile promotes these one heading
  // step, Settings sets their leading) without the primitive knowing who is
  // hosting it.
  return (
    <div
      data-setting-title=""
      {...props}
      {...sx(styles.rowTitle, className, style)}
    />
  );
}

export function SettingRowDescription({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-setting-description=""
      {...props}
      {...sx(styles.rowDescription, cn(SELECTABLE, className), style)}
    />
  );
}

/** `phone:[&>*]:max-w-full` stays a utility: it reaches the control's own
 *  children, which a style on this box cannot. */
export function SettingRowControl({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      {...sx(styles.rowControl, cn("phone:[&>*]:max-w-full", className), style)}
    />
  );
}

/**
 * A row's state, read before its actions: a dot and a word. Connected rows
 * carry one and unconnected rows carry a Connect button, which is what keeps
 * the two apart at a glance. A row whose only difference is the verb on a
 * neutral button ("Connect" vs "Disconnect") reads as the same row twice.
 */
export function StatusChip({ label, dot }: { label: string; dot: string }) {
  return (
    <span {...stylex.props(styles.chip)}>
      <span {...stylex.props(styles.chipDot)} style={{ background: dot }} />
      {label}
    </span>
  );
}

export function SettingsHint({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-settings-hint=""
      {...props}
      {...sx(styles.hint, cn(SELECTABLE, className), style)}
    />
  );
}

/**
 * Settings fields are the app's fields — `ui/input`'s recipe, not a local one.
 * These aliases stay because ~20 call sites pass a class rather than render a
 * component (native selects with their own appearance resets, mostly); the
 * shape behind them is now shared with every other field and, through it, with
 * every button.
 *
 * They go through `fieldClasses("md")` rather than re-spelling the field with
 * their own padding, which is what had settings rendering 35px fields beside
 * the primitive's 32px ones — two field heights visible on one page, e.g.
 * /settings/connections. Reaching for the size step instead of re-spelling it
 * is the whole point of having one.
 */
export const settingsSelectClass = fieldClasses("md", "cursor-pointer");

export function SettingsForm({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...SURFACE}
      {...props}
      {...sx([styles.surface, styles.form], className, style)}
    />
  );
}

export function SettingsFormTitle({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-setting-title=""
      {...props}
      {...sx(styles.formTitle, className, style)}
    />
  );
}

export function SettingsFormRow({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return <div {...props} {...sx(styles.formRow, className, style)} />;
}

export function SettingsField({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"label">) {
  return <label {...props} {...sx(styles.field, className, style)} />;
}

export const settingsInputClass = fieldClasses("md");

/** Multi-line text entry inside settings — memory entries, the personal
 *  prompt. One class so every editor in settings reads the same. */
export const settingsTextareaClass = fieldClasses("md", "resize-y py-2");

export function SettingsFormActions({
  className,
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return <div {...props} {...sx(styles.formActions, className, style)} />;
}

const styles = stylex.create({
  panel: { width: "100%", maxWidth: geometry.settingsColumn },
  header: {
    marginBottom: space.s20,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space.s16,
    paddingInline: space.s20,
  },
  shrinkable: { minWidth: 0 },
  pageTitle: {
    margin: space.s0,
    fontSize: text.pageTitle,
    fontWeight: weight.title,
    letterSpacing: tracking.title,
    color: color.fg,
  },
  // 400, like every supporting line: base.css runs the app at 500.
  headerDescription: {
    margin: space.s0,
    fontSize: text.label,
    fontWeight: weight.regular,
    lineHeight: leading.relaxed,
    color: color.dim,
  },
  belowTitle: { marginTop: space.s6 },
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s8,
  },
  // A group's card and the hint under it read as one block, so the space
  // above the next label is what separates the groups.
  groupLabel: {
    marginBottom: space.s8,
    marginTop: geometry.settingsGroupGap,
    display: "flex",
    minHeight: space.s24,
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: space.s8,
    rowGap: space.s6,
    paddingInline: space.s20,
    fontSize: text.label,
    fontWeight: weight.medium,
    color: color.dim,
  },
  groupActions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s6,
  },
  surface: {
    borderRadius: radius.xxl,
    ["cornerShape"]: corner.squircle,
    borderWidth: geometry.hairline,
    borderStyle: "solid",
    borderColor: color.settingsPlateEdge,
    backgroundColor: color.settingsPlate,
  },
  clip: { overflow: "hidden" },
  sectionPad: { padding: space.s20 },
  group: { display: "flex", flexDirection: "column" },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s16,
    rowGap: space.s10,
    paddingInline: space.s20,
    paddingBlock: space.s16,
  },
  rowTile: { columnGap: space.s12, rowGap: space.s12 },
  rowText: {
    minWidth: { default: 0, [media.phone]: "45%" },
    flex: "1 1 0%",
  },
  rowTitle: {
    fontSize: text.itemTitle,
    fontWeight: weight.medium,
    color: color.fg,
  },
  rowDescription: {
    marginTop: space.s4,
    fontSize: { default: text.label, [media.phone]: text.meta },
    fontWeight: weight.regular,
    color: color.dim,
  },
  rowControl: {
    marginInlineStart: "auto",
    flexShrink: 0,
    maxWidth: { default: null, [media.phone]: "50%" },
  },
  chip: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s6,
    fontSize: text.label,
    color: color.dim,
  },
  chipDot: {
    width: geometry.dotSmall,
    height: geometry.dotSmall,
    borderRadius: radius.pill,
  },
  rowMenuTrigger: {
    position: "relative",
    display: "flex",
    width: geometry.rowMenuTrigger,
    height: geometry.rowMenuTrigger,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    ["cornerShape"]: corner.squircle,
    color: {
      default: color.faint,
      ":hover": { default: null, [media.hover]: color.fg },
      ":is([data-popup-open])": color.fg,
    },
    backgroundColor: {
      default: null,
      ":hover": { default: null, [media.hover]: color.hover },
      ":is([data-popup-open])": color.hover,
    },
    transitionProperty: "color, background",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    "::before": {
      content: "''",
      position: "absolute",
      inset: `calc(-1 * ${space.s8})`,
    },
  },
  hint: {
    marginTop: space.s8,
    paddingInline: space.s20,
    fontSize: text.label,
    fontWeight: weight.regular,
    color: color.faint,
  },
  form: {
    marginBottom: space.s12,
    display: "flex",
    flexDirection: "column",
    gap: space.s14,
    padding: space.s20,
  },
  formTitle: {
    marginBottom: space.s16,
    fontSize: text.itemTitle,
    fontWeight: weight.strong,
    color: color.fg,
  },
  formRow: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [media.small]: "repeat(1, minmax(0, 1fr))",
    },
    gap: space.s12,
  },
  field: {
    marginBottom: space.s12,
    display: "flex",
    minWidth: 0,
    flexDirection: "column",
    gap: space.s6,
    fontSize: text.label,
    fontWeight: weight.medium,
    color: color.dim,
  },
  formActions: {
    marginTop: space.s4,
    display: "flex",
    justifyContent: "flex-end",
    gap: space.s8,
  },
});

/** The ⋯ trigger for a row's overflow menu: quiet until hovered or open.
 *  Shared so a row's actions look the same on every settings page.
 *
 *  The `::before` grows the 28px box to a 44px target without moving
 *  anything, which a row whose only path to an action is this menu needs on a
 *  phone. It is the last thing in the row, so the grown area overlaps only the
 *  status text beside it. */
export const rowMenuTriggerClasses =
  stylex.props(styles.rowMenuTrigger).className ?? "";

/**
 * The plate as a class string, for a list that draws its own rows on it (the
 * phone settings sheet's section list and account card).
 */
export const SETTINGS_PLATE =
  stylex.props(styles.surface, styles.clip).className ?? "";
