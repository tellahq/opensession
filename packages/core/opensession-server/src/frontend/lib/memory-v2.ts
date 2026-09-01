import { request } from "./api/request";
import type { MemoryScopeDto } from "./api/settings";

export type MemoryRecordKind =
  | "preference"
  | "constraint"
  | "decision"
  | "gotcha"
  | "reference"
  | "status";
export type MemoryTier = "pinned" | "retrievable";
export type MemoryState = "active" | "archived" | "expired" | "superseded";
export type MemoryReviewState = "needs_review" | "confirmed";

/** V2 fields are optional while legacy JSON records are migrated in place. */
export interface MemoryRecordDto {
  id: string;
  text?: string;
  by?: string;
  at?: string;
  summary?: string;
  details?: string;
  hasDetails?: boolean;
  kind?: MemoryRecordKind;
  tier?: MemoryTier;
  state?: MemoryState;
  source?: {
    type?: "user-explicit" | "agent-verified" | "settings" | "slack";
    sessionId?: string;
    turnId?: string;
    repo?: string;
    commit?: string;
    pr?: string;
    actor?: string;
    channelId?: string;
  };
  tags?: string[];
  expiresAt?: string;
  lastConfirmedAt?: string;
  archivedAt?: string;
  supersededBy?: string;
  scopeKey?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MemoryScopeV2Dto extends Omit<MemoryScopeDto, "entries"> {
  entries: MemoryRecordDto[];
}

export interface MemoryV2Stats {
  mode?: "legacy" | "v2";
  ambientBudgetBytes?: number;
  retrievalBudgetBytes?: number;
  ambientUsedBytes?: number;
  reviewCount?: number;
}

export interface MemoryScopeSummaryDto {
  scope: MemoryScopeDto["scope"];
  count: number;
  pinnedCount?: number;
  reviewCount?: number;
  ambientChars?: number;
}

export interface MemoryV2Response {
  scopes: MemoryScopeSummaryDto[];
  stats?: MemoryV2Stats;
}

export function memorySummary(entry: MemoryRecordDto): string {
  return entry.summary?.trim() || entry.text?.trim() || "";
}

export function memoryState(
  entry: MemoryRecordDto,
  now = Date.now(),
): MemoryState {
  if (entry.state) return entry.state;
  if (entry.archivedAt) return "archived";
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) return "expired";
  return "active";
}

export function memoryNeedsReview(entry: MemoryRecordDto): boolean {
  return !entry.lastConfirmedAt;
}

export function memorySourceLabel(entry: MemoryRecordDto): string {
  const type = entry.source?.type;
  if (type === "user-explicit") return "Explicit";
  if (type === "agent-verified") return "Agent verified";
  if (type === "settings") return "Settings";
  if (type === "slack") return "Slack";
  return entry.by || "Unknown";
}

export function memoryCreatedAt(entry: MemoryRecordDto): string {
  return entry.createdAt || entry.at || new Date(0).toISOString();
}

type MemoryAction = "pin" | "unpin" | "confirm" | "archive" | "restore";

export async function mutateMemoryRecord(
  scopeKey: string,
  id: string,
  action: MemoryAction,
): Promise<{ entry: MemoryRecordDto }> {
  return request(`/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { scopeKey, action },
    label: `Failed to ${action} memory`,
  });
}

export async function updateMemoryRecord(
  scopeKey: string,
  id: string,
  patch: Partial<
    Pick<MemoryRecordDto, "summary" | "details" | "kind" | "tags" | "expiresAt">
  >,
): Promise<{ entry: MemoryRecordDto }> {
  return request(`/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { scopeKey, ...patch },
    label: "Failed to update memory",
  });
}

export async function fetchMemoryScopes(): Promise<MemoryV2Response> {
  return request("/memory/scopes", { label: "Failed to fetch memory scopes" });
}

export async function fetchMemoryPage(input: {
  scopeKey?: string;
  q?: string;
  kind?: MemoryRecordKind;
  state?: MemoryState;
  review?: "needs_review" | "confirmed";
  cursor?: string;
  limit?: number;
}): Promise<{ items: MemoryRecordDto[]; nextCursor?: string }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return request(`/memory?${params.toString()}`, {
    label: "Failed to fetch memory",
  });
}

export async function readMemoryRecord(
  scopeKey: string,
  id: string,
): Promise<{ entry: MemoryRecordDto }> {
  const params = new URLSearchParams({ scopeKey });
  return request(`/memory/${encodeURIComponent(id)}?${params.toString()}`, {
    label: "Failed to read memory",
  });
}

export async function mergeMemoryRecords(input: {
  scopeKey: string;
  ids: string[];
  summary: string;
  kind: MemoryRecordKind;
  expiresAt?: string;
}): Promise<{ entry: MemoryRecordDto }> {
  return request("/memory/merge", {
    method: "POST",
    body: input,
    label: "Failed to merge memories",
  });
}

export async function addStructuredMemory(input: {
  scopeKey: string;
  summary: string;
  kind: MemoryRecordKind;
  expiresAt?: string;
  by: string;
}): Promise<{ entry: MemoryRecordDto }> {
  return request("/memory", {
    method: "POST",
    body: { ...input, text: input.summary },
    label: "Failed to add memory",
  });
}

export async function permanentlyDeleteMemory(
  scopeKey: string,
  id: string,
): Promise<void> {
  const params = new URLSearchParams({ scopeKey, confirm: "true" });
  await request<void>(
    `/memory/${encodeURIComponent(id)}?${params.toString()}`,
    {
      method: "DELETE",
      label: "Failed to delete memory",
    },
  );
}
