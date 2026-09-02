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
        className="focus-ring group flex w-full items-center gap-3 rounded-2xl px-5 py-4 text-left hover:bg-hover phone:items-start"
        onClick={onOpen}
      >
        <CategoryIcon category={category} />
        <span className="min-w-0 flex-1">
          <span className="block text-item-title font-semibold text-fg">
            {category.title}
          </span>
          <span className="mt-1 block text-supporting leading-relaxed text-dim">
            {category.description}
          </span>
          <span className="mt-1.5 hidden text-label font-medium text-dim phone:block">
            {count} {count === 1 ? "memory" : "memories"}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 self-center text-label font-medium text-dim phone:self-start phone:pt-2">
          <span className="phone:hidden">
            {count} {count === 1 ? "memory" : "memories"}
          </span>
          <IconChevronRight
            size={20}
            className="text-faint group-hover:text-dim"
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

const MEMORY_KIND_OPTIONS = [
  { value: "preference", label: "Preference" },
  { value: "constraint", label: "Constraint" },
  { value: "decision", label: "Decision" },
  { value: "gotcha", label: "Gotcha" },
  { value: "reference", label: "Reference" },
  { value: "status", label: "Status" },
] satisfies Array<{ value: MemoryRecordKind; label: string }>;

function memoryRecordKind(value: string): MemoryRecordKind {
  return memoryKindOption(value)?.value ?? "decision";
}

function memoryKindOption(value: string) {
  return MEMORY_KIND_OPTIONS.find((option) => option.value === value);
}

