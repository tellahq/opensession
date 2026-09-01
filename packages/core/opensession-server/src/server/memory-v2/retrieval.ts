import { renderWithinByteBudget, type BudgetedText } from "./budget";

export const RETRIEVED_MEMORY_BUDGET_BYTES = 4_000;
export const AMBIENT_MEMORY_BUDGET_BYTES = 2_500;
export const RETRIEVED_MEMORY_LIMIT = 6;

export type MemoryV2Kind =
  | "preference"
  | "constraint"
  | "decision"
  | "gotcha"
  | "reference"
  | "status";
export type MemoryV2Tier = "pinned" | "retrievable";
export type MemoryV2State = "active" | "superseded" | "expired" | "archived";
export type MemoryV2SourceType =
  | "user-explicit"
  | "agent-verified"
  | "settings"
  | "slack";

/**
 * The subset of a v2 record needed for pure selection. Extra storage fields
 * remain intact because ranked results retain the original record object.
 */
export interface RetrievalRecord {
  id: string;
  scopeKey: string;
  kind: MemoryV2Kind;
  summary: string;
  details?: string;
  tags?: string[];
  tier: MemoryV2Tier;
  source: {
    type: MemoryV2SourceType;
  };
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt?: string;
  expiresAt?: string;
  state: MemoryV2State;
}

export interface MemorySelectionOptions {
  /** The complete set of scopes visible to this run. */
  scopeKeys: readonly string[];
  primaryRepoKey?: string;
  now?: Date | string | number;
}

export interface RetrievalOptions extends MemorySelectionOptions {
  limit?: number;
  budgetBytes?: number;
}

export interface RankedMemoryRecord<
  T extends RetrievalRecord = RetrievalRecord,
> {
  record: T;
  score: number;
  reasons: string[];
}

export interface MemoryRetrievalResult<
  T extends RetrievalRecord = RetrievalRecord,
> extends Omit<BudgetedText<RankedMemoryRecord<T>>, "items"> {
  records: RankedMemoryRecord<T>[];
  queryTerms: string[];
}

export interface AmbientMemoryOptions extends MemorySelectionOptions {
  budgetBytes?: number;
  /** Trusted by default: direct user statements and the Settings surface. */
  trustedSourceTypes?: readonly MemoryV2SourceType[];
}

export interface AmbientMemoryResult<
  T extends RetrievalRecord = RetrievalRecord,
> extends Omit<BudgetedText<T>, "items"> {
  records: T[];
}

const STOP_WORDS = new Set([
  "a",
  "about",
  "again",
  "all",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "but",
  "by",
  "can",
  "could",
  "current",
  "do",
  "does",
  "for",
  "from",
  "get",
  "go",
  "had",
  "has",
  "have",
  "here",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "know",
  "like",
  "look",
  "make",
  "me",
  "my",
  "need",
  "of",
  "ok",
  "on",
  "or",
  "our",
  "please",
  "should",
  "so",
  "some",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "us",
  "want",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "work",
  "would",
  "you",
  "your",
  // Task narration is common in historical memories and carries little intent.
  "change",
  "changes",
  "code",
  "done",
  "fix",
  "fixed",
  "implement",
  "implementation",
  "task",
]);

function rawTokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}_./:@#$-]+/gu) ?? [];
}

