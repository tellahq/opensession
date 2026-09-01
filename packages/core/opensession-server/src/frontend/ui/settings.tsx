import * as React from "react";
import { Card } from "./card";
import { cn } from "./cn";
import { fieldClasses } from "./input";
import { markTileClass } from "../lib/mark-tile";
import { Skeleton, SkeletonBar } from "./state";

export function SettingsPanel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return <div className={cn("w-full max-w-[720px]", className)} {...props} />;
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
  ...props
}: Omit<React.ComponentPropsWithoutRef<"header">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header
      className={cn(
        "mb-5 flex items-start justify-between gap-4 px-5",
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        <h1 className="m-0 text-page-title font-title tracking-[-0.02em] text-fg [.settings-sheet_&]:hidden">
          {title}
        </h1>
        {description && (
          <p className="m-0 mt-1.5 text-supporting leading-relaxed text-dim [.settings-sheet_&]:mt-0">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
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
  children,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & { actions?: React.ReactNode }) {
  return (
    <div
      data-settings-group-label=""
      className={cn(
        // mt-9: a group's card and the hint under it read as one block, so
        // the space above the next label is what separates the groups.
        "mb-2 mt-9 flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-5 text-label font-semibold text-faint",
        className,
      )}
      {...props}
    >
      <span className="min-w-0">{children}</span>
      {actions && (
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      )}
    </div>
  );
}

/** The surface every settings group sits on: a soft fill and quiet outline.
 * Together they separate a group from the page, so a page of settings reads as
 * a few blocks rather than a stack of outlined boxes.
 *
 * Card supplies the borderless base, so this adds the corner, fill and outline.
 * A settings group is a CONTAINER of rows rather than a single card, and
 * the scale gives a container the largest step: `rounded-2xl` (22px × --rf), the
 * same corner the phone sheet's section list already carries.
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
 * contains and the block reads as one object rather than a frame. */
const settingsSurface =
  "rounded-2xl border border-divider-soft bg-settings-plate";

/**
 * The rule between two groups of rows: inset from the card's edges, so it
 * separates the rows without cutting the block in half. An edge-to-edge rule
 * makes every seam as strong as the card's own outline, and a card of eight of
 * them reads as a table rather than a list of settings.
 *
 * It is drawn as a pseudo-element rather than a `border-t`, because a border
 * cannot be inset: it would need padding on the row, which would move the
 * text. `inset-x-5` matches `SettingRow`'s own `px-5`, so the rule starts where
 * a title starts and ends where a control ends.
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
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <Card
      className={cn(
        settingsSurface,
        "overflow-hidden",
        settingGroupRule,
        className,
      )}
      {...props}
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
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return <div className={cn("flex flex-col", className)} {...props} />;
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
          <SettingRow
            key={row.title}
            className={cn(icon !== undefined && "gap-3")}
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
              <SkeletonBar className={row.title} />
              <SkeletonBar className={cn("mt-2 h-2.5", row.description)} />
            </SettingRowText>
          </SettingRow>
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
 * Literal utilities: Tailwind only compiles class names it can find.
 */
const GHOST_ROWS = [
  { title: "w-[34%]", description: "w-[78%]" },
  { title: "w-[22%]", description: "w-[54%]" },
  { title: "w-[41%]", description: "w-[67%]" },
  { title: "w-[27%]", description: "w-[85%]" },
  { title: "w-[36%]", description: "w-[61%]" },
  { title: "w-[24%]", description: "w-[73%]" },
];

/** A section for content that isn't a list of rows — an editor, a picker, a
 * filter bar. Same surface SettingCard gives rows, so a page of prose sits in
 * the page's rhythm instead of floating on it. */
export function SettingsSection({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return <Card className={cn(settingsSurface, "p-5", className)} {...props} />;
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
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2.5 px-5 py-4",
        className,
      )}
      {...props}
    />
  );
}

export function SettingRowText({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("min-w-0 flex-1 phone:min-w-[45%]", className)}
      {...props}
    />
  );
}

export function SettingRowTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  // data-setting-title mirrors data-setting-description below: a hook a
  // surface can scale from outside (FirstMile promotes these one heading
  // step) without the primitive knowing who is hosting it.
  return (
    <div
      data-setting-title=""
      className={cn("text-item-title font-medium text-fg", className)}
      {...props}
    />
  );
}

export function SettingRowDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-setting-description=""
      className={cn("mt-1 text-supporting text-dim phone:text-meta", className)}
      {...props}
    />
  );
}

export function SettingRowControl({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "ml-auto shrink-0 phone:max-w-[50%] phone:[&>*]:max-w-full",
        className,
      )}
      {...props}
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
    <span className="flex flex-shrink-0 items-center gap-1.5 text-label text-dim">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
      {label}
    </span>
  );
}

/** The ⋯ trigger for a row's overflow menu: quiet until hovered or open.
 *  Shared so a row's actions look the same on every settings page.
 *
 *  `before:-inset-2` grows the 28px box to a 44px target without moving
 *  anything, which a row whose only path to an action is this menu needs on a
 *  phone. It is the last thing in the row, so the grown area overlaps only the
 *  status text beside it. */
export const rowMenuTriggerClasses =
  "relative flex size-7 shrink-0 items-center justify-center rounded-md text-faint transition-[color,background] before:absolute before:-inset-2 before:content-[''] hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg";

export function SettingsHint({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-settings-hint=""
      className={cn("mt-2 px-5 text-supporting text-faint", className)}
      {...props}
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
 * They go through `fieldClasses("md")` rather than composing `fieldClass` with
 * their own padding, which is what had settings rendering 35px fields beside
 * the primitive's 32px ones — two field heights visible on one page, e.g.
 * /settings/connections. Reaching for the size step instead of re-spelling it
 * is the whole point of having one.
 */
export const settingsSelectClass = fieldClasses("md", "cursor-pointer");

export function SettingsForm({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        settingsSurface,
        "mb-3 flex flex-col gap-3.5 p-5",
        className,
      )}
      {...props}
    />
  );
}

export function SettingsFormTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-setting-title=""
      className={cn("mb-4 text-item-title font-semibold text-fg", className)}
      {...props}
    />
  );
}

export function SettingsFormRow({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("grid grid-cols-2 gap-3 max-sm:grid-cols-1", className)}
      {...props}
    />
  );
}

export function SettingsField({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"label">) {
  return (
    <label
      className={cn(
        "mb-3 flex min-w-0 flex-col gap-1.5 text-label font-medium text-dim",
        className,
      )}
      {...props}
    />
  );
}

export const settingsInputClass = fieldClasses("md");

/** Multi-line text entry inside settings — memory entries, the personal
 *  prompt. One class so every editor in settings reads the same. */
export const settingsTextareaClass = fieldClasses("md", "resize-y py-2");

export function SettingsFormActions({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div className={cn("mt-1 flex justify-end gap-2", className)} {...props} />
  );
}
