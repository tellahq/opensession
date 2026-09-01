export const MEMORY_KINDS = [
  "preference",
  "constraint",
  "decision",
  "gotcha",
  "reference",
  "status",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_TIERS = ["pinned", "retrievable"] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

export const MEMORY_STATES = [
  "active",
  "expired",
  "superseded",
  "archived",
] as const;
export type MemoryState = (typeof MEMORY_STATES)[number];

export const MEMORY_SOURCE_TYPES = [
  "user-explicit",
  "agent-verified",
  "settings",
  "slack",
] as const;
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

export interface MemorySource {
  type: MemorySourceType;
  sessionId?: string;
  turnId?: string;
  repoPath?: string;
  actor?: string;
  channelId?: string;
}

export interface MemoryRecord {
  id: string;
  scopeKey: string;
  summary: string;
  details?: string;
  kind: MemoryKind;
  tier: MemoryTier;
  state: MemoryState;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt?: string;
  expiresAt?: string;
  supersedes: string[];
  supersededBy?: string;
  fingerprint: string;
  tags: string[];
  retrievalCount: number;
  lastRetrievedAt?: string;
}

export interface CreateMemoryInput {
  id?: string;
  scopeKey: string;
  summary: string;
  details?: string;
  kind: MemoryKind;
  tier: MemoryTier;
  source: MemorySource;
  createdAt?: string;
  updatedAt?: string;
  lastConfirmedAt?: string;
  expiresAt?: string;
  supersedes?: string[];
  tags?: string[];
}

export interface UpdateMemoryInput {
  summary?: string;
  details?: string | null;
  kind?: MemoryKind;
  tier?: MemoryTier;
  source?: MemorySource;
  expiresAt?: string | null;
  tags?: string[];
}

export interface MemoryFilters {
  scopeKeys?: string[];
  kinds?: MemoryKind[];
  tiers?: MemoryTier[];
  states?: MemoryState[];
  tags?: string[];
  /** Filter by whether a record has been explicitly confirmed. */
  confirmed?: boolean;
}

export interface PageOptions {
  limit?: number;
  cursor?: string;
}

export interface MemoryPage {
  items: MemoryRecord[];
  nextCursor?: string;
}

export interface MemorySearchOptions extends MemoryFilters, PageOptions {
  includeDetails?: boolean;
  matchAny?: boolean;
}

export interface RelatedCandidate {
  record: MemoryRecord;
  score: number;
}

export interface MemoryScopeStats {
  scopeKey: string;
  total: number;
  active: number;
  pinned: number;
  /** Active records that have not yet been explicitly confirmed. */
  review: number;
  /** Characters that this scope contributes when pinned summaries are rendered ambiently. */
  ambientSummaryChars: number;
}

export interface MemoryStats {
  total: number;
  active: number;
  pinned: number;
  review: number;
  ambientSummaryChars: number;
  scopes: MemoryScopeStats[];
}