function memoryKindLabel(kind: MemoryRecordKind): string {
  return memoryKindOption(kind)?.label ?? kind;
}

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
      <tr className="border-t border-line align-top first:border-t-0 phone:grid phone:grid-cols-[minmax(0,1fr)_auto] phone:gap-x-3 phone:px-4 phone:py-3">
        <td className="w-11 px-1 py-1 phone:col-start-2 phone:row-start-1 phone:w-auto phone:p-0">
          <label className="flex size-10 cursor-pointer items-center justify-center phone:size-11">
            <span className="sr-only">Select {summary}</span>
            <Checkbox
              checked={selected}
              onCheckedChange={(checked) => onSelected(checked === true)}
            />
          </label>
        </td>
        {showScope && (
          <td className="w-32 px-4 py-3 text-label font-medium text-dim phone:col-start-1 phone:row-start-1 phone:w-auto phone:p-0">
            {row.scoped.scope.label}
          </td>
        )}
        <td className="px-4 py-3 phone:col-span-2 phone:row-start-2 phone:mt-2 phone:p-0">
          {editing ? (
            <div>
              <Textarea
                ref={editRef}
                rows={3}
                maxLength={400}
                className="min-h-[6em] resize-none overflow-hidden text-supporting leading-relaxed phone:text-input-phone"
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                    void save();
                  if (event.key === "Escape") setEditing(false);
                }}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-meta tabular-nums text-faint">
                  {draft.length}/400
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    className="phone:min-h-11"
                    disabled={busy || !draft.trim()}
                    onClick={() => void save()}
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="phone:min-h-11"
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
            <div className="group/memory relative">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <Badge>
                  {kind === "legacy" ? "Unclassified" : memoryKindLabel(kind)}
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
                    ? "relative"
                    : "relative max-h-[7.5em] overflow-hidden"
                }
              >
                <div
                  ref={textRef}
                  className={`whitespace-pre-wrap break-words text-supporting leading-relaxed text-fg ${expanded ? "" : "line-clamp-5"}`}
                >
                  {summary}
                </div>
                {expanded && details && (
                  <div className="mt-2 whitespace-pre-wrap break-words text-meta leading-relaxed text-dim">
                    {details}
                  </div>
                )}
                {!expanded && canExpand && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-[linear-gradient(to_bottom,transparent,var(--settings-plate))]"
                  />
                )}
              </div>
              <div className="flex min-h-10 items-center justify-between gap-2 phone:mt-1 phone:flex-wrap">
                <div className="flex h-10 min-w-0 items-center">
                  {!expanded && (canExpand || row.entry.hasDetails) && (
                    <button
                      type="button"
                      aria-expanded="false"
                      className="focus-ring inline-flex h-10 min-h-10 items-center rounded-md border-0 bg-transparent px-0 text-meta font-semibold leading-none text-dim opacity-0 transition-opacity duration-150 hover:text-fg group-hover/memory:opacity-100 group-focus-within/memory:opacity-100 phone:h-11 phone:min-h-11 phone:opacity-100"
                      onClick={() => void expand()}
                    >
                      Read all
                    </button>
                  )}
                  {expanded && (canExpand || row.entry.hasDetails) && (
                    <button
                      type="button"
                      aria-expanded="true"
                      className="focus-ring inline-flex h-10 min-h-10 items-center rounded-md border-0 bg-transparent px-0 text-meta font-semibold leading-none text-dim hover:text-fg phone:h-11 phone:min-h-11"
                      onClick={() => setExpanded(false)}
                    >
                      Show less
                    </button>
                  )}
                </div>
                <div className="ml-auto flex h-10 shrink-0 items-center justify-end gap-1 opacity-0 transition-opacity duration-150 group-hover/memory:opacity-100 group-focus-within/memory:opacity-100 phone:opacity-100">
                  {review && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Confirm memory"
                      className="size-10 min-h-10 phone:size-11 phone:min-h-11"
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
                      className="size-10 min-h-10 phone:size-11 phone:min-h-11"
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
                    className="size-10 min-h-10 phone:size-11 phone:min-h-11"
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
                    className="size-10 min-h-10 phone:size-11 phone:min-h-11"
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
                      className="size-10 min-h-10 hover:text-red phone:size-11 phone:min-h-11"
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
        <td className="w-32 px-4 py-3 text-meta text-faint phone:col-start-1 phone:row-start-3 phone:mt-2 phone:w-auto phone:p-0">
          <div className="font-medium text-dim">
            {memorySourceLabel(row.entry)}
          </div>
          <div className="mt-0.5">
            {relativeTime(memoryCreatedAt(row.entry))}
          </div>
          {row.entry.expiresAt && (
            <div className="mt-0.5">
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
    <SettingCard className="overflow-hidden border-line">
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse phone:block">
          <thead className="border-b border-line text-left text-label font-semibold text-faint phone:sr-only">
            <tr>
              <th className="w-11 px-3 py-2.5">
                <span className="sr-only">Select</span>
              </th>
              {showScope && <th className="w-32 px-4 py-2.5">Scope</th>}
              <th className="px-4 py-2.5">Memory</th>
              <th className="w-32 px-4 py-2.5">Saved</th>
            </tr>
          </thead>
          <tbody className="phone:block">
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
              className="phone:min-h-11 phone:text-input-phone"
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
            className="phone:text-input-phone"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                void add();
            }}
          />
        </Field>
        <div className="mt-3 grid grid-cols-2 gap-3 phone:grid-cols-1">
          <Field label="Kind">
            <Select
              className="phone:min-h-11 phone:text-input-phone"
              value={kind}
              onChange={(event) =>
                setKind(memoryRecordKind(event.target.value))
              }
            >
              {MEMORY_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          {kind === "status" && (
            <Field label="Expires">
              <Input
                className="phone:min-h-11 phone:text-input-phone"
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </Field>
          )}
        </div>
        <div className="mt-1 text-right text-meta tabular-nums text-faint">
          {draft.length}/400
        </div>
        <Modal.Footer>
          <Modal.Close
            render={
              <Button
                className="phone:min-h-11"
                variant="ghost"
                disabled={busy}
              >
                Cancel
              </Button>
            }
          />
          <Button
            className="phone:min-h-11"
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
            className="phone:text-input-phone"
            rows={4}
            maxLength={400}
            value={summary}
            autoFocus
            onChange={(event) => setSummary(event.target.value)}
          />
        </Field>
        <div className="mt-3 grid grid-cols-2 gap-3 phone:grid-cols-1">
          <Field label="Kind">
            <Select
              className="phone:min-h-11 phone:text-input-phone"
              value={kind}
              onChange={(event) =>
                setKind(memoryRecordKind(event.target.value))
              }
            >
              {MEMORY_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          {kind === "status" && (
            <Field label="Expires">
              <Input
                className="phone:min-h-11 phone:text-input-phone"
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </Field>
          )}
        </div>
        <div className="mt-1 text-right text-meta tabular-nums text-faint">
          {summary.length}/400
        </div>
        <Modal.Footer>
          <Modal.Close
            render={
              <Button
                className="phone:min-h-11"
                variant="ghost"
                disabled={busy}
              >
                Cancel
              </Button>
            }
          />
          <Button
            className="phone:min-h-11"
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
      <h2 className="relative z-20 m-0 hidden px-5 text-section-title font-semibold text-fg phone:block">
        {category.pageTitle}
      </h2>
      <SettingsHeader
        title={category.pageTitle}
        description={`${category.description} ${count} ${count === 1 ? "memory" : "memories"}.`}
        className="relative z-20 phone:mt-1.5"
      />
      <div className="sticky top-0 z-10 mb-3 flex items-center justify-between gap-3 bg-surface px-5 py-2 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-11 before:bg-surface before:content-[''] after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-[linear-gradient(to_bottom,var(--bg),transparent)] after:content-[''] phone:before:h-4">
        <Button
          size="sm"
          variant="ghost"
          className="phone:min-h-11"
          icon={<IconChevronLeft size={18} />}
          onClick={onBack}
        >
          Back
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          {selectedIds.size >= 2 && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="group phone:min-h-11"
                aria-label={`Clear ${selectedIds.size} selected memories`}
                title="Clear selection"
                onClick={() => setSelectedIds(new Set())}
              >
                <span className="grid place-items-center phone:hidden">
                  <span className="col-start-1 row-start-1 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                    {selectedIds.size} selected
                  </span>
                  <IconX
                    size={16}
                    className="col-start-1 row-start-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                  />
                </span>
                <span className="hidden items-center gap-1.5 phone:flex">
                  {selectedIds.size} selected
                  <IconX size={16} />
                </span>
              </Button>
              <Button
                size="sm"
                variant="soft"
                className="phone:min-h-11"
                onClick={() => setMerging(true)}
              >
                Merge
              </Button>
            </>
          )}
          <Button
            size="sm"
            className={
              selectedIds.size >= 2 ? "phone:hidden" : "phone:min-h-11"
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
              className="hidden phone:inline-flex phone:min-h-11 phone:w-11"
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
        <SettingCard className="mb-3 border-line p-4">
          <SettingGroup className="gap-2">
            <div className="grid grid-cols-4 items-center gap-2 phone:grid-cols-1">
              <label className="relative col-span-2 block min-w-0 phone:col-span-1">
                <span className="sr-only">Search memories</span>
                <IconSearch
                  size={16}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
                />
                <Input
                  className="pl-9 phone:min-h-11 phone:text-input-phone"
                  type="search"
                  value={query}
                  placeholder="Search memories"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    resetPage();
                  }}
                />
              </label>
              <span className="col-span-2 text-right text-meta text-faint phone:col-span-1 phone:text-left">
                {selectedScope?.count || 0} total ·{" "}
                {selectedScope?.pinnedCount || 0} pinned ·{" "}
                {selectedScope?.reviewCount || 0} to review
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2 phone:grid-cols-1">
              <OptionSelect
                label={category.targetLabel}
                className="phone:min-h-11 phone:text-input-phone"
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
                className="phone:min-h-11 phone:text-input-phone"
                value={kind}
                options={[
                  { value: "", label: "All kinds" },
                  ...MEMORY_KIND_OPTIONS,
                ]}
                onChange={(value) => {
                  setKind(value);
                  resetPage();
                }}
              />
              <OptionSelect<MemoryState | "">
                label="Memory state"
                className="phone:min-h-11 phone:text-input-phone"
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
                className="phone:min-h-11 phone:text-input-phone"
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
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="phone:min-h-11"
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
                className="phone:min-h-11"
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
          <div className="grid gap-3">
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
        <SettingCard className="mb-3 px-5 py-4">
          <div className="flex items-start justify-between gap-4 phone:flex-col">
            <div>
              <div className="text-item-title font-semibold text-fg">
                Prompt budget
              </div>
              <div className="mt-1 text-supporting text-dim">
                {stats.mode === "legacy"
                  ? "Legacy rollback is active. Current facts are injected without v2 retrieval budgets."
                  : "Only pinned, trusted summaries are ambient. Other memories are retrieved when relevant."}
              </div>
            </div>
            <div className="shrink-0 text-right phone:text-left">
              <div className="text-item-title font-semibold tabular-nums text-fg">
                {(stats.ambientUsedBytes || 0).toLocaleString()} /{" "}
                {(stats.ambientBudgetBytes || 0).toLocaleString()} bytes
              </div>
              <div className="mt-1 text-meta text-faint">
                {stats.reviewCount || 0} memories need review
              </div>
            </div>
          </div>
          <div
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-hover"
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
              className="h-full rounded-full bg-accent transition-[width]"
              style={{
                width: `${Math.min(100, ((stats.ambientUsedBytes || 0) / Math.max(1, stats.ambientBudgetBytes || 1)) * 100)}%`,
              }}
            />
          </div>
        </SettingCard>
      )}
      <div className="grid gap-3">
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