function normalizedToken(token: string): string {
  return token.replace(/^[./:@#$-]+|[./:@#$-]+$/g, "").toLocaleLowerCase();
}

function lexicalTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of rawTokens(text)) {
    const normalized = normalizedToken(raw);
    if (!normalized) continue;
    out.push(normalized);
    // Preserve the complete symbol and also make SessionActor searchable as
    // "session actor" without requiring a semantic model.
    const camelParts = raw
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .split(/[\s_./:@#$-]+/)
      .map((part) => part.toLocaleLowerCase())
      .filter(Boolean);
    if (camelParts.length > 1) out.push(...camelParts);
  }
  return out;
}

export function extractMemoryQueryTerms(query: string): string[] {
  return [
    ...new Set(
      lexicalTokens(query).filter(
        (term) =>
          term.length >= 2 && !STOP_WORDS.has(term) && !/^\d+$/.test(term),
      ),
    ),
  ];
}

function queryIdentifiers(query: string): string[] {
  const quoted = [...query.matchAll(/[`"']([^`"']{2,})[`"']/g)].map(
    (match) => match[1],
  );
  const symbolic = rawTokens(query).filter((token) => {
    const clean = token.replace(/^[./:@#$-]+|[./:@#$-]+$/g, "");
    if (clean.length < 2 || STOP_WORDS.has(clean.toLocaleLowerCase()))
      return false;
    return (
      /[A-Z]/.test(clean[0] ?? "") ||
      /[a-z\d][A-Z]/.test(clean) ||
      /[\/_:@#$.-]/.test(clean) ||
      /^--?/.test(token) ||
      /\d/.test(clean)
    );
  });
  return [
    ...new Set([...quoted, ...symbolic].map(normalizedToken).filter(Boolean)),
  ];
}

function scopeKind(
  scopeKey: string,
): "repo" | "user" | "team" | "channel" | "other" {
  if (scopeKey.startsWith("repo-")) return "repo";
  if (scopeKey.startsWith("user-")) return "user";
  if (scopeKey === "workspace") return "team";
  if (scopeKey.startsWith("channel-")) return "channel";
  return "other";
}

function scopeScore(scopeKey: string, primaryRepoKey?: string): number {
  if (scopeKey === primaryRepoKey) return 0.8;
  switch (scopeKind(scopeKey)) {
    case "repo":
      return 0.65;
    case "user":
      return 0.45;
    case "team":
      return 0.25;
    case "channel":
      return 0.15;
    default:
      return 0;
  }
}

const KIND_SCORE: Record<MemoryV2Kind, number> = {
  constraint: 0.7,
  gotcha: 0.65,
  preference: 0.55,
  decision: 0.5,
  reference: 0.4,
  status: 0.05,
};

function timeMs(
  value: Date | string | number | undefined,
  fallback = 0,
): number {
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.getTime() : fallback;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : fallback;
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isSelectable(
  record: RetrievalRecord,
  allowed: ReadonlySet<string>,
  nowMs: number,
): boolean {
  if (!allowed.has(record.scopeKey) || record.state !== "active") return false;
  return (
    !record.expiresAt ||
    timeMs(record.expiresAt, Number.NEGATIVE_INFINITY) > nowMs
  );
}

function recencyScore(
  timestamp: string | undefined,
  nowMs: number,
  halfLifeDays: number,
): number {
  const timestampMs = timeMs(timestamp);
  if (!timestampMs) return 0;
  const ageDays = Math.max(0, nowMs - timestampMs) / 86_400_000;
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

function fieldTokens(record: RetrievalRecord): {
  weightedFrequency: Map<string, number>;
  length: number;
  all: Set<string>;
  haystack: string;
} {
  const summary = lexicalTokens(record.summary);
  const tags = lexicalTokens((record.tags ?? []).join(" "));
  const details = lexicalTokens(record.details ?? "");
  const weightedFrequency = new Map<string, number>();
  for (const [tokens, weight] of [
    [summary, 3],
    [tags, 4],
    [details, 0.65],
  ] as const) {
    for (const token of tokens) {
      weightedFrequency.set(
        token,
        (weightedFrequency.get(token) ?? 0) + weight,
      );
    }
  }
  const all = new Set([...summary, ...tags, ...details]);
  return {
    weightedFrequency,
    length: summary.length + tags.length + details.length,
    all,
    haystack:
      `${record.summary}\n${(record.tags ?? []).join(" ")}\n${record.details ?? ""}`.toLocaleLowerCase(),
  };
}

/** Rank matching active records. This does not apply the output byte budget. */
export function rankMemoryRecords<T extends RetrievalRecord>(
  records: readonly T[],
  query: string,
  opts: MemorySelectionOptions,
): RankedMemoryRecord<T>[] {
  const queryTerms = extractMemoryQueryTerms(query);
  if (!queryTerms.length) return [];
  const identifiers = queryIdentifiers(query);
  const allowed = new Set(opts.scopeKeys);
  const nowMs = timeMs(opts.now, Date.now());
  const candidates = records
    .filter((record) => isSelectable(record, allowed, nowMs))
    .map((record) => ({ record, fields: fieldTokens(record) }));
  if (!candidates.length) return [];

  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      candidates.filter(({ fields }) => fields.all.has(term)).length,
    );
  }
  const averageLength =
    candidates.reduce((sum, item) => sum + item.fields.length, 0) /
      candidates.length || 1;
  const phrase = queryTerms.join(" ");
  const ranked: RankedMemoryRecord<T>[] = [];

  for (const { record, fields } of candidates) {
    const reasons: string[] = [];
    let lexical = 0;
    let matchedTerms = 0;
    for (const term of queryTerms) {
      const tf = fields.weightedFrequency.get(term) ?? 0;
      if (!tf) continue;
      matchedTerms += 1;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
      const denominator =
        tf + 1.2 * (0.25 + (0.75 * fields.length) / averageLength);
      lexical += idf * ((tf * 2.2) / denominator);
    }
    if (!matchedTerms) continue;
    reasons.push(`lexical:${matchedTerms}/${queryTerms.length}`);

    let exact = 0;
    for (const identifier of identifiers) {
      const hit = /[\/_:@#$.-]/.test(identifier)
        ? fields.haystack.includes(identifier)
        : fields.all.has(identifier);
      if (hit) exact += 100;
    }
    if (exact) reasons.push("exact-identifier");
    if (phrase.length >= 4 && fields.haystack.includes(phrase)) {
      exact += 15;
      reasons.push("exact-phrase");
    }

    const specificity = scopeScore(record.scopeKey, opts.primaryRepoKey);
    const kind = KIND_SCORE[record.kind] ?? 0;
    const freshness = recencyScore(record.lastConfirmedAt, nowMs, 180) * 0.7;
    const recency =
      recencyScore(record.updatedAt || record.createdAt, nowMs, 90) * 0.35;
    const coverage = matchedTerms / queryTerms.length;
    const score =
      exact +
      lexical * 8 +
      coverage * 2 +
      specificity +
      kind +
      freshness +
      recency;
    ranked.push({ record, score, reasons });
  }

  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      timeMs(
        b.record.lastConfirmedAt || b.record.updatedAt || b.record.createdAt,
      ) -
        timeMs(
          a.record.lastConfirmedAt || a.record.updatedAt || a.record.createdAt,
        ) ||
      a.record.id.localeCompare(b.record.id),
  );
}

function renderRetrievedLine(item: RankedMemoryRecord): string {
  const { record } = item;
  return `- [${record.id}] (${record.scopeKey} · ${record.kind}) ${record.summary.trim()}`;
}

/** Select and render at most six relevant summaries within 4,000 UTF-8 bytes. */
export function retrieveMemory<T extends RetrievalRecord>(
  records: readonly T[],
  query: string,
  opts: RetrievalOptions,
): MemoryRetrievalResult<T> {
  const ranked = rankMemoryRecords(records, query, opts);
  const rendered = renderWithinByteBudget(ranked, {
    budgetBytes: opts.budgetBytes ?? RETRIEVED_MEMORY_BUDGET_BYTES,
    header: "Relevant memory:",
    limit: Math.min(
      RETRIEVED_MEMORY_LIMIT,
      Math.max(0, opts.limit ?? RETRIEVED_MEMORY_LIMIT),
    ),
    renderItem: renderRetrievedLine,
  });
  return {
    records: rendered.items,
    text: rendered.text,
    bytes: rendered.bytes,
    omitted: rendered.omitted,
    queryTerms: extractMemoryQueryTerms(query),
  };
}

function ambientPriority(
  record: RetrievalRecord,
  primaryRepoKey?: string,
): number {
  return (
    scopeScore(record.scopeKey, primaryRepoKey) * 10 +
    (KIND_SCORE[record.kind] ?? 0)
  );
}

function renderAmbientLine(record: RetrievalRecord): string {
  return `- [${record.id}] (${record.scopeKey} · ${record.kind}) ${record.summary.trim()}`;
}

/** Render only active, trusted pins within 2,500 UTF-8 bytes, including the header. */
export function renderAmbientMemory<T extends RetrievalRecord>(
  records: readonly T[],
  opts: AmbientMemoryOptions,
): AmbientMemoryResult<T> {
  const nowMs = timeMs(opts.now, Date.now());
  const allowed = new Set(opts.scopeKeys);
  const trustedTypes = new Set<MemoryV2SourceType>(
    opts.trustedSourceTypes ?? ["user-explicit", "settings"],
  );
  const eligible = records
    .filter(
      (record) =>
        isSelectable(record, allowed, nowMs) &&
        record.tier === "pinned" &&
        (trustedTypes.has(record.source.type) || !!record.lastConfirmedAt),
    )
    .sort(
      (a, b) =>
        ambientPriority(b, opts.primaryRepoKey) -
          ambientPriority(a, opts.primaryRepoKey) ||
        timeMs(b.lastConfirmedAt || b.updatedAt || b.createdAt) -
          timeMs(a.lastConfirmedAt || a.updatedAt || a.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const rendered = renderWithinByteBudget(eligible, {
    budgetBytes: opts.budgetBytes ?? AMBIENT_MEMORY_BUDGET_BYTES,
    header: "Standing memory:",
    limit: eligible.length,
    renderItem: renderAmbientLine,
  });
  return {
    records: rendered.items,
    text: rendered.text,
    bytes: rendered.bytes,
    omitted: rendered.omitted,
  };
}
