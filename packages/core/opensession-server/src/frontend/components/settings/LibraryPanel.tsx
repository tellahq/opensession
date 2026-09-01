import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  fetchLibrary,
  type LibraryEntry,
  type LibraryEntryType,
} from "../../lib/api/library";
import { BASE_PATH } from "../../lib/base";
import { BRANDS, displayName } from "../../brand-logos";
import { IconTile } from "../BrandTile";
import {
  IconBolt,
  IconChart,
  IconCheckCircle,
  IconInbox,
  IconListCircles,
  IconMail,
  IconMessages,
  IconMoon,
  IconNote,
  IconPlug,
  IconPullRequest,
  IconStack,
  IconStatusRing,
  IconWrench,
} from "../icons";
import { useIsPhone } from "../../hooks/useIsPhone";
import {
  markTileClass,
  markTileGradient,
  markTileInk,
  markTileShadow,
  type MarkTone,
} from "../../lib/mark-tile";
import {
  onSidebarToolsChanged,
  readHiddenSidebarTools,
  setSidebarToolVisible,
  toolFitsViewport,
  type SidebarToolId,
} from "../../lib/sidebar-tools";
import { SettingsHeader, SettingsHint, SettingsPanel } from "../../ui/settings";
import { Input } from "../../ui/input";
import { Badge } from "../../ui/badge";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import { EmptyState, InlineAlert, Skeleton, SkeletonBar } from "../../ui/state";
import { Switch } from "../../ui/switch";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mt11: {
    marginTop: "calc(4px * 11)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  mb4: {
    marginBottom: "calc(4px * 4)",
  },
  h4: {
    height: "calc(4px * 4)",
  },
  w22: {
    width: "22%",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  pb3: {
    paddingBottom: "calc(4px * 3)",
  },
  Container: {
    containerType: "inline-size",
  },
  grid: {
    display: "grid",
  },
  gridCols1: {
    gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
  },
  gapX12: {
    columnGap: "calc(4px * 12)",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap35: {
    gap: "calc(4px * 3.5)",
  },
  py35: {
    paddingBlock: "calc(4px * 3.5)",
  },
  size9: {
    width: "calc(4px * 9)",
    height: "calc(4px * 9)",
  },
  shrink0: {
    flexShrink: "0",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  mb1: {
    marginBottom: "4px",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  m0: {
    margin: "0",
  },
  fontTitle: {
    fontWeight: "var(--title-weight)",
  },
  tracking001em: {
    letterSpacing: "-0.01em",
  },
  textFg: {
    color: "var(--text)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  maxWNone: {
    maxWidth: "none",
  },
  mb11: {
    marginBottom: "calc(4px * 11)",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  pt4: {
    paddingTop: "calc(4px * 4)",
  },
  transitionOpacity: {
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  hoverOpacity80: {
    "@media (hover: hover)": {
      ":hover": {
        opacity: "80%",
      },
    },
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  minW180px: {
    minWidth: "180px",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  overflowXAuto: {
    overflowX: "auto",
  },
  ScrollbarWidthNone: {
    scrollbarWidth: "none",
  },
  mt4: {
    marginTop: "calc(4px * 4)",
  },
  px0: {
    paddingInline: "0",
  },
});

// ── The library: one browsable catalog over the things this instance can be
// extended with. The server derives it (src/server/library.ts) from the
// recipes directory, the automation templates and the integration registry,
// so a new recipe file shows up here without an edit in this file.
//
// It reads as a gallery rather than a settings form: a grid of cards, each
// led by the mark of the thing it installs. A catalog is browsed before it is
// read, and a column of identical text rows gives a person nothing to aim at
// The tile is what makes "the GitHub one" findable without reading.
//
// Installing deliberately does NOT happen here: each type keeps the install
// path it already has (a config seed, a pre-filled create form, credentials in
// Setup), and the card links into it. The one exception is a core tool, whose
// switch is client state today; see the caveat rendered under that group. ──

const TYPE_ORDER: LibraryEntryType[] = [
  "tool",
  "automation",
  "integration",
  "connection",
  "package",
];

const TYPE_LABELS: Record<LibraryEntryType, string> = {
  tool: "Tools",
  automation: "Automations",
  integration: "Integrations",
  connection: "Connections",
  package: "Packages",
};

const TYPE_BLURB: Record<LibraryEntryType, string> = {
  tool: "Tools appear in your sidebar.",
  automation: "A prompt and a trigger: a schedule, an event, or a webhook.",
  integration: "Outside systems this instance can listen to and act in.",
  connection: "First-party MCP servers maintained with Open Session.",
  // Listed once installed rather than browsed: installing a package mounts an
  // MCP server and adds text an agent reads, so the review that gates it
  // lives in the terminal. `opensession plugins add <owner/repo>`.
  package: "Installed from a git repository with the CLI.",
};

const FILTERS: { key: "all" | LibraryEntryType; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "tool", label: "Tools" },
  { key: "automation", label: "Automations" },
  { key: "integration", label: "Integrations" },
  { key: "connection", label: "Connections" },
  { key: "package", label: "Packages" },
];

type Glyph = { icon: ComponentType<{ size?: number }>; tone: MarkTone };

/** Per tool, because a tool is a place in the app and its glyph is how the
 *  sidebar already names it. */
const TOOL_GLYPHS: Record<string, Glyph> = {
  tasks: { icon: IconListCircles, tone: "sky" },
  plain: { icon: IconMail, tone: "orange" },
  catchup: { icon: IconInbox, tone: "green" },
  supporttinder: { icon: IconMessages, tone: "coral" },
  reports: { icon: IconStack, tone: "indigo" },
  analytics: { icon: IconChart, tone: "sky" },
};

/**
 * An automation's glyph, read off what the job is about. Every automation is
 * a prompt on a trigger, so typed strictly they would all draw one bolt, and
 * a column of seventeen identical bolts is a column with nothing to aim at.
 * The word that names the job is the best signal available: a catalog is
 * scanned, and "the error one" is how someone looks for it.
 *
 * Order matters. "Production error sweep" contains both "production" and
 * "error"; the failure it watches is what it is about, so that rule comes
 * first.
 */
const JOB_GLYPHS: { match: RegExp; glyph: Glyph }[] = [
  {
    match: /error|health|monitor|uptime|incident|alarm/,
    glyph: { icon: IconStatusRing, tone: "coral" },
  },
  {
    match: /doc|changelog|spell|release note/,
    glyph: { icon: IconNote, tone: "indigo" },
  },
  { match: /test|flaky/, glyph: { icon: IconCheckCircle, tone: "green" } },
  {
    match: /support|ticket|recap|digest|rollup/,
    glyph: { icon: IconMessages, tone: "orange" },
  },
  {
    match: /dream|reflect|retro|nightly/,
    glyph: { icon: IconMoon, tone: "indigo" },
  },
  {
    match: /depend|cleanup|refactor|code/,
    glyph: { icon: IconWrench, tone: "green" },
  },
  {
    match: /\bpr\b|pull request|review|merge|branch/,
    glyph: { icon: IconPullRequest, tone: "sky" },
  },
];

const TYPE_GLYPHS: Record<LibraryEntryType, Glyph> = {
  tool: { icon: IconStack, tone: "sky" },
  automation: { icon: IconBolt, tone: "orange" },
  integration: { icon: IconPlug, tone: "green" },
  connection: { icon: IconPlug, tone: "sky" },
  package: { icon: IconStack, tone: "indigo" },
};

/** A service named in the entry's own name, for the entries that carry no
 *  `requires`, which is every automation TEMPLATE, most of the catalog. Only
 *  the name is searched: a description mentioning a repo called webapp
 *  is not a webapp automation. */
const BRAND_IN_NAME = new RegExp(`\\b(${Object.keys(BRANDS).join("|")})\\b`);

function brandFor(entry: LibraryEntry): string | undefined {
  if (entry.type === "integration") return entry.slug;
  const required = entry.requires?.find((id) => BRANDS[id]);
  if (required) return required;
  return BRAND_IN_NAME.exec(entry.name.toLowerCase())?.[1];
}

function glyphFor(entry: LibraryEntry): Glyph {
  const perTool = TOOL_GLYPHS[entry.slug];
  if (perTool) return perTool;
  if (entry.type === "automation") {
    const name = `${entry.slug} ${entry.name}`.toLowerCase();
    const job = JOB_GLYPHS.find((rule) => rule.match.test(name));
    if (job) return job.glyph;
  }
  return TYPE_GLYPHS[entry.type];
}

function EntryIcon({
  entry,
  size = 34,
}: {
  entry: LibraryEntry;
  size?: number;
}) {
  // An integration IS the service. An automation or tool that works in one is
  // best recognised by it too: "Stale PR monitor" under GitHub's mark says
  // what it touches faster than any wording of its description does.
  const brand = brandFor(entry);
  if (brand) return <IconTile name={brand} size={size} />;

  const glyph = glyphFor(entry);
  const Icon = glyph.icon;
  return (
    <span
      className={markTileClass(size)}
      style={{
        width: size,
        height: size,
        backgroundImage: markTileGradient(glyph.tone),
        // White, in both themes. The plate is a saturated colour either
        // way, so the ink on it does not answer to the page.
        color: "#fff",
        boxShadow: markTileShadow(markTileInk(glyph.tone)),
      }}
    >
      <Icon size={Math.round(size * 0.54)} />
    </span>
  );
}

/** A card's action: a raised pill, the Button primitive's `default` recipe at
 *  `sm`. It is an anchor rather than a button because every install path is a
 *  place (the automation form, Setup), and a link is what a place takes. */
const installLinkClass = utilityClassName(
  "inline-flex min-h-[26px] shrink-0 items-center rounded-control border border-line bg-button px-2.5 text-xs font-medium text-dim no-underline smooth-shadow-xs transition-colors hover:border-line-strong hover:text-fg",
);

function entryHref(entry: LibraryEntry): string {
  return /^https?:\/\//.test(entry.href)
    ? entry.href
    : `${BASE_PATH}${entry.href}`;
}

function EntryControl({
  entry,
  toolVisible,
  onToggleTool,
}: {
  entry: LibraryEntry;
  toolVisible: boolean;
  onToggleTool: (visible: boolean) => void;
}) {
  if (entry.type === "tool")
    return (
      <Switch
        checked={toolVisible}
        onCheckedChange={onToggleTool}
        aria-label={`Show ${entry.name} in the sidebar`}
      />
    );

  if (entry.installed)
    return (
      <Badge tone="success">
        {entry.type === "integration" ? "Enabled" : "Installed"}
      </Badge>
    );

  return (
    <a className={installLinkClass} href={entryHref(entry)}>
      {entry.install === "guided"
        ? "Set up"
        : entry.install === "draft"
          ? "Use"
          : "Add"}
    </a>
  );
}

/**
 * A section's heading, over a rule that runs the width of what it names.
 *
 * This panel does not use `SettingsGroupLabel`. That label is a caption over a
 * filled card, and it is the card's own edge that says where the group starts
 * and ends. These rows carry no fill, so nothing else here divides the page,
 * and a 13px faint caption over 17 unfenced rows is not a division. It takes
 * the in-page heading the PR list and Setup already use.
 */
/**
 * The catalog on its way: a section under way, and the rows it will hold, in
 * the two-up grid they land in.
 *
 * The mark is drawn at the size `EntryIcon` takes, because it is what sets
 * where every title starts — leave it out and the whole column slides right
 * as the entries arrive. The search field above is deliberately not ghosted:
 * a control is not content, and a grey box where a field goes reads as a
 * field you have been shut out of.
 */
function CatalogSkeleton() {
  return (
    <Skeleton
      label="Loading the library"
      className={mergeStylexOverrideClassName("", sx.mt11, sx.px5)}
    >
      <SkeletonBar
        className={mergeStylexOverrideClassName(
          "",
          sx.mb4,
          sx.h4,
          sx.w22,
          sx.borderB,
          sx.borderDivider,
          sx.pb3,
        )}
      />
      <div {...stylex.props(sx.Container)}>
        <div
          {...mergeStylexProps(
            "@[560px]:grid-cols-2",
            sx.grid,
            sx.gridCols1,
            sx.gapX12,
          )}
        >
          {CATALOG_GHOST_ROWS.map((row) => (
            <div
              key={row.name}
              {...stylex.props(sx.flex, sx.itemsCenter, sx.gap35, sx.py35)}
            >
              <SkeletonBar
                className={mergeStylexOverrideClassName(
                  "",
                  sx.size9,
                  sx.shrink0,
                  sx.roundedControl,
                )}
              />
              <div {...stylex.props(sx.minW0, sx.flex1)}>
                <SkeletonBar className={row.name} />
                <SkeletonBar
                  className={utilityClassName(`mt-2 h-2.5 ${row.description}`)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Skeleton>
  );
}

/** Ragged, and a name always shorter than the line under it — see ui/state. */
const CATALOG_GHOST_ROWS = [
  { name: "w-[38%]", description: "w-[76%]" },
  { name: "w-[26%]", description: "w-[58%]" },
  { name: "w-[44%]", description: "w-[69%]" },
  { name: "w-[31%]", description: "w-[83%]" },
  { name: "w-[35%]", description: "w-[62%]" },
  { name: "w-[23%]", description: "w-[74%]" },
];

function SectionHeading({
  children,
  count,
}: {
  children: ReactNode;
  count?: number;
}) {
  return (
    <div
      {...stylex.props(
        sx.mb1,
        sx.flex,
        sx.itemsBaseline,
        sx.justifyBetween,
        sx.gap3,
        sx.borderB,
        sx.borderDivider,
        sx.pb3,
      )}
    >
      <h2
        {...stylex.props(
          sx.m0,
          sx.fontTitle,
          sx.tracking001em,
          sx.textFg,
          typography.sectionTitle,
        )}
      >
        {children}
      </h2>
      {count != null && (
        <span
          {...mergeStylexProps(
            "tabular-nums",
            sx.textFaint,
            typography.supporting,
          )}
        >
          {count}
        </span>
      )}
    </div>
  );
}

function EntryCard({
  entry,
  toolVisible,
  onToggleTool,
}: {
  entry: LibraryEntry;
  toolVisible: boolean;
  onToggleTool: (visible: boolean) => void;
}) {
  return (
    // No fill. A card per entry stacks a plate on a plate on the page, and at
    // two dozen entries the page reads as boxes rather than as things you can
    // add. The mark carries the row, and the gutter between the columns is
    // what separates one from the next.
    <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap35, sx.py35)}>
      <EntryIcon entry={entry} size={36} />
      <div {...stylex.props(sx.minW0, sx.flex1)}>
        <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap15)}>
          <span
            {...stylex.props(
              sx.truncate,
              sx.fontMedium,
              sx.textFg,
              typography.itemTitle,
            )}
          >
            {entry.name}
          </span>
          {/* A template is the odd one out: it opens a pre-filled form to
					    edit rather than installing on the click, which its "Use"
					    already says and this confirms before the click. */}
          {entry.install === "draft" && <Badge>Template</Badge>}
        </div>
        <div {...stylex.props(sx.truncate, sx.textDim, typography.supporting)}>
          {entry.description}
          {entry.requires?.length
            ? ` Needs ${entry.requires.map(displayName).join(" and ")}.`
            : ""}
        </div>
      </div>
      <EntryControl
        entry={entry}
        toolVisible={toolVisible}
        onToggleTool={onToggleTool}
      />
    </div>
  );
}

export function LibraryPanel() {
  const isPhone = useIsPhone();
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | LibraryEntryType>("all");
  const [hiddenTools, setHiddenTools] = useState<Set<SidebarToolId>>(() =>
    readHiddenSidebarTools(),
  );

  useEffect(() => {
    let alive = true;
    fetchLibrary()
      .then((list) => alive && setEntries(list))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  // Another surface (the sidebar's ••• menu, Settings) can flip the same
  // switches, so mirror rather than own the state.
  useEffect(
    () => onSidebarToolsChanged(() => setHiddenTools(readHiddenSidebarTools())),
    [],
  );

  const visible = (entries || []).filter(
    // A tool this width never shows can't be switched on here either.
    (entry) =>
      entry.type !== "tool" ||
      toolFitsViewport(entry.slug as SidebarToolId, isPhone),
  );

  const groups = (() => {
    const needle = query.trim().toLowerCase();
    const matched = visible.filter((entry) => {
      if (filter !== "all" && entry.type !== filter) return false;
      if (!needle) return true;
      return (
        entry.name.toLowerCase().includes(needle) ||
        entry.description.toLowerCase().includes(needle) ||
        entry.category.toLowerCase().includes(needle)
      );
    });
    return TYPE_ORDER.map((type) => ({
      type,
      entries: matched.filter((entry) => entry.type === type),
    })).filter((group) => group.entries.length > 0);
  })();

  // What this instance already runs, led by its own mark. The catalog below
  // says the same thing card by card; this is the one glance that answers
  // "what is on here" before you start reading.
  //
  // One tile per MARK, integrations first: an automation borrows the mark of
  // the service it works in, so the GitHub integration and the GitHub review
  // automation both draw GitHub's square and a strip carrying both reads as
  // a rendering bug rather than as two things being on.
  const byMark = new Map<string | Glyph, LibraryEntry>();
  for (const entry of [...visible].sort(
    (a, b) =>
      Number(b.type === "integration") - Number(a.type === "integration"),
  )) {
    if (entry.installed !== true) continue;
    // A glyph rule is a singleton, so the object itself is the mark's
    // identity, with no key to keep in sync with the table above.
    const mark = brandFor(entry) ?? glyphFor(entry);
    if (!byMark.has(mark)) byMark.set(mark, entry);
  }
  const installed = [...byMark.values()];

  const header = <SettingsHeader title="Library" />;

  if (error)
    return (
      <SettingsPanel className={mergeStylexOverrideClassName("", sx.maxWNone)}>
        {header}
        <InlineAlert>{error}</InlineAlert>
      </SettingsPanel>
    );

  if (!entries)
    return (
      <SettingsPanel className={mergeStylexOverrideClassName("", sx.maxWNone)}>
        {header}
        <CatalogSkeleton />
      </SettingsPanel>
    );

  return (
    <SettingsPanel className={mergeStylexOverrideClassName("", sx.maxWNone)}>
      {header}

      {installed.length > 0 && (
        <section {...stylex.props(sx.mb11, sx.px5)}>
          <SectionHeading>Installed</SectionHeading>
          <div {...stylex.props(sx.flex, sx.flexWrap, sx.gap25, sx.pt4)}>
            {installed.map((entry) => (
              <a
                key={entry.id}
                href={entryHref(entry)}
                title={entry.name}
                aria-label={entry.name}
                // The tile's own corner, so the focus ring traces the mark
                // rather than a squarer box behind it.
                {...stylex.props(
                  sx.roundedControl,
                  sx.transitionOpacity,
                  sx.hoverOpacity80,
                )}
              >
                <EntryIcon entry={entry} size={36} />
              </a>
            ))}
          </div>
        </section>
      )}

      <div
        {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gap2, sx.px5)}
      >
        <Input
          className={mergeStylexOverrideClassName("", sx.minW180px, sx.flex1)}
          placeholder="Search the library"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* The four options fit the desktop row. On a phone they are wider
				    than the sheet and the segmented control's own tap sizing makes
				    them wider still, so the strip scrolls rather than wrapping into
				    a second row of chrome above the catalog. */}
        <div
          {...mergeStylexProps(
            "[&::-webkit-scrollbar]:hidden",
            sx.maxWFull,
            sx.overflowXAuto,
            sx.ScrollbarWidthNone,
          )}
        >
          <Segmented
            label="Filter the library"
            size="sm"
            value={filter}
            onValueChange={(next) =>
              setFilter(next as "all" | LibraryEntryType)
            }
          >
            {FILTERS.map((option) => (
              <SegmentedOption key={option.key} value={option.key}>
                {option.label}
              </SegmentedOption>
            ))}
          </Segmented>
        </div>
      </div>

      {groups.length === 0 && (
        <EmptyState>Nothing in the library matches that.</EmptyState>
      )}

      {groups.map((group) => (
        <section key={group.type} {...stylex.props(sx.mt11, sx.px5)}>
          <SectionHeading count={group.entries.length}>
            {TYPE_LABELS[group.type]}
          </SectionHeading>
          {/* Two up where the column is wide enough for a row to hold a
					    readable description, one up otherwise. The measure is the
					    CONTAINER's, not the window's: this panel sits beside the
					    settings nav, so a viewport query would say "wide" for a
					    column that isn't. The gutter is wide on purpose: with no
					    fill under a row, the air is what tells the two columns
					    apart. */}
          <div {...stylex.props(sx.Container)}>
            <div
              {...mergeStylexProps(
                "@[560px]:grid-cols-2",
                sx.grid,
                sx.gridCols1,
                sx.gapX12,
              )}
            >
              {group.entries.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  toolVisible={
                    entry.type === "tool" &&
                    !hiddenTools.has(entry.slug as SidebarToolId)
                  }
                  onToggleTool={(next) =>
                    setSidebarToolVisible(entry.slug as SidebarToolId, next)
                  }
                />
              ))}
            </div>
          </div>
          <SettingsHint
            className={mergeStylexOverrideClassName("", sx.mt4, sx.px0)}
          >
            {group.type === "tool" ? (
              <>
                {TYPE_BLURB.tool} These switches are saved in this browser only,
                and a tool you turn off still sends its reminders and
                notifications.
              </>
            ) : (
              TYPE_BLURB[group.type]
            )}
          </SettingsHint>
        </section>
      ))}
    </SettingsPanel>
  );
}
