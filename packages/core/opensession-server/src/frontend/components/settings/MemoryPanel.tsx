import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BASE_PATH } from "../../lib/base";
import { relativeTime, type MemoryScopeDto } from "../../lib/api";
import { errorMessage } from "../../lib/error-message";
import {
  markTileClass,
  markTileGradient,
  markTileInk,
  markTileShadow,
  type MarkTone,
} from "../../lib/mark-tile";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { useConfirm } from "../../ui/confirm";
import { Field, Input, Select, Textarea } from "../../ui/input";
import { Modal } from "../../ui/modal";
import { OptionSelect } from "../../ui/select";
import {
  SettingCard,
  SettingCardSkeleton,
  SettingGroup,
  SettingsHeader,
  SettingsPanel,
} from "../../ui/settings";
import { EmptyState, InlineAlert } from "../../ui/state";
import { toast } from "../../ui/toast";
import {
  IconBranches,
  IconArchive,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconGlobe,
  IconHash,
  IconPencil,
  IconPin,
  IconPeople,
  IconPlus,
  IconRestore,
  IconSearch,
  IconTrash,
  IconX,
} from "../icons";
import { getCurrentUser } from "../UserPicker";
import {
  addStructuredMemory,
  fetchMemoryPage,
  fetchMemoryScopes,
  memoryCreatedAt,
  memoryNeedsReview,
  memorySourceLabel,
  memoryState,
  memorySummary,
  mergeMemoryRecords,
  mutateMemoryRecord,
  permanentlyDeleteMemory,
  readMemoryRecord,
  updateMemoryRecord,
  type MemoryRecordDto,
  type MemoryRecordKind,
  type MemoryScopeSummaryDto,
  type MemoryScopeV2Dto,
  type MemoryState,
  type MemoryV2Stats,
} from "../../lib/memory-v2";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  wFull: {
    width: "100%",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  rounded2xl: {
    borderRadius: "calc(22px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  textLeft: {
    textAlign: "left",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  phoneItemsStart: {
    "@media (max-width: 720px)": {
      alignItems: "flex-start",
    },
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  block: {
    display: "block",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt1: {
    marginTop: "4px",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mt15: {
    marginTop: "calc(4px * 1.5)",
  },
  hidden: {
    display: "none",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  phoneBlock: {
    "@media (max-width: 720px)": {
      display: "block",
    },
  },
  shrink0: {
    flexShrink: "0",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  selfCenter: {
    alignSelf: "center",
  },
  phoneSelfStart: {
    "@media (max-width: 720px)": {
      alignSelf: "flex-start",
    },
  },
  phonePt2: {
    "@media (max-width: 720px)": {
      paddingTop: "calc(4px * 2)",
    },
  },
  phoneHidden: {
    "@media (max-width: 720px)": {
      display: "none",
    },
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  borderT: {
    borderTopStyle: "solid",
    borderTopWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  alignTop: {
    verticalAlign: "top",
  },
  phoneGrid: {
    "@media (max-width: 720px)": {
      display: "grid",
    },
  },
  phoneGridColsMinmax01frAuto: {
    "@media (max-width: 720px)": {
      gridTemplateColumns: "minmax(0,1fr) auto",
    },
  },
  phoneGapX3: {
    "@media (max-width: 720px)": {
      columnGap: "calc(4px * 3)",
    },
  },
  phonePx4: {
    "@media (max-width: 720px)": {
      paddingInline: "calc(4px * 4)",
    },
  },
  phonePy3: {
    "@media (max-width: 720px)": {
      paddingBlock: "calc(4px * 3)",
    },
  },
  w11: {
    width: "calc(4px * 11)",
  },
  px1: {
    paddingInline: "4px",
  },
  py1: {
    paddingBlock: "4px",
  },
  phoneColStart2: {
    "@media (max-width: 720px)": {
      gridColumnStart: "2",
    },
  },
  phoneRowStart1: {
    "@media (max-width: 720px)": {
      gridRowStart: "1",
    },
  },
  phoneWAuto: {
    "@media (max-width: 720px)": {
      width: "auto",
    },
  },
  phoneP0: {
    "@media (max-width: 720px)": {
      padding: "0",
    },
  },
  size10: {
    width: "calc(4px * 10)",
    height: "calc(4px * 10)",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  phoneSize11: {
    "@media (max-width: 720px)": {
      width: "calc(4px * 11)",
      height: "calc(4px * 11)",
    },
  },
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
  },
  w32: {
    width: "calc(4px * 32)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  phoneColStart1: {
    "@media (max-width: 720px)": {
      gridColumnStart: "1",
    },
  },
  phoneColSpan2: {
    "@media (max-width: 720px)": {
      gridColumn: "span 2 / span 2",
    },
  },
  phoneRowStart2: {
    "@media (max-width: 720px)": {
      gridRowStart: "2",
    },
  },
  phoneMt2: {
    "@media (max-width: 720px)": {
      marginTop: "calc(4px * 2)",
    },
  },
  minH6em: {
    minHeight: "6em",
  },
  resizeNone: {
    resize: "none",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  phoneTextInputPhone: {
    "@media (max-width: 720px)": {
      fontSize: "var(--type-input-phone)",
    },
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  relative: {
    position: "relative",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  whitespacePreWrap: {
    whiteSpace: "pre-wrap",
  },
  breakWords: {
    overflowWrap: "break-word",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  insetX0: {
    insetInline: "0",
  },
  bottom0: {
    bottom: "0",
  },
  h10: {
    height: "calc(4px * 10)",
  },
  bgLinearGradientToBottomTransparentVarSettingsPlate: {
    backgroundImage:
      "linear-gradient(to bottom,transparent,var(--settings-plate))",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  phoneMt1: {
    "@media (max-width: 720px)": {
      marginTop: "4px",
    },
  },
  phoneFlexWrap: {
    "@media (max-width: 720px)": {
      flexWrap: "wrap",
    },
  },
  inlineFlex: {
    display: "inline-flex",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  px0: {
    paddingInline: "0",
  },
  leadingNone: {
    lineHeight: "1",
  },
  opacity0: {
    opacity: "0%",
  },
  transitionOpacity: {
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  duration150: {
    transitionDuration: "150ms",
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  phoneH11: {
    "@media (max-width: 720px)": {
      height: "calc(4px * 11)",
    },
  },
  phoneOpacity100: {
    "@media (max-width: 720px)": {
      opacity: "100%",
    },
  },
  mlAuto: {
    marginLeft: "auto",
  },
  justifyEnd: {
    justifyContent: "flex-end",
  },
  gap1: {
    gap: "4px",
  },
  hoverTextRed: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--red)",
      },
    },
  },
  phoneRowStart3: {
    "@media (max-width: 720px)": {
      gridRowStart: "3",
    },
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  overflowXAuto: {
    overflowX: "auto",
  },
  tableFixed: {
    tableLayout: "fixed",
  },
  borderCollapse: {
    borderCollapse: "collapse",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  phoneSrOnly: {
    "@media (max-width: 720px)": {
      position: "absolute",
      width: "1px",
      height: "1px",
      padding: "0",
      margin: "-1px",
      overflow: "hidden",
      clipPath: "inset(50%)",
      whiteSpace: "nowrap",
      borderWidth: "0",
    },
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py25: {
    paddingBlock: "calc(4px * 2.5)",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
  grid: {
    display: "grid",
  },
  gridCols2: {
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  },
  phoneGridCols1: {
    "@media (max-width: 720px)": {
      gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
    },
  },
  textRight: {
    textAlign: "right",
  },
  z20: {
    zIndex: "20",
  },
  m0: {
    margin: "0",
  },
  phoneMt15: {
    "@media (max-width: 720px)": {
      marginTop: "calc(4px * 1.5)",
    },
  },
  sticky: {
    position: "sticky",
  },
  top0: {
    top: "0",
  },
  z10: {
    zIndex: "10",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  beforePointerEventsNone: {
    "::before": {
      content: '""',
      pointerEvents: "none",
    },
  },
  beforeAbsolute: {
    "::before": {
      content: '""',
      position: "absolute",
    },
  },
  beforeInsetX0: {
    "::before": {
      content: '""',
      insetInline: "0",
    },
  },
  beforeBottomFull: {
    "::before": {
      content: '""',
      bottom: "100%",
    },
  },
  beforeH11: {
    "::before": {
      content: '""',
      height: "calc(4px * 11)",
    },
  },
  beforeBgSurface: {
    "::before": {
      content: '""',
      backgroundColor: "var(--bg)",
    },
  },
  beforeContent: {
    "::before": {
      content: "''",
    },
  },
  afterPointerEventsNone: {
    "::after": {
      content: '""',
      pointerEvents: "none",
    },
  },
  afterAbsolute: {
    "::after": {
      content: '""',
      position: "absolute",
    },
  },
  afterInsetX0: {
    "::after": {
      content: '""',
      insetInline: "0",
    },
  },
  afterTopFull: {
    "::after": {
      content: '""',
      top: "100%",
    },
  },
  afterH6: {
    "::after": {
      content: '""',
      height: "calc(4px * 6)",
    },
  },
  afterBgLinearGradientToBottomVarBgTransparent: {
    "::after": {
      content: '""',
      backgroundImage: "linear-gradient(to bottom,var(--bg),transparent)",
    },
  },
  afterContent: {
    "::after": {
      content: "''",
    },
  },
  phoneBeforeH4: {
    "@media (max-width: 720px)": {
      "::before": {
        content: '""',
        height: "calc(4px * 4)",
      },
    },
  },
  placeItemsCenter: {
    placeItems: "center",
  },
  colStart1: {
    gridColumnStart: "1",
  },
  rowStart1: {
    gridRowStart: "1",
  },
  phoneFlex: {
    "@media (max-width: 720px)": {
      display: "flex",
    },
  },
  phoneInlineFlex: {
    "@media (max-width: 720px)": {
      display: "inline-flex",
    },
  },
  phoneW11: {
    "@media (max-width: 720px)": {
      width: "calc(4px * 11)",
    },
  },
  p4: {
    padding: "calc(4px * 4)",
  },
  gridCols4: {
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  },
  colSpan2: {
    gridColumn: "span 2 / span 2",
  },
  phoneColSpan1: {
    "@media (max-width: 720px)": {
      gridColumn: "span 1 / span 1",
    },
  },
  left25: {
    left: "calc(4px * 2.5)",
  },
  top12: {
    top: "calc(1 / 2 * 100%)",
  },
  TranslateY12: {
    translate: "0 calc(calc(1 / 2 * 100%) * -1)",
  },
  pl9: {
    paddingLeft: "calc(4px * 9)",
  },
  phoneTextLeft: {
    "@media (max-width: 720px)": {
      textAlign: "left",
    },
  },
  itemsStart: {
    alignItems: "flex-start",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  phoneFlexCol: {
    "@media (max-width: 720px)": {
      flexDirection: "column",
    },
  },
  h15: {
    height: "calc(4px * 1.5)",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgHover: {
    backgroundColor: "var(--hover)",
  },
  hFull: {
    height: "100%",
  },
  bgAccent: {
    backgroundColor: "var(--accent)",
  },
  transitionWidth: {
    transitionProperty: "width",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
});

// Settings maintenance for structured repo, user, workspace, and Slack channel
// memory. The server keeps provenance and controls what is pinned or retrieved.

type MemoryKind = MemoryScopeDto["scope"]["kind"];

type MemoryCategory = {
  kind: MemoryKind;
  title: string;
  pageTitle: string;
  description: string;
  targetLabel: string;
  icon: typeof IconGlobe;
  tone: MarkTone;
};

const MEMORY_CATEGORIES: MemoryCategory[] = [
  {
    kind: "team",
    title: "Workspace",
    pageTitle: "Workspace memories",
    description: "Shared across the workspace and with public Slack memory.",
    targetLabel: "Workspace",
    icon: IconGlobe,
    tone: "indigo",
  },
  {
    kind: "repo",
    title: "Repositories",
    pageTitle: "Repository memories",
    description: "Used when a session works in that repository.",
    targetLabel: "Repository",
    icon: IconBranches,
    tone: "sky",
  },
  {
    kind: "user",
    title: "Team",
    pageTitle: "Team memories",
    description:
      "Follows the teammate prompting, including their Slack DM memory.",
    targetLabel: "Teammate",
    icon: IconPeople,
    tone: "green",
  },
  {
    kind: "channel",
    title: "Slack channels",
    pageTitle: "Slack channel memories",
    description: "Used within a specific Slack channel.",
    targetLabel: "Slack channel",
    icon: IconHash,
    tone: "orange",
  },
];

function CategoryIcon({ category }: { category: MemoryCategory }) {
  const size = 40;
  const Icon = category.icon;
  return (
    <span
      className={markTileClass(size)}
      style={{
        width: size,
        height: size,
        backgroundImage: markTileGradient(category.tone),
        color: "#fff",
        boxShadow: markTileShadow(markTileInk(category.tone)),
      }}
    >
      <Icon size={22} />
    </span>
  );
}

function memoryCount(scopes: MemoryScopeSummaryDto[]): number {
  return scopes.reduce((total, scoped) => total + scoped.count, 0);
}

function CategoryCard({
  category,
  scopes,
  onOpen,
}: {
  category: MemoryCategory;
  scopes: MemoryScopeSummaryDto[];
  onOpen: () => void;
}) {
  const count = memoryCount(scopes);
  return (
    <SettingCard>
      <button
        type="button"
        {...mergeStylexProps(
          "focus-ring group",
          sx.flex,
          sx.wFull,
          sx.itemsCenter,
          sx.gap3,
          sx.rounded2xl,
          sx.px5,
          sx.py4,
          sx.textLeft,
          sx.hoverBgHover,
          sx.phoneItemsStart,
        )}
        onClick={onOpen}
      >
        <CategoryIcon category={category} />
        <span {...stylex.props(sx.minW0, sx.flex1)}>
          <span
            {...stylex.props(
              sx.block,
              sx.fontSemibold,
              sx.textFg,
              typography.itemTitle,
            )}
          >
            {category.title}
          </span>
          <span
            {...stylex.props(
              sx.mt1,
              sx.block,
              sx.leadingRelaxed,
              sx.textDim,
              typography.supporting,
            )}
          >
            {category.description}
          </span>
          <span
            {...stylex.props(
              sx.mt15,
              sx.hidden,
              sx.fontMedium,
              sx.textDim,
              sx.phoneBlock,
              typography.label,
            )}
          >
            {count} {count === 1 ? "memory" : "memories"}
          </span>
        </span>
        <span
          {...stylex.props(
            sx.flex,
            sx.shrink0,
            sx.itemsCenter,
            sx.gap2,
            sx.selfCenter,
            sx.fontMedium,
            sx.textDim,
            sx.phoneSelfStart,
            sx.phonePt2,
            typography.label,
          )}
        >
          <span {...stylex.props(sx.phoneHidden)}>
            {count} {count === 1 ? "memory" : "memories"}
          </span>
          <IconChevronRight
            size={20}
            className={mergeStylexOverrideClassName(
              "group-hover:text-dim",
              sx.textFaint,
            )}
          />
        </span>
      </button>
    </SettingCard>
  );
}

type MemoryTableRow = {
  scoped: MemoryScopeV2Dto;
  entry: MemoryRecordDto;
};

const PAGE_SIZE = 20;

const KIND_LABELS: Record<MemoryRecordKind, string> = {
  preference: "Preference",
  constraint: "Constraint",
  decision: "Decision",
  gotcha: "Gotcha",
  reference: "Reference",
  status: "Status",
};

function entryKind(entry: MemoryRecordDto): MemoryRecordKind | "legacy" {
  return entry.kind || "legacy";
}

function statusTone(state: ReturnType<typeof memoryState>) {
  if (state === "active") return "success" as const;
  if (state === "expired") return "warning" as const;
  return "neutral" as const;
}

const STATE_LABELS: Record<MemoryState, string> = {
  active: "Active",
  archived: "Archived",
  expired: "Expired",
  superseded: "Superseded",
};

function MemoryRow({
  row,
  showScope,
  selected,
  onSelected,
  onChanged,
}: {
  row: MemoryTableRow;
  showScope: boolean;
  selected: boolean;
  onSelected: (selected: boolean) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memorySummary(row.entry));
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(row.entry.details);
  const [canExpand, setCanExpand] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const textRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const summary = memorySummary(row.entry);
  const state = memoryState(row.entry);
  const kind = entryKind(row.entry);
  const review = memoryNeedsReview(row.entry);

  useLayoutEffect(() => {
    if (!editing) return;
    const textarea = editRef.current;
    if (!textarea) return;

    const resize = () => {
      textarea.style.height = "auto";
      const borderHeight = textarea.offsetHeight - textarea.clientHeight;
      textarea.style.height = `${textarea.scrollHeight + borderHeight}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [draft, editing]);

  useLayoutEffect(() => {
    if (expanded || editing) return;
    const text = textRef.current;
    if (!text) return;
    const frame = requestAnimationFrame(() => {
      setCanExpand(text.scrollHeight > text.clientHeight + 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, expanded, summary]);

  async function save() {
    const text = draft.trim();
    if (!text || text === summary) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await updateMemoryRecord(row.scoped.scope.key, row.entry.id, {
        summary: text,
      });
      setEditing(false);
      onChanged();
    } catch (error) {
      toast(errorMessage(error, "Failed to update memory"), {
        variant: "error",
      });
    }
    setBusy(false);
  }

  async function permanentlyDelete() {
    setBusy(true);
    try {
      await permanentlyDeleteMemory(row.scoped.scope.key, row.entry.id);
      toast("Memory forgotten", { variant: "success" });
      onChanged();
    } catch (error) {
      toast(errorMessage(error, "Failed to delete memory"), {
        variant: "error",
      });
      setBusy(false);
    }
  }

  async function expand() {
    setExpanded(true);
    if (details !== undefined || !row.entry.hasDetails) return;
    try {
      const response = await readMemoryRecord(
        row.scoped.scope.key,
        row.entry.id,
      );
      setDetails(response.entry.details || "");
    } catch (error) {
      toast(errorMessage(error, "Failed to load memory details"), {
        variant: "error",
      });
    }
  }

  async function act(
    action: "pin" | "unpin" | "confirm" | "archive" | "restore",
  ) {
    setBusy(true);
    try {
      await mutateMemoryRecord(row.scoped.scope.key, row.entry.id, action);
      toast(
        action === "pin"
          ? "Memory pinned"
          : action === "unpin"
            ? "Memory unpinned"
            : action === "confirm"
              ? "Memory confirmed"
              : action === "archive"
                ? "Memory archived"
                : "Memory restored",
        { variant: "success" },
      );
      onChanged();
    } catch (error) {
      toast(errorMessage(error, `Failed to ${action} memory`), {
        variant: "error",
      });
    }
    setBusy(false);
  }

  return (
    <>
      <tr
        {...mergeStylexProps(
          "first:border-t-0",
          sx.borderT,
          sx.borderLine,
          sx.alignTop,
          sx.phoneGrid,
          sx.phoneGridColsMinmax01frAuto,
          sx.phoneGapX3,
          sx.phonePx4,
          sx.phonePy3,
        )}
      >
        <td
          {...stylex.props(
            sx.w11,
            sx.px1,
            sx.py1,
            sx.phoneColStart2,
            sx.phoneRowStart1,
            sx.phoneWAuto,
            sx.phoneP0,
          )}
        >
          <label
            {...stylex.props(
              sx.flex,
              sx.size10,
              sx.cursorPointer,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.phoneSize11,
            )}
          >
            <span {...stylex.props(sx.srOnly)}>Select {summary}</span>
            <Checkbox
              checked={selected}
              onCheckedChange={(checked) => onSelected(checked === true)}
            />
          </label>
        </td>
        {showScope && (
          <td
            {...stylex.props(
              sx.w32,
              sx.px4,
              sx.py3,
              sx.fontMedium,
              sx.textDim,
              sx.phoneColStart1,
              sx.phoneRowStart1,
              sx.phoneWAuto,
              sx.phoneP0,
              typography.label,
            )}
          >
            {row.scoped.scope.label}
          </td>
        )}
        <td
          {...stylex.props(
            sx.px4,
            sx.py3,
            sx.phoneColSpan2,
            sx.phoneRowStart2,
            sx.phoneMt2,
            sx.phoneP0,
          )}
        >
          {editing ? (
            <div>
              <Textarea
                ref={editRef}
                rows={3}
                maxLength={400}
                className={mergeStylexOverrideClassName(
                  "",
                  sx.minH6em,
                  sx.resizeNone,
                  sx.overflowHidden,
                  sx.leadingRelaxed,
                  sx.phoneTextInputPhone,
                  typography.supporting,
                )}
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                    void save();
                  if (event.key === "Escape") setEditing(false);
                }}
              />
              <div
                {...stylex.props(
                  sx.mt2,
                  sx.flex,
                  sx.itemsCenter,
                  sx.justifyBetween,
                  sx.gap2,
                )}
              >
                <span
                  {...mergeStylexProps(
                    "tabular-nums",
                    sx.textFaint,
                    typography.meta,
                  )}
                >
                  {draft.length}/400
                </span>
                <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
                  <Button
                    size="sm"
                    variant="primary"
                    className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
                    disabled={busy || !draft.trim()}
                    onClick={() => void save()}
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
                    disabled={busy}
                    onClick={() => {
                      setDraft(summary);
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div {...mergeStylexProps("group/memory", sx.relative)}>
              <div
                {...stylex.props(
                  sx.mb2,
                  sx.flex,
                  sx.flexWrap,
                  sx.itemsCenter,
                  sx.gap15,
                )}
              >
                <Badge>
                  {kind === "legacy" ? "Unclassified" : KIND_LABELS[kind]}
                </Badge>
                <Badge
                  tone={row.entry.tier === "pinned" ? "accent" : "neutral"}
                >
                  {row.entry.tier === "pinned" ? "Pinned" : "Retrievable"}
                </Badge>
                <Badge tone={statusTone(state)}>{STATE_LABELS[state]}</Badge>
                {review ? (
                  <Badge tone="warning">Needs review</Badge>
                ) : row.entry.lastConfirmedAt ? (
                  <Badge tone="success">Confirmed</Badge>
                ) : null}
              </div>
              <div
                className={
                  expanded
                    ? utilityClassName("relative")
                    : utilityClassName("relative max-h-[7.5em] overflow-hidden")
                }
              >
                <div
                  ref={textRef}
                  className={utilityClassName(
                    `whitespace-pre-wrap break-words text-supporting leading-relaxed text-fg ${expanded ? "" : "line-clamp-5"}`,
                  )}
                >
                  {summary}
                </div>
                {expanded && details && (
                  <div
                    {...stylex.props(
                      sx.mt2,
                      sx.whitespacePreWrap,
                      sx.breakWords,
                      sx.leadingRelaxed,
                      sx.textDim,
                      typography.meta,
                    )}
                  >
                    {details}
                  </div>
                )}
                {!expanded && canExpand && (
                  <span
                    aria-hidden="true"
                    {...stylex.props(
                      sx.pointerEventsNone,
                      sx.absolute,
                      sx.insetX0,
                      sx.bottom0,
                      sx.h10,
                      sx.bgLinearGradientToBottomTransparentVarSettingsPlate,
                    )}
                  />
                )}
              </div>
              <div
                {...stylex.props(
                  sx.flex,
                  sx.minH10,
                  sx.itemsCenter,
                  sx.justifyBetween,
                  sx.gap2,
                  sx.phoneMt1,
                  sx.phoneFlexWrap,
                )}
              >
                <div
                  {...stylex.props(sx.flex, sx.h10, sx.minW0, sx.itemsCenter)}
                >
                  {!expanded && (canExpand || row.entry.hasDetails) && (
                    <button
                      type="button"
                      aria-expanded="false"
                      {...mergeStylexProps(
                        "focus-ring group-hover/memory:opacity-100 group-focus-within/memory:opacity-100",
                        sx.inlineFlex,
                        sx.h10,
                        sx.minH10,
                        sx.itemsCenter,
                        sx.roundedMd,
                        sx.border0,
                        sx.bgTransparent,
                        sx.px0,
                        sx.fontSemibold,
                        sx.leadingNone,
                        sx.textDim,
                        sx.opacity0,
                        sx.transitionOpacity,
                        sx.duration150,
                        sx.hoverTextFg,
                        sx.phoneH11,
                        sx.phoneMinH11,
                        sx.phoneOpacity100,
                        typography.meta,
                      )}
                      onClick={() => void expand()}
                    >
                      Read all
                    </button>
                  )}
                  {expanded && (canExpand || row.entry.hasDetails) && (
                    <button
                      type="button"
                      aria-expanded="true"
                      {...mergeStylexProps(
                        "focus-ring",
                        sx.inlineFlex,
                        sx.h10,
                        sx.minH10,
                        sx.itemsCenter,
                        sx.roundedMd,
                        sx.border0,
                        sx.bgTransparent,
                        sx.px0,
                        sx.fontSemibold,
                        sx.leadingNone,
                        sx.textDim,
                        sx.hoverTextFg,
                        sx.phoneH11,
                        sx.phoneMinH11,
                        typography.meta,
                      )}
                      onClick={() => setExpanded(false)}
                    >
                      Show less
                    </button>
                  )}
                </div>
                <div
                  {...mergeStylexProps(
                    "group-hover/memory:opacity-100 group-focus-within/memory:opacity-100",
                    sx.mlAuto,
                    sx.flex,
                    sx.h10,
                    sx.shrink0,
                    sx.itemsCenter,
                    sx.justifyEnd,
                    sx.gap1,
                    sx.opacity0,
                    sx.transitionOpacity,
                    sx.duration150,
                    sx.phoneOpacity100,
                  )}
                >
                  {review && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Confirm memory"
                      className={mergeStylexOverrideClassName(
                        "",
                        sx.size10,
                        sx.minH10,
                        sx.phoneSize11,
                        sx.phoneMinH11,
                      )}
                      icon={<IconCheck size={16} />}
                      disabled={busy}
                      onClick={() => void act("confirm")}
                    />
                  )}
                  {state === "active" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={
                        row.entry.tier === "pinned"
                          ? "Unpin memory"
                          : "Pin memory"
                      }
                      className={mergeStylexOverrideClassName(
                        "",
                        sx.size10,
                        sx.minH10,
                        sx.phoneSize11,
                        sx.phoneMinH11,
                      )}
                      icon={<IconPin size={16} />}
                      disabled={busy}
                      onClick={() =>
                        void act(row.entry.tier === "pinned" ? "unpin" : "pin")
                      }
                    />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Edit memory"
                    className={mergeStylexOverrideClassName(
                      "",
                      sx.size10,
                      sx.minH10,
                      sx.phoneSize11,
                      sx.phoneMinH11,
                    )}
                    icon={<IconPencil size={16} />}
                    disabled={busy}
                    onClick={() => {
                      setDraft(summary);
                      setEditing(true);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={
                      state === "archived" ? "Restore memory" : "Archive memory"
                    }
                    className={mergeStylexOverrideClassName(
                      "",
                      sx.size10,
                      sx.minH10,
                      sx.phoneSize11,
                      sx.phoneMinH11,
                    )}
                    icon={
                      state === "archived" ? (
                        <IconRestore size={16} />
                      ) : (
                        <IconArchive size={16} />
                      )
                    }
                    disabled={busy}
                    onClick={() =>
                      void act(state === "archived" ? "restore" : "archive")
                    }
                  />
                  {state === "archived" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Delete memory permanently"
                      className={mergeStylexOverrideClassName(
                        "",
                        sx.size10,
                        sx.minH10,
                        sx.hoverTextRed,
                        sx.phoneSize11,
                        sx.phoneMinH11,
                      )}
                      icon={<IconTrash size={16} />}
                      disabled={busy}
                      onClick={() =>
                        confirm({
                          title: "Delete this memory permanently?",
                          description:
                            "This cannot be restored. Archive memories you may need later.",
                          confirmLabel: "Delete",
                          destructive: true,
                          onConfirm: () => void permanentlyDelete(),
                        })
                      }
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </td>
        <td
          {...stylex.props(
            sx.w32,
            sx.px4,
            sx.py3,
            sx.textFaint,
            sx.phoneColStart1,
            sx.phoneRowStart3,
            sx.phoneMt2,
            sx.phoneWAuto,
            sx.phoneP0,
            typography.meta,
          )}
        >
          <div {...stylex.props(sx.fontMedium, sx.textDim)}>
            {memorySourceLabel(row.entry)}
          </div>
          <div {...stylex.props(sx.mt05)}>
            {relativeTime(memoryCreatedAt(row.entry))}
          </div>
          {row.entry.expiresAt && (
            <div {...stylex.props(sx.mt05)}>
              Expires {new Date(row.entry.expiresAt).toLocaleDateString()}
            </div>
          )}
        </td>
      </tr>
      {confirmDialog}
    </>
  );
}

function MemoryTable({
  rows,
  selectedIds,
  onSelectedIdsChange,
  onChanged,
}: {
  rows: MemoryTableRow[];
  selectedIds: Set<string>;
  onSelectedIdsChange: (ids: Set<string>) => void;
  onChanged: () => void;
}) {
  const showScope = new Set(rows.map((row) => row.scoped.scope.key)).size > 1;

  if (!rows.length) {
    return (
      <EmptyState placement="card">
        No memories in this category yet.
      </EmptyState>
    );
  }

  return (
    <SettingCard
      className={mergeStylexOverrideClassName(
        "",
        sx.overflowHidden,
        sx.borderLine,
      )}
    >
      <div {...stylex.props(sx.overflowXAuto)}>
        <table
          {...stylex.props(
            sx.wFull,
            sx.tableFixed,
            sx.borderCollapse,
            sx.phoneBlock,
          )}
        >
          <thead
            {...stylex.props(
              sx.borderB,
              sx.borderLine,
              sx.textLeft,
              sx.fontSemibold,
              sx.textFaint,
              sx.phoneSrOnly,
              typography.label,
            )}
          >
            <tr>
              <th {...stylex.props(sx.w11, sx.px3, sx.py25)}>
                <span {...stylex.props(sx.srOnly)}>Select</span>
              </th>
              {showScope && (
                <th {...stylex.props(sx.w32, sx.px4, sx.py25)}>Scope</th>
              )}
              <th {...stylex.props(sx.px4, sx.py25)}>Memory</th>
              <th {...stylex.props(sx.w32, sx.px4, sx.py25)}>Saved</th>
            </tr>
          </thead>
          <tbody {...stylex.props(sx.phoneBlock)}>
            {rows.map((row) => (
              <MemoryRow
                key={`${row.scoped.scope.key}:${row.entry.id}`}
                row={row}
                showScope={showScope}
                selected={selectedIds.has(row.entry.id)}
                onSelected={(selected) => {
                  const next = new Set(selectedIds);
                  if (selected) next.add(row.entry.id);
                  else next.delete(row.entry.id);
                  onSelectedIdsChange(next);
                }}
                onChanged={onChanged}
              />
            ))}
          </tbody>
        </table>
      </div>
    </SettingCard>
  );
}

function AddMemoryDialog({
  category,
  scopes,
  selectedScopeKey,
  open,
  onOpenChange,
  onChanged,
}: {
  category: MemoryCategory;
  scopes: MemoryScopeSummaryDto[];
  selectedScopeKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [scopeKey, setScopeKey] = useState(scopes[0]?.scope.key || "");
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<MemoryRecordKind>("decision");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setScopeKey(
        scopes.some((scope) => scope.scope.key === selectedScopeKey)
          ? selectedScopeKey
          : scopes[0]?.scope.key || "",
      );
      setDraft("");
      setKind("decision");
      setExpiresAt("");
    }
  }, [open, scopes, selectedScopeKey]);

  async function add() {
    const text = draft.trim();
    if (!scopeKey || !text) return;
    setBusy(true);
    try {
      await addStructuredMemory({
        scopeKey,
        summary: text,
        kind,
        expiresAt:
          kind === "status" ? new Date(expiresAt).toISOString() : undefined,
        by: getCurrentUser() || "settings",
      });
      toast("Memory saved", { variant: "success" });
      onOpenChange(false);
      onChanged();
    } catch (error) {
      toast(errorMessage(error, "Failed to add memory"), { variant: "error" });
    }
    setBusy(false);
  }

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Modal.Header
          title={`Add ${category.title.toLowerCase()} memory`}
          description="Save a durable, self-contained fact for this scope."
        />
        {scopes.length > 1 && (
          <Field label={category.targetLabel}>
            <Select
              className={mergeStylexOverrideClassName(
                "",
                sx.phoneMinH11,
                sx.phoneTextInputPhone,
              )}
              value={scopeKey}
              onChange={(event) => setScopeKey(event.target.value)}
            >
              {scopes.map((scoped) => (
                <option key={scoped.scope.key} value={scoped.scope.key}>
                  {scoped.scope.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Memory">
          <Textarea
            rows={4}
            maxLength={400}
            value={draft}
            autoFocus
            placeholder="A durable, self-contained fact…"
            className={mergeStylexOverrideClassName("", sx.phoneTextInputPhone)}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                void add();
            }}
          />
        </Field>
        <div
          {...stylex.props(
            sx.mt3,
            sx.grid,
            sx.gridCols2,
            sx.gap3,
            sx.phoneGridCols1,
          )}
        >
          <Field label="Kind">
            <Select
              className={mergeStylexOverrideClassName(
                "",
                sx.phoneMinH11,
                sx.phoneTextInputPhone,
              )}
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as MemoryRecordKind)
              }
            >
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          {kind === "status" && (
            <Field label="Expires">
              <Input
                className={mergeStylexOverrideClassName(
                  "",
                  sx.phoneMinH11,
                  sx.phoneTextInputPhone,
                )}
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </Field>
          )}
        </div>
        <div
          {...mergeStylexProps(
            "tabular-nums",
            sx.mt1,
            sx.textRight,
            sx.textFaint,
            typography.meta,
          )}
        >
          {draft.length}/400
        </div>
        <Modal.Footer>
          <Modal.Close
            render={
              <Button
                className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
                variant="ghost"
                disabled={busy}
              >
                Cancel
              </Button>
            }
          />
          <Button
            className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
            variant="primary"
            disabled={
              busy ||
              !scopeKey ||
              !draft.trim() ||
              (kind === "status" && !expiresAt)
            }
            onClick={() => void add()}
          >
            {busy ? "Saving…" : "Save memory"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

function MergeMemoryDialog({
  scopeKey,
  ids,
  open,
  onOpenChange,
  onChanged,
}: {
  scopeKey: string;
  ids: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [summary, setSummary] = useState("");
  const [kind, setKind] = useState<MemoryRecordKind>("decision");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSummary("");
    setKind("decision");
    setExpiresAt("");
  }, [open]);

  async function merge() {
    setBusy(true);
    try {
      await mergeMemoryRecords({
        scopeKey,
        ids,
        summary: summary.trim(),
        kind,
        expiresAt:
          kind === "status" ? new Date(expiresAt).toISOString() : undefined,
      });
      toast("Memories merged", { variant: "success" });
      onOpenChange(false);
      onChanged();
    } catch (error) {
      toast(errorMessage(error, "Failed to merge memories"), {
        variant: "error",
      });
    }
    setBusy(false);
  }

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <Modal.Header
          title={`Merge ${ids.length} memories`}
          description="Replace the selected records with one concise fact. The originals stay recoverable."
        />
        <Field label="Summary">
          <Textarea
            className={mergeStylexOverrideClassName("", sx.phoneTextInputPhone)}
            rows={4}
            maxLength={400}
            value={summary}
            autoFocus
            onChange={(event) => setSummary(event.target.value)}
          />
        </Field>
        <div
          {...stylex.props(
            sx.mt3,
            sx.grid,
            sx.gridCols2,
            sx.gap3,
            sx.phoneGridCols1,
          )}
        >
          <Field label="Kind">
            <Select
              className={mergeStylexOverrideClassName(
                "",
                sx.phoneMinH11,
                sx.phoneTextInputPhone,
              )}
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as MemoryRecordKind)
              }
            >
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          {kind === "status" && (
            <Field label="Expires">
              <Input
                className={mergeStylexOverrideClassName(
                  "",
                  sx.phoneMinH11,
                  sx.phoneTextInputPhone,
                )}
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </Field>
          )}
        </div>
        <div
          {...mergeStylexProps(
            "tabular-nums",
            sx.mt1,
            sx.textRight,
            sx.textFaint,
            typography.meta,
          )}
        >
          {summary.length}/400
        </div>
        <Modal.Footer>
          <Modal.Close
            render={
              <Button
                className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
                variant="ghost"
                disabled={busy}
              >
                Cancel
              </Button>
            }
          />
          <Button
            className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
            variant="primary"
            disabled={
              busy || !summary.trim() || (kind === "status" && !expiresAt)
            }
            onClick={() => void merge()}
          >
            {busy ? "Merging…" : "Merge"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}

function CategoryPage({
  category,
  scopes,
  onBack,
  onScopesChanged,
}: {
  category: MemoryCategory;
  scopes: MemoryScopeSummaryDto[];
  onBack: () => void;
  onScopesChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [scopeKey, setScopeKey] = useState(scopes[0]?.scope.key || "");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryRecordKind | "">("");
  const [state, setState] = useState<MemoryState | "">("");
  const [review, setReview] = useState<"" | "needs_review" | "confirmed">("");
  const [items, setItems] = useState<MemoryRecordDto[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>(
    [],
  );
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [reloadId, setReloadId] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);
  const count = memoryCount(scopes);
  const canAdd = scopes.length > 0;
  const selectedScope =
    scopes.find((scope) => scope.scope.key === scopeKey) || scopes[0];

  useEffect(() => {
    if (!scopeKey) return;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        fetchMemoryPage({
          scopeKey,
          q: query,
          kind: kind || undefined,
          state: state || undefined,
          review: review || undefined,
          cursor,
          limit: PAGE_SIZE,
        })
          .then((page) => {
            if (cancelled) return;
            setItems(page.items);
            setNextCursor(page.nextCursor);
            setError(null);
          })
          .catch((fetchError) => {
            if (!cancelled) setError(fetchError.message);
          });
      },
      query ? 180 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [scopeKey, query, kind, state, review, cursor, reloadId]);

  function resetPage() {
    setCursor(undefined);
    setCursorHistory([]);
    setItems(null);
    setSelectedIds(new Set());
  }

  function changed() {
    setSelectedIds(new Set());
    setReloadId((value) => value + 1);
    onScopesChanged();
  }

  const rows: MemoryTableRow[] = selectedScope
    ? (items || []).map((entry) => ({
        scoped: { scope: selectedScope.scope, entries: items || [] },
        entry,
      }))
    : [];

  return (
    <SettingsPanel>
      <h2
        {...stylex.props(
          sx.relative,
          sx.z20,
          sx.m0,
          sx.hidden,
          sx.px5,
          sx.fontSemibold,
          sx.textFg,
          sx.phoneBlock,
          typography.sectionTitle,
        )}
      >
        {category.pageTitle}
      </h2>
      <SettingsHeader
        title={category.pageTitle}
        description={`${category.description} ${count} ${count === 1 ? "memory" : "memories"}.`}
        className={mergeStylexOverrideClassName(
          "",
          sx.relative,
          sx.z20,
          sx.phoneMt15,
        )}
      />
      <div
        {...stylex.props(
          sx.sticky,
          sx.top0,
          sx.z10,
          sx.mb3,
          sx.flex,
          sx.itemsCenter,
          sx.justifyBetween,
          sx.gap3,
          sx.bgSurface,
          sx.px5,
          sx.py2,
          sx.beforePointerEventsNone,
          sx.beforeAbsolute,
          sx.beforeInsetX0,
          sx.beforeBottomFull,
          sx.beforeH11,
          sx.beforeBgSurface,
          sx.beforeContent,
          sx.afterPointerEventsNone,
          sx.afterAbsolute,
          sx.afterInsetX0,
          sx.afterTopFull,
          sx.afterH6,
          sx.afterBgLinearGradientToBottomVarBgTransparent,
          sx.afterContent,
          sx.phoneBeforeH4,
        )}
      >
        <Button
          size="sm"
          variant="ghost"
          className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
          icon={<IconChevronLeft size={18} />}
          onClick={onBack}
        >
          Back
        </Button>
        <div {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}>
          {selectedIds.size >= 2 && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className={mergeStylexOverrideClassName(
                  "group",
                  sx.phoneMinH11,
                )}
                aria-label={`Clear ${selectedIds.size} selected memories`}
                title="Clear selection"
                onClick={() => setSelectedIds(new Set())}
              >
                <span
                  {...stylex.props(
                    sx.grid,
                    sx.placeItemsCenter,
                    sx.phoneHidden,
                  )}
                >
                  <span
                    {...mergeStylexProps(
                      "group-hover:opacity-0 group-focus-visible:opacity-0",
                      sx.colStart1,
                      sx.rowStart1,
                      sx.transitionOpacity,
                    )}
                  >
                    {selectedIds.size} selected
                  </span>
                  <IconX
                    size={16}
                    className={mergeStylexOverrideClassName(
                      "group-hover:opacity-100 group-focus-visible:opacity-100",
                      sx.colStart1,
                      sx.rowStart1,
                      sx.opacity0,
                      sx.transitionOpacity,
                    )}
                  />
                </span>
                <span
                  {...stylex.props(
                    sx.hidden,
                    sx.itemsCenter,
                    sx.gap15,
                    sx.phoneFlex,
                  )}
                >
                  {selectedIds.size} selected
                  <IconX size={16} />
                </span>
              </Button>
              <Button
                size="sm"
                variant="soft"
                className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
                onClick={() => setMerging(true)}
              >
                Merge
              </Button>
            </>
          )}
          <Button
            size="sm"
            className={
              selectedIds.size >= 2
                ? utilityClassName("phone:hidden")
                : utilityClassName("phone:min-h-11")
            }
            icon={<IconPlus size={16} />}
            disabled={!canAdd}
            onClick={() => setAdding(true)}
          >
            Add memory
          </Button>
          {selectedIds.size >= 2 && (
            <Button
              size="sm"
              className={mergeStylexOverrideClassName(
                "",
                sx.hidden,
                sx.phoneInlineFlex,
                sx.phoneMinH11,
                sx.phoneW11,
              )}
              icon={<IconPlus size={18} />}
              aria-label="Add memory"
              title="Add memory"
              disabled={!canAdd}
              onClick={() => setAdding(true)}
            />
          )}
        </div>
      </div>
      {canAdd && (
        <SettingCard
          className={mergeStylexOverrideClassName(
            "",
            sx.mb3,
            sx.borderLine,
            sx.p4,
          )}
        >
          <SettingGroup className={mergeStylexOverrideClassName("", sx.gap2)}>
            <div
              {...stylex.props(
                sx.grid,
                sx.gridCols4,
                sx.itemsCenter,
                sx.gap2,
                sx.phoneGridCols1,
              )}
            >
              <label
                {...stylex.props(
                  sx.relative,
                  sx.colSpan2,
                  sx.block,
                  sx.minW0,
                  sx.phoneColSpan1,
                )}
              >
                <span {...stylex.props(sx.srOnly)}>Search memories</span>
                <IconSearch
                  size={16}
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.pointerEventsNone,
                    sx.absolute,
                    sx.left25,
                    sx.top12,
                    sx.TranslateY12,
                    sx.textFaint,
                  )}
                />
                <Input
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.pl9,
                    sx.phoneMinH11,
                    sx.phoneTextInputPhone,
                  )}
                  type="search"
                  value={query}
                  placeholder="Search memories"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    resetPage();
                  }}
                />
              </label>
              <span
                {...stylex.props(
                  sx.colSpan2,
                  sx.textRight,
                  sx.textFaint,
                  sx.phoneColSpan1,
                  sx.phoneTextLeft,
                  typography.meta,
                )}
              >
                {selectedScope?.count || 0} total ·{" "}
                {selectedScope?.pinnedCount || 0} pinned ·{" "}
                {selectedScope?.reviewCount || 0} to review
              </span>
            </div>
            <div
              {...stylex.props(
                sx.grid,
                sx.gridCols4,
                sx.gap2,
                sx.phoneGridCols1,
              )}
            >
              <OptionSelect
                label={category.targetLabel}
                className={mergeStylexOverrideClassName(
                  "",
                  sx.phoneMinH11,
                  sx.phoneTextInputPhone,
                )}
                value={scopeKey}
                options={scopes.map(({ scope }) => ({
                  value: scope.key,
                  label: scope.label,
                }))}
                onChange={(value) => {
                  setScopeKey(value);
                  resetPage();
                }}
              />
              <OptionSelect<MemoryRecordKind | "">
                label="Memory kind"
                className={mergeStylexOverrideClassName(
                  "",
                  sx.phoneMinH11,
                  sx.phoneTextInputPhone,
                )}
                value={kind}
                options={[
                  { value: "", label: "All kinds" },
                  ...Object.entries(KIND_LABELS).map(([value, label]) => ({
                    value: value as MemoryRecordKind,
                    label,
                  })),
                ]}
                onChange={(value) => {
                  setKind(value);
                  resetPage();
                }}
              />
              <OptionSelect<MemoryState | "">
                label="Memory state"
                className={mergeStylexOverrideClassName(
                  "",
                  sx.phoneMinH11,
                  sx.phoneTextInputPhone,
                )}
                value={state}
                options={[
                  { value: "", label: "Active" },
                  { value: "archived", label: "Archived" },
                  { value: "expired", label: "Expired" },
                  { value: "superseded", label: "Superseded" },
                ]}
                onChange={(value) => {
                  setState(value);
                  resetPage();
                }}
              />
              <OptionSelect<typeof review>
                label="Review state"
                className={mergeStylexOverrideClassName(
                  "",
                  sx.phoneMinH11,
                  sx.phoneTextInputPhone,
                )}
                value={review}
                options={[
                  { value: "", label: "All review states" },
                  { value: "needs_review", label: "Needs review" },
                  { value: "confirmed", label: "Confirmed" },
                ]}
                onChange={(value) => {
                  setReview(value);
                  resetPage();
                }}
              />
            </div>
          </SettingGroup>
        </SettingCard>
      )}
      {!canAdd ? (
        <EmptyState placement="card">
          No {category.title.toLowerCase()} scopes exist yet. They appear here
          after that scope first stores a memory.
        </EmptyState>
      ) : error ? (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      ) : items === null ? (
        <SettingCardSkeleton rows={3} label="Loading memories" />
      ) : (
        <>
          <MemoryTable
            rows={rows}
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
            onChanged={changed}
          />
          {(cursorHistory.length > 0 || nextCursor) && (
            <div
              {...stylex.props(
                sx.mt3,
                sx.flex,
                sx.itemsCenter,
                sx.justifyEnd,
                sx.gap2,
              )}
            >
              <Button
                size="sm"
                variant="ghost"
                className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
                disabled={!cursorHistory.length}
                onClick={() => {
                  const history = cursorHistory.slice(0, -1);
                  setCursor(cursorHistory.at(-1));
                  setCursorHistory(history);
                  setItems(null);
                }}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={mergeStylexOverrideClassName("", sx.phoneMinH11)}
                disabled={!nextCursor}
                onClick={() => {
                  setCursorHistory((history) => [...history, cursor]);
                  setCursor(nextCursor);
                  setItems(null);
                }}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
      <AddMemoryDialog
        category={category}
        scopes={scopes}
        selectedScopeKey={scopeKey}
        open={adding}
        onOpenChange={setAdding}
        onChanged={changed}
      />
      <MergeMemoryDialog
        scopeKey={scopeKey}
        ids={[...selectedIds]}
        open={merging}
        onOpenChange={setMerging}
        onChanged={changed}
      />
    </SettingsPanel>
  );
}

export function MemoryPanel() {
  const [scopes, setScopes] = useState<MemoryScopeSummaryDto[] | null>(null);
  const [stats, setStats] = useState<MemoryV2Stats | null>(null);
  const [selectedKind, setSelectedKind] = useState<MemoryKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    fetchMemoryScopes()
      .then(async (response) => {
        // Configured Slack channels are valid memory scopes even before their
        // first entry creates a store file. Merge them into the UI model so the
        // existing POST /api/memory route can create that first entry without
        // any memory-storage or backend contract change.
        const channels = await fetch(`${BASE_PATH}/api/slack/channels`)
          .then((result) => (result.ok ? result.json() : null))
          .then(
            (body: { channels?: Array<{ id: string; name: string }> } | null) =>
              body?.channels || [],
          )
          .catch(() => []);
        const next = [...response.scopes];
        for (const channel of channels) {
          const key = `channel-${channel.id}`;
          if (!next.some((scoped) => scoped.scope.key === key)) {
            next.push({
              scope: { key, kind: "channel", label: channel.name },
              count: 0,
              pinnedCount: 0,
              reviewCount: 0,
              ambientChars: 0,
            });
          }
        }
        setScopes(next);
        setStats(response.stats || null);
        setError(null);
      })
      .catch((fetchError) => setError(fetchError.message));
  }

  useEffect(reload, []);

  if (!scopes) {
    return (
      <SettingsPanel>
        <SettingsHeader
          title="Memories"
          description="Durable facts scoped to your workspace, repositories, team, and Slack channels."
        />
        {error ? (
          <InlineAlert>{error}</InlineAlert>
        ) : (
          <div {...stylex.props(sx.grid, sx.gap3)}>
            {MEMORY_CATEGORIES.map((category) => (
              <SettingCardSkeleton
                key={category.kind}
                rows={1}
                icon={40}
                label={`Loading ${category.title.toLowerCase()} memory`}
              />
            ))}
          </div>
        )}
      </SettingsPanel>
    );
  }

  const selectedCategory = MEMORY_CATEGORIES.find(
    (category) => category.kind === selectedKind,
  );
  if (selectedCategory) {
    return (
      <CategoryPage
        category={selectedCategory}
        scopes={scopes.filter(
          (scoped) => scoped.scope.kind === selectedCategory.kind,
        )}
        onBack={() => setSelectedKind(null)}
        onScopesChanged={reload}
      />
    );
  }

  return (
    <SettingsPanel>
      <SettingsHeader
        title="Memories"
        description="Durable facts scoped to your workspace, repositories, team, and Slack channels."
      />
      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      {stats && (
        <SettingCard
          className={mergeStylexOverrideClassName("", sx.mb3, sx.px5, sx.py4)}
        >
          <div
            {...stylex.props(
              sx.flex,
              sx.itemsStart,
              sx.justifyBetween,
              sx.gap4,
              sx.phoneFlexCol,
            )}
          >
            <div>
              <div
                {...stylex.props(
                  sx.fontSemibold,
                  sx.textFg,
                  typography.itemTitle,
                )}
              >
                Prompt budget
              </div>
              <div {...stylex.props(sx.mt1, sx.textDim, typography.supporting)}>
                {stats.mode === "legacy"
                  ? "Legacy rollback is active. Current facts are injected without v2 retrieval budgets."
                  : "Only pinned, trusted summaries are ambient. Other memories are retrieved when relevant."}
              </div>
            </div>
            <div {...stylex.props(sx.shrink0, sx.textRight, sx.phoneTextLeft)}>
              <div
                {...mergeStylexProps(
                  "tabular-nums",
                  sx.fontSemibold,
                  sx.textFg,
                  typography.itemTitle,
                )}
              >
                {(stats.ambientUsedBytes || 0).toLocaleString()} /{" "}
                {(stats.ambientBudgetBytes || 0).toLocaleString()} bytes
              </div>
              <div {...stylex.props(sx.mt1, sx.textFaint, typography.meta)}>
                {stats.reviewCount || 0} memories need review
              </div>
            </div>
          </div>
          <div
            {...stylex.props(
              sx.mt3,
              sx.h15,
              sx.overflowHidden,
              sx.roundedFull,
              sx.bgHover,
            )}
            role="progressbar"
            aria-label="Ambient memory budget"
            aria-valuemin={0}
            aria-valuemax={stats.ambientBudgetBytes || 1}
            aria-valuenow={Math.min(
              stats.ambientUsedBytes || 0,
              stats.ambientBudgetBytes || 1,
            )}
          >
            <div
              {...stylex.props(
                sx.hFull,
                sx.roundedFull,
                sx.bgAccent,
                sx.transitionWidth,
              )}
              style={{
                width: `${Math.min(100, ((stats.ambientUsedBytes || 0) / Math.max(1, stats.ambientBudgetBytes || 1)) * 100)}%`,
              }}
            />
          </div>
        </SettingCard>
      )}
      <div {...stylex.props(sx.grid, sx.gap3)}>
        {MEMORY_CATEGORIES.map((category) => (
          <CategoryCard
            key={category.kind}
            category={category}
            scopes={scopes.filter(
              (scoped) => scoped.scope.kind === category.kind,
            )}
            onOpen={() => setSelectedKind(category.kind)}
          />
        ))}
      </div>
    </SettingsPanel>
  );
}
