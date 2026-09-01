/**
 * Analytics: what happened on/because of Open Session, aggregated for the
 * Analytics view (sidebar → Analytics). Four sources, all read-only:
 *
 * - The audit log (~/.opensession-audit/audit-YYYY-MM-DD.jsonl) for logical
 *   turn facts: active sessions, duration, run kinds, errors and cancellations.
 *   Day files are 10-20MB, so each day is parsed once into a compact rollup and
 *   disk-cached (keyed by source size — today's growing file recomputes, past
 *   days never do).
 * - Pi's native session JSONL for per-request model, token and list-price usage,
 *   including retries, tool rounds, failed attempts and cache writes.
 * - The session store (~/.opensession-sessions) for who created what: person,
 *   automation, mode, branch, repo.
 * - `gh pr list` for PRs opened/merged in the range, attributed to Open Session
 *   by head-branch ∈ {branches of code-mode sessions} (review sessions are
 *   ask-mode and don't own their branch, so reviewed-only PRs don't count).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { $ } from "bun";
import {
  isNativeSessionId,
  OPENSESSION_SESSIONS_DIR,
  stateDir,
  statePath,
} from "./paths";
import { configuredRepos, defaultRepo, githubBotLogins } from "./config";
import { noteGithubGraphqlCall } from "./github-budget";
import { readFeedback } from "../agents/github/feedback";
import type { FeedbackRecord } from "../agents/github/feedback-gates";
import { gitIdentityFor } from "./shared/user-mappings";
import {
  delegatedActorParent,
  isMachineActor,
  machineActorLabel,
} from "./session-actors";
import { PI_USAGE_CUTOVER_MS, piUsageForDates } from "./pi-usage";

const AUDIT_DIR = stateDir("audit");
const CACHE_DIR = stateDir("analytics-cache");
// Bump when the rollup shape changes — stale disk caches recompute.
const ROLLUP_VERSION = 10;

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelAgg extends TokenTotals {
  turns: number;
  costUsd: number;
  /** Turns that reported a price. Models billed against a subscription pool
   *  (the OpenAI accounts) report 0 per turn, so cost without this count
   *  reads as "cheap" when it means "not billed by token". */
  costedTurns: number;
}

interface SessionAgg {
  kind: string;
  turns: number;
  output: number;
  /** input + output + cache read + cache write. */
  tokens: number;
  costUsd: number;
  errors: number;
}

/** Per-day PR-review telemetry from `review_*` audit events. `completed`
 *  (verdict/confidence/findings) only exists from 2026-07-28 on — earlier
 *  days legitimately roll up to zeros. */
interface ReviewDayAgg {
  completed: number;
  updates: number;
  verdicts: Record<string, number>;
  confidenceSum: number;
  confidenceN: number;
  findings: number;
  blocking: number;
  withheld: number;
  missedBugs: number;
  repliesPositive: number;
  repliesDismissive: number;
}

function emptyReviewAgg(): ReviewDayAgg {
  return {
    completed: 0,
    updates: 0,
    verdicts: {},
    confidenceSum: 0,
    confidenceN: 0,
    findings: 0,
    blocking: 0,
    withheld: 0,
    missedBugs: 0,
    repliesPositive: 0,
    repliesDismissive: 0,
  };
}

interface DayRollup {
  date: string;
  turns: number;
  errors: number;
  cancelled: number;
  durationMs: number;
  oneshots: number;
  tokens: TokenTotals;
  costUsd: number;
  costedTurns: number;
  /** Turns recorded before per-step usage accounting landed (2026-08-14),
   *  whose result event carries only the turn's LAST model request. They
   *  undercount tokens and cost by the number of steps in the turn, measured
   *  at ~7x. Their events have no `steps` field, which is how we tell. */
  legacyUsageTurns: number;
  byModel: Record<string, ModelAgg>;
  /** Turns whose audit events carried no model (pre-2026-07-09 SDK-runner
   *  days), keyed by session id — resolved against the session store's
   *  `model` at compose time. */
  unknownModel: Record<string, ModelAgg>;
  bySession: Record<string, SessionAgg>;
  review: ReviewDayAgg;
}

/** Strip an engine and upstream-provider prefix for aggregation. */
function shortModel(model: string): string {
  return (
    model.replace(/^(?:pi|claude|codex|opencode)\/[^/]+\//, "") || "unknown"
  );
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyModelAgg(): ModelAgg {
  return { turns: 0, costUsd: 0, costedTurns: 0, ...emptyTokens() };
}

/** Costs are summed from per-turn floats; round at the edge so the payload
 *  carries cents rather than 48.410000000000004. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function rollupAuditContents(date: string, contents: string): DayRollup {
  const rollup: DayRollup = {
    date,
    turns: 0,
    errors: 0,
    cancelled: 0,
    durationMs: 0,
    oneshots: 0,
    tokens: emptyTokens(),
    costUsd: 0,
    costedTurns: 0,
    legacyUsageTurns: 0,
    byModel: {},
    unknownModel: {},
    bySession: {},
    review: emptyReviewAgg(),
  };
  const promptModel = new Map<string, string>();
  const eventSessionId = (e: Record<string, unknown>): string =>
    String(
      e.session_id ||
        e.bks_session_id ||
        (e.msg === "pi_turn" ? e.session : "") ||
        "",
    );
  const sessionOf = (e: Record<string, unknown>): SessionAgg | null => {
    const id = eventSessionId(e);
    if (!id) return null;
    return (rollup.bySession[id] ||= {
      // A restart-reattached turn is still its base kind for analytics.
      kind: String(e.run_kind || "?").replace(/-reattach$/, ""),
      turns: 0,
      output: 0,
      tokens: 0,
      costUsd: 0,
      errors: 0,
    });
  };

  const events: Record<string, unknown>[] = [];
  for (const line of contents.split("\n")) {
    if (!line) continue;
    const relevant =
      line.includes('"kind":"result"') ||
      line.includes('"kind":"user_prompt"') ||
      line.includes('"kind":"error"') ||
      line.includes('"kind":"cancelled"') ||
      line.includes('"kind":"session_turn_metric"') ||
      line.includes('"msg":"pi_turn"') ||
      line.includes('"msg":"pi_oneshot"') ||
      line.includes('"msg":"opencode_oneshot"') ||
      line.includes('"msg":"opencode_meridian_run"') ||
      line.includes('"msg":"opencode_openai_run"') ||
      line.includes('"msg":"review_');
    if (!relevant) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }

  // Before the Pi-only cutover, the outer runner mirrored a generic terminal
  // beside Pi's own attempt event. Pair attempts with the one logical turn
  // metric and suppress those mirrors so mixed-format days do not double count.
  const pendingPi = new Map<string, Record<string, unknown>[]>();
  const pendingGeneric = new Map<string, Record<string, unknown>[]>();
  const piLogicalMetrics = new Map<
    Record<string, unknown>,
    Record<string, unknown>[]
  >();
  const genericTerminalsToSkip = new Set<Record<string, unknown>>();
  for (const e of events) {
    const id = eventSessionId(e);
    if (!id) continue;
    if (e.msg === "pi_turn" && e.direction === "out" && !e.kind) {
      const attempts = pendingPi.get(id) || [];
      attempts.push(e);
      pendingPi.set(id, attempts);
    }
    if ((e.kind === "result" || e.kind === "error") && pendingPi.has(id)) {
      const terminals = pendingGeneric.get(id) || [];
      terminals.push(e);
      pendingGeneric.set(id, terminals);
    }
    if (e.kind === "session_turn_metric") {
      const attempts = pendingPi.get(id) || [];
      if (attempts.length) {
        piLogicalMetrics.set(e, attempts);
        for (const terminal of pendingGeneric.get(id) || [])
          genericTerminalsToSkip.add(terminal);
      }
      pendingPi.delete(id);
      pendingGeneric.delete(id);
    }
  }

  const addUsage = (e: Record<string, unknown>, countAsTurn: boolean) => {
    const input = Number(e.input_tokens) || 0;
    const output = Number(e.output_tokens) || 0;
    const cacheRead = Number(e.cache_read_input_tokens) || 0;
    const cacheWrite = Number(e.cache_creation_input_tokens) || 0;
    const cost = Number(e.total_cost_usd) || 0;
    rollup.tokens.input += input;
    rollup.tokens.output += output;
    rollup.tokens.cacheRead += cacheRead;
    rollup.tokens.cacheWrite += cacheWrite;
    rollup.costUsd += cost;
    if (cost > 0) rollup.costedTurns++;
    const model = e.model
      ? shortModel(String(e.model))
      : promptModel.get(eventSessionId(e)) || "";
    const m = model
      ? (rollup.byModel[model] ||= emptyModelAgg())
      : (rollup.unknownModel[eventSessionId(e)] ||= emptyModelAgg());
    if (countAsTurn) m.turns++;
    m.input += input;
    m.output += output;
    m.cacheRead += cacheRead;
    m.cacheWrite += cacheWrite;
    m.costUsd += cost;
    if (cost > 0) m.costedTurns++;
    const s = sessionOf(e);
    if (s) {
      s.output += output;
      s.tokens += input + output + cacheRead + cacheWrite;
      s.costUsd += cost;
    }
  };

  for (const e of events) {
    const isReviewEvt = String(e.msg || "").startsWith("review_");
    if (isReviewEvt) {
      const rv = rollup.review;
      switch (String(e.msg || "")) {
        case "review_completed": {
          rv.completed++;
          if (e.is_update) rv.updates++;
          const verdict = String(e.verdict || "");
          if (verdict) rv.verdicts[verdict] = (rv.verdicts[verdict] || 0) + 1;
          if (typeof e.confidence === "number") {
            rv.confidenceSum += e.confidence;
            rv.confidenceN++;
          }
          rv.findings += Number(e.findings) || 0;
          rv.blocking += Number(e.blocking) || 0;
          break;
        }
        case "review_findings_withheld":
          rv.withheld += Number(e.withheld) || 0;
          break;
        case "review_missed_bug":
          rv.missedBugs++;
          break;
        case "review_reply_signal":
          rv.repliesPositive += Number(e.positive) || 0;
          rv.repliesDismissive += Number(e.dismissive) || 0;
          break;
      }
      continue;
    }
    if (e.msg === "pi_oneshot" || e.msg === "opencode_oneshot") {
      rollup.oneshots++;
      continue;
    }
    if (
      (e.msg === "opencode_meridian_run" || e.msg === "opencode_openai_run") &&
      e.phase === "end"
    ) {
      rollup.durationMs += Number(e.duration_ms) || 0;
      continue;
    }
    if (e.msg === "pi_turn" && e.direction === "out") {
      // Every Pi attempt owns its model usage, including retries and utility
      // calls. Only session_turn_metric below owns logical turn activity.
      if (
        e.input_tokens !== undefined ||
        e.output_tokens !== undefined ||
        e.cache_read_input_tokens !== undefined ||
        e.cache_creation_input_tokens !== undefined
      )
        addUsage(e, true);
      if (e.status === "cancelled") rollup.cancelled++;
      continue;
    }
    const attempts = piLogicalMetrics.get(e);
    const metricTime =
      e.kind === "session_turn_metric" ? Date.parse(String(e.time || "")) : 0;
    if (attempts || metricTime >= PI_USAGE_CUTOVER_MS) {
      rollup.turns++;
      rollup.durationMs += Number(e.duration_ms) || 0;
      const terminalAttempt = attempts?.[attempts.length - 1] || e;
      const s = sessionOf(terminalAttempt);
      if (s) {
        s.turns++;
        if (e.outcome === "failed") s.errors++;
      }
      if (e.outcome === "failed") rollup.errors++;
      continue;
    }
    if (genericTerminalsToSkip.has(e)) continue;
    const s = sessionOf(e);
    switch (String(e.kind || "")) {
      // Some engines' result events carry no model — remember the turn's
      // model from its user_prompt so those turns don't land in "unknown".
      case "user_prompt":
        if (e.model && (e.session_id || e.bks_session_id)) {
          promptModel.set(
            String(e.session_id || e.bks_session_id),
            shortModel(String(e.model)),
          );
        }
        break;
      case "result":
        rollup.turns++;
        if (e.steps === undefined) rollup.legacyUsageTurns++;
        addUsage(e, true);
        if (s) s.turns++;
        break;
      case "error":
        rollup.errors++;
        if (s) s.errors++;
        break;
      case "cancelled":
        rollup.cancelled++;
        break;
    }
  }
  return rollup;
}

function rollupAuditDay(date: string): DayRollup {
  const path = `${AUDIT_DIR}/audit-${date}.jsonl`;
  return rollupAuditContents(
    date,
    existsSync(path) ? readFileSync(path, "utf8") : "",
  );
}

/** Rollup with a per-day disk cache keyed on the source file's size. */
function cachedRollup(date: string): DayRollup {
  const src = `${AUDIT_DIR}/audit-${date}.jsonl`;
  const size = existsSync(src) ? statSync(src).size : 0;
  const cachePath = `${CACHE_DIR}/day-${date}.json`;
  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
      if (cached.v === ROLLUP_VERSION && cached.size === size)
        return cached.rollup;
    }
  } catch {}
  const rollup = rollupAuditDay(date);
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ v: ROLLUP_VERSION, size, rollup }),
    );
  } catch (e) {
    console.error("[analytics] rollup cache write failed:", e);
  }
  return rollup;
}

// ── Generic timestamped disk cache (gh fetches + composed summaries) ──
//
// The gh caches below are the expensive part of buildAnalytics (network,
// paginated GraphQL, occasional 504s) and used to be memory-only, so every
// deploy restart threw them away. Entries carry their own `at` timestamp;
// callers decide freshness. Keys roll with the date range, so stale files
// are pruned by age (day rollups above are deliberately not touched — past
// days never recompute).

let lastCachePrune = 0;

function writeDiskCache(name: string, data: unknown): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      `${CACHE_DIR}/${name}.json`,
      JSON.stringify({ at: Date.now(), data }),
    );
  } catch (e) {
    console.error("[analytics] disk cache write failed:", e);
  }
  if (Date.now() - lastCachePrune < 86_400_000) return;
  lastCachePrune = Date.now();
  try {
    for (const f of readdirSync(CACHE_DIR)) {
      if (!f.startsWith("gh-") && !f.startsWith("summary-")) continue;
      const p = `${CACHE_DIR}/${f}`;
      if (Date.now() - statSync(p).mtimeMs > 7 * 86_400_000) unlinkSync(p);
    }
  } catch {}
}

function readDiskCache<T>(name: string): { at: number; data: T } | null {
  try {
    const p = `${CACHE_DIR}/${name}.json`;
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    if (typeof parsed?.at !== "number" || parsed.data === undefined)
      return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Session store scan ──

export interface SessionMeta {
  id: string;
  createdAt: string;
  createdBy: string;
  createdByLogin: string;
  mode: string;
  model: string;
  branch: string;
  repo: string | null;
  /** Set (to the automation's display name) for automation-created sessions. */
  automationName: string | null;
  /** Set for sessions a goal started — unattended work, like an automation. */
  goalId: string | null;
  /** The session that spawned this one, when one did. */
  parentSessionId: string | null;
  isReview: boolean;
}

export function analyticsRepo(
  explicitRepo: string,
  worktreeDir: string,
  repos: Record<
    string,
    { id: string; repo: string; wtPrefix: string }
  > = configuredRepos(),
): string | null {
  if (explicitRepo && repos[explicitRepo]) return explicitRepo;
  if (!worktreeDir) return null;
  const base = worktreeDir.split("/").pop() || "";
  for (const repo of Object.values(repos)) {
    if (worktreeDir === repo.repo || worktreeDir.startsWith(`${repo.repo}/`))
      return repo.id;
    if (base.startsWith(`${repo.wtPrefix}-`)) return repo.id;
  }
  return null;
}

let sessionMetaCache: { at: number; map: Map<string, SessionMeta> } | null =
  null;

function loadSessionMeta(): Map<string, SessionMeta> {
  if (sessionMetaCache && Date.now() - sessionMetaCache.at < 60_000)
    return sessionMetaCache.map;
  const map = new Map<string, SessionMeta>();
  try {
    for (const file of readdirSync(OPENSESSION_SESSIONS_DIR)) {
      if (!isNativeSessionId(file) || !file.endsWith(".json")) continue;
      try {
        const s = JSON.parse(
          readFileSync(`${OPENSESSION_SESSIONS_DIR}/${file}`, "utf-8"),
        );
        const id = String(s.id || file.slice(0, -5));
        const createdBy = String(s.createdBy || "");
        const autoMatch = createdBy.match(/^(.*) \(automation\)$/);
        map.set(id, {
          id,
          createdAt: String(s.createdAt || ""),
          createdBy,
          createdByLogin: String(s.createdByLogin || ""),
          mode: String(s.mode || ""),
          model: String(s.model || ""),
          branch: String(s.branch || ""),
          repo: analyticsRepo(
            String(s.repo || s.project || ""),
            String(s.worktreeDir || ""),
          ),
          automationName: autoMatch ? autoMatch[1] : null,
          goalId: s.goalId ? String(s.goalId) : null,
          parentSessionId: s.parentSessionId ? String(s.parentSessionId) : null,
          isReview:
            id.startsWith("bks-ghpr-") || createdBy === "GitHub (automation)",
        });
      } catch {}
    }
  } catch (e) {
    console.error("[analytics] session scan failed:", e);
  }
  sessionMetaCache = { at: Date.now(), map };
  return map;
}

// The Slack agent keeps its threads in its own store, so they never reach
// loadSessionMeta and used to land in an anonymous "Slack" row. They do record
// who wrote the message: read that (read-only, per AGENTS.md) and credit them.
const SLACK_SESSIONS_DIR = statePath(".slack-sessions");
// GitHub delivery replay state remains in this legacy directory so upgrades
// preserve accepted delivery IDs after webhook ownership moved to GithubAgent.
const SLACK_STORE_SKIP = new Set([
  "processed-events.json",
  "github-deliveries.json",
]);
let slackOwnerCache: { at: number; map: Map<string, string> } | null = null;

/** Audit session id (`slack-<thread key>`) to the raw user the thread names. */
function loadSlackSessionOwners(): Map<string, string> {
  if (slackOwnerCache && Date.now() - slackOwnerCache.at < 60_000)
    return slackOwnerCache.map;
  const map = new Map<string, string>();
  try {
    for (const file of readdirSync(SLACK_SESSIONS_DIR)) {
      if (!file.endsWith(".json") || SLACK_STORE_SKIP.has(file)) continue;
      try {
        const s = JSON.parse(
          readFileSync(`${SLACK_SESSIONS_DIR}/${file}`, "utf-8"),
        );
        const user = String(s?.userId || "").trim();
        if (user) map.set(`slack-${file.slice(0, -5)}`, user);
      } catch {}
    }
  } catch {}
  slackOwnerCache = { at: Date.now(), map };
  return map;
}

/**
 * The person a Slack thread belongs to, or null to leave it on the surface
 * row. A thread names whoever wrote the message, which is usually a teammate
 * but can be a bot or a guest — and an unrecognized name must not become a
 * person, or the count is back to inventing humans.
 */
export function slackThreadOwner(
  owners: Map<string, string>,
  sessionId: string,
): string | null {
  const user = owners.get(sessionId);
  return user && gitIdentityFor(user) ? user : null;
}

// ── PRs via gh ──

export interface AnalyticsPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  createdAt: string;
  mergedAt: string | null;
  headRefName: string;
  byOpensession: boolean;
}

const PR_CACHE_TTL_MS = 10 * 60 * 1000;
const prCache = new Map<string, { at: number; prs: AnalyticsPr[] }>();

async function fetchRepoPrs(
  repoId: string,
  ghRepo: string,
  fromDate: string,
): Promise<AnalyticsPr[]> {
  const key = `${ghRepo}:${fromDate}`;
  const diskName = `gh-prs-${repoId}-${fromDate}`;
  let cached = prCache.get(key);
  if (!cached) {
    const disk = readDiskCache<AnalyticsPr[]>(diskName);
    if (disk) prCache.set(key, (cached = { at: disk.at, prs: disk.data }));
  }
  if (cached && Date.now() - cached.at < PR_CACHE_TTL_MS) return cached.prs;

  const fields = "number,title,url,state,createdAt,mergedAt,headRefName";
  const seen = new Map<number, AnalyticsPr>();
  let failed = false;
  // Two searches: PRs created in range (any state) + PRs merged in range
  // (which may have been created before it). Capped at 1000 (the GitHub
  // search ceiling): a busy repo alone can open 400+ PRs in a 30-day window.
  for (const search of [`created:>=${fromDate}`, `merged:>=${fromDate}`]) {
    try {
      const queryStarted = Date.now();
      let raw: string;
      try {
        raw =
          await $`gh pr list --repo ${ghRepo} --state all --limit 1000 --search ${search} --json ${fields}`
            .quiet()
            .text();
        noteGithubGraphqlCall(
          "analytics:pr-list",
          Date.now() - queryStarted,
          true,
          { ambient: true },
        );
      } catch (error) {
        noteGithubGraphqlCall(
          "analytics:pr-list",
          Date.now() - queryStarted,
          false,
          { ambient: true },
        );
        throw error;
      }
      for (const pr of JSON.parse(raw)) {
        seen.set(pr.number, {
          repo: repoId,
          number: pr.number,
          title: String(pr.title || ""),
          url: String(pr.url || ""),
          state: pr.state,
          createdAt: String(pr.createdAt || ""),
          mergedAt: pr.mergedAt ? String(pr.mergedAt) : null,
          headRefName: String(pr.headRefName || ""),
          byOpensession: false,
        });
      }
    } catch (e) {
      failed = true;
      console.error(`[analytics] gh pr list failed for ${ghRepo}:`, e);
    }
  }
  // A failed search means `seen` is partial — serve it (or the stale cache)
  // without caching, so the next request retries instead of pinning a hole.
  if (failed) return cached?.prs ?? [...seen.values()];
  const prs = [...seen.values()];
  prCache.set(key, { at: Date.now(), prs });
  writeDiskCache(diskName, prs);
  return prs;
}

// ── Factory health: review depth on merged PRs ──
//
// The lights-off failure mode is invisible in open/merge counts: PRs merging
// with zero human eyes, growing rework, reverts creeping up. This measures it
// with a second, merged-only gh query that pulls the heavy per-PR fields
// (reviews, comments, commits) the cheap list query deliberately skips.

export interface FactoryCohort {
  merged: number;
  /** Merged PRs with ≥1 review or comment from a human other than the author. */
  humanReviewed: number;
  /** Merged PRs whose title is a revert. */
  reverts: number;
  /** Avg commits pushed after the first human review, over reviewed PRs. */
  avgReworkCommits: number;
  medianHoursToMerge: number;
  /** Avg additions+deletions per merged PR. */
  avgLinesChanged: number;
}

interface FactoryPr {
  repo: string;
  number: number;
  headRefName: string;
  title: string;
  createdAt: string;
  mergedAt: string;
  linesChanged: number;
  humanReviews: number;
  reworkCommits: number;
}

/** Review activity by the bot credential (or any app bot) isn't human review. */
const BOT_LOGINS = new Set(githubBotLogins());
function isHumanReviewer(login: unknown, prAuthor: string): boolean {
  const l = String(login || "");
  return (
    !!l &&
    l !== prAuthor &&
    !BOT_LOGINS.has(l) &&
    !l.endsWith("[bot]") &&
    !l.startsWith("app/")
  );
}

const FACTORY_CACHE_TTL_MS = 30 * 60 * 1000;
const factoryCache = new Map<string, { at: number; prs: FactoryPr[] }>();
const FACTORY_PR_CAP = 400;

// Custom query instead of `gh pr list --json reviews,commits,comments`: gh's
// canned query nests commits(100)×authors(100) = ~1M possible nodes per page,
// over GitHub's 500k cap. We only need dates and logins (~20k nodes per page).
const FACTORY_QUERY = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title createdAt mergedAt additions deletions headRefName
        author { login }
        reviews(first: 50) { nodes { author { login } submittedAt } }
        comments(first: 50) { nodes { author { login } createdAt } }
        commits(last: 100) { nodes { commit { committedDate } } }
      }
    }
  }
}`;

async function fetchRepoFactoryPrs(
  repoId: string,
  ghRepo: string,
  fromDate: string,
): Promise<FactoryPr[]> {
  const key = `${ghRepo}:${fromDate}`;
  const diskName = `gh-factory-${repoId}-${fromDate}`;
  let cached = factoryCache.get(key);
  if (!cached) {
    const disk = readDiskCache<FactoryPr[]>(diskName);
    if (disk) factoryCache.set(key, (cached = { at: disk.at, prs: disk.data }));
  }
  if (cached && Date.now() - cached.at < FACTORY_CACHE_TTL_MS)
    return cached.prs;

  const prs: FactoryPr[] = [];
  const q = `repo:${ghRepo} is:pr is:merged merged:>=${fromDate}`;
  let cursor = "";
  try {
    while (prs.length < FACTORY_PR_CAP) {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${FACTORY_QUERY}`,
        "-f",
        `q=${q}`,
      ];
      if (cursor) args.push("-f", `cursor=${cursor}`);
      const queryStarted = Date.now();
      let raw: string;
      try {
        raw = await $`gh ${args}`.quiet().text();
        noteGithubGraphqlCall(
          "analytics:factory",
          Date.now() - queryStarted,
          true,
          { ambient: true },
        );
      } catch (error) {
        noteGithubGraphqlCall(
          "analytics:factory",
          Date.now() - queryStarted,
          false,
          { ambient: true },
        );
        throw error;
      }
      const search = JSON.parse(raw)?.data?.search;
      for (const pr of search?.nodes || []) {
        if (!pr?.number) continue;
        const author = String(pr.author?.login || "");
        const humanEvents: string[] = [];
        for (const r of pr.reviews?.nodes || []) {
          if (isHumanReviewer(r?.author?.login, author) && r?.submittedAt)
            humanEvents.push(String(r.submittedAt));
        }
        for (const c of pr.comments?.nodes || []) {
          if (isHumanReviewer(c?.author?.login, author) && c?.createdAt)
            humanEvents.push(String(c.createdAt));
        }
        const firstReviewAt = humanEvents.sort()[0] || null;
        const reworkCommits = firstReviewAt
          ? (pr.commits?.nodes || []).filter(
              (c: any) =>
                String(c?.commit?.committedDate || "") > firstReviewAt,
            ).length
          : 0;
        prs.push({
          repo: repoId,
          number: pr.number,
          headRefName: String(pr.headRefName || ""),
          title: String(pr.title || ""),
          createdAt: String(pr.createdAt || ""),
          mergedAt: String(pr.mergedAt || ""),
          linesChanged:
            (Number(pr.additions) || 0) + (Number(pr.deletions) || 0),
          humanReviews: humanEvents.length,
          reworkCommits,
        });
      }
      if (!search?.pageInfo?.hasNextPage || !search.pageInfo.endCursor) break;
      cursor = String(search.pageInfo.endCursor);
    }
  } catch (e) {
    console.error(`[analytics] factory pr fetch failed for ${ghRepo}:`, e);
    return cached?.prs ?? [];
  }
  factoryCache.set(key, { at: Date.now(), prs });
  writeDiskCache(diskName, prs);
  return prs;
}

function factoryCohort(prs: FactoryPr[]): FactoryCohort {
  const reviewed = prs.filter((p) => p.humanReviews > 0);
  const hours = prs
    .map((p) => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    merged: prs.length,
    humanReviewed: reviewed.length,
    reverts: prs.filter((p) => /^revert\b/i.test(p.title)).length,
    avgReworkCommits: reviewed.length
      ? round1(
          reviewed.reduce((sum, p) => sum + p.reworkCommits, 0) /
            reviewed.length,
        )
      : 0,
    medianHoursToMerge: hours.length
      ? round1(hours[Math.floor(hours.length / 2)])
      : 0,
    avgLinesChanged: prs.length
      ? Math.round(prs.reduce((sum, p) => sum + p.linesChanged, 0) / prs.length)
      : 0,
  };
}

// ── Review quality: is the PR reviewer getting better or worse? ──
//
// Two sources. The feedback store (~/.opensession-github/feedback-*.json) is a
// COHORT view: every inline finding by the day it was POSTED, with the outcome
// readers eventually gave it (addressed / ignored / explicit pushback) — recent
// days naturally show "pending" until their PRs settle. The audit rollup adds
// per-day review-run facts (verdicts, confidence, findings, withheld); the
// `review_completed` event only exists from 2026-07-28, so those columns are
// honest zeros before that.

export interface ReviewQualityDay {
  date: string;
  posted: number;
  addressed: number;
  ignored: number;
  dismissed: number;
  pending: number;
  missedBugs: number;
  reviews: number;
  findings: number;
  withheld: number;
  confidenceSum: number;
  confidenceN: number;
}

export interface ReviewQualityCohort {
  posted: number;
  addressed: number;
  ignored: number;
  dismissed: number;
  pending: number;
  missedBugs: number;
  /** addressed / settled, 0-100; null with nothing settled yet. */
  addressedRate: number | null;
  reviews: number;
  avgConfidence: number | null;
  avgFindingsPerReview: number | null;
  withheld: number;
}

/** One finding record → its settled bucket. Explicit words win over silence. */
function outcomeBucket(
  r: FeedbackRecord,
): "addressed" | "ignored" | "dismissed" | "pending" {
  if (r.replySignal === "dismissive") return "dismissed";
  if (r.outcome === "addressed") return "addressed";
  if (r.outcome === "ignored") return "ignored";
  return "pending";
}

/** Feedback records across every configured repo (default first). */
function loadAllFeedbackRecords(): FeedbackRecord[] {
  const targets: Array<string | undefined> = [undefined];
  for (const repo of Object.values(configuredRepos())) {
    if (
      repo.ghRepo &&
      repo.ghRepo.toLowerCase() !== defaultRepo().ghRepo.toLowerCase()
    ) {
      targets.push(repo.ghRepo);
    }
  }
  const out: FeedbackRecord[] = [];
  for (const t of targets) {
    try {
      out.push(...readFeedback(t));
    } catch {}
  }
  return out;
}

function reviewQualityCohort(days: ReviewQualityDay[]): ReviewQualityCohort {
  const sum = (f: (d: ReviewQualityDay) => number) =>
    days.reduce((acc, d) => acc + f(d), 0);
  const posted = sum((d) => d.posted);
  const addressed = sum((d) => d.addressed);
  const ignored = sum((d) => d.ignored);
  const dismissed = sum((d) => d.dismissed);
  const settled = addressed + ignored + dismissed;
  const reviews = sum((d) => d.reviews);
  const confidenceN = sum((d) => d.confidenceN);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    posted,
    addressed,
    ignored,
    dismissed,
    pending: sum((d) => d.pending),
    missedBugs: sum((d) => d.missedBugs),
    addressedRate: settled ? Math.round((100 * addressed) / settled) : null,
    reviews,
    avgConfidence: confidenceN
      ? round1(sum((d) => d.confidenceSum) / confidenceN)
      : null,
    avgFindingsPerReview: reviews
      ? round1(sum((d) => d.findings) / reviews)
      : null,
    withheld: sum((d) => d.withheld),
  };
}

// ── The composed summary ──

export interface AnalyticsSummary {
  from: string;
  to: string;
  days: Array<{
    date: string;
    sessions: number;
    sessionsByKind: Record<string, number>;
    turns: number;
    errors: number;
    cancelled: number;
    outputTokens: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** input + output + cache read + cache write. */
    totalTokens: number;
    costUsd: number;
    /** No retained source has usage for this day and at least one source no
     *  longer reaches it. Chart it as a gap, never as a zero. */
    unmeasured?: boolean;
    /** Per-source retention provenance for partial historical days. */
    unmeasuredSources?: string[];
    outputByModel: Record<string, number>;
    costByModel: Record<string, number>;
    prsOpened: number;
    prsMerged: number;
    durationMs: number;
  }>;
  totals: {
    sessions: number;
    sessionsCreated: number;
    turns: number;
    errors: number;
    cancelled: number;
    oneshots: number;
    durationMs: number;
    outputTokens: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    /** API list-price equivalent of every model request in range. Nothing
     *  is billed per token (every model runs on a subscription pool), so
     *  this is comparable value, not spend. */
    costUsd: number;
    /** Model requests behind the turns above. One turn is many requests. */
    requests: number;
    /** Requests on a model with no catalog price, excluded from costUsd. */
    unpricedRequests: number;
    /** Days in range that predate the engine store's retention, so their
     *  tokens and cost are unknown rather than zero. */
    unmeasuredDays: number;
    prsOpened: number;
    prsMerged: number;
    allPrsOpened: number;
    allPrsMerged: number;
    activePeople: number;
  };
  /** Per model, from the engine stores. `turns` is audit-derived (a turn is
   *  ours); everything else counts model requests. */
  models: Array<
    {
      model: string;
      turns: number;
      requests: number;
      totalTokens: number;
      costUsd: number;
    } & {
      [K in keyof TokenTotals as `${K}Tokens`]: number;
    }
  >;
  people: Array<{
    name: string;
    sessionsCreated: number;
    sessionsActive: number;
    turns: number;
    outputTokens: number;
    /** Human work that names no human: a session pruned from the store
     *  leaves only the surface it arrived on. Kept for its turns, left out
     *  of `activePeople` because a surface is not a person. */
    unattributed?: boolean;
    /** This person's activity split by repo ("" = not attributable). */
    repos: Array<{
      repo: string;
      sessions: number;
      turns: number;
      outputTokens: number;
    }>;
  }>;
  automations: Array<{
    name: string;
    runs: number;
    sessionsActive: number;
    turns: number;
    outputTokens: number;
    errors: number;
  }>;
  repos: Array<{
    /** Repo id, or "" for activity not attributable to a registered repo
     *  (Slack/Linear runs, pruned sessions). */
    repo: string;
    sessions: number;
    turns: number;
    outputTokens: number;
    errors: number;
    prsOpened: number;
    prsMerged: number;
    allOpened: number;
    allMerged: number;
  }>;
  prs: AnalyticsPr[];
  factory: {
    days: Array<{ date: string; reviewed: number; unreviewed: number }>;
    /** Merged PRs whose head branch belongs to an Open Session code session. */
    agent: FactoryCohort;
    /** Every other merged PR in range (humans + external bots). */
    other: FactoryCohort;
  };
  reviewQuality: {
    days: ReviewQualityDay[];
    /** First half of the range vs the second — the better-or-worse split. */
    earlier: ReviewQualityCohort;
    recent: ReviewQualityCohort;
  };
}

function utcDatesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (
    let t = new Date(`${from}T00:00:00Z`).getTime();
    t <= end;
    t += 86_400_000
  ) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}

/** Friendly owner label for run kinds whose sessions live outside our store. */
function kindOwner(kind: string): string {
  if (kind === "slack") return "Slack";
  if (kind === "linear") return "Linear";
  return "Other";
}

/** The kindOwner labels — surfaces work arrived on, not people. */
const SURFACE_OWNERS = new Set(["Slack", "Linear", "Other", "Unknown"]);

/** Owner label for the GitHub review agent's sessions. */
const REVIEW_OWNER = "GitHub review";

/** How far up a chain of machine-started sessions to look for the person who
 *  began it. Deep enough for real delegation, bounded against a cycle. */
const OWNER_CHAIN_MAX = 10;

/** A goal's own name, from the `<goal name> (goal)` label it creates under. */
function goalOwnerName(createdBy: string): string {
  return createdBy.replace(/\s*\(goal\)$/, "").trim() || "Goal";
}

export type OwnerRef =
  /** Unattended work: an automation, a goal, a review, a machine actor. */
  | { kind: "automation"; name: string }
  /** A person, described by the session they actually started. */
  | { kind: "person"; meta: SessionMeta };

/**
 * Who a session's work belongs to.
 *
 * The `createdBy` on the file is not always an owner. A delegated worker, an
 * auto-continue nudge and the wake after a restart all start sessions under a
 * sentinel (see session-actors.ts), and counting those as people is what put
 * 31 "humans" on a 7-person team. So walk up the chain those sentinels leave
 * behind — the parent link, or the session id the `worker <id>` sender names —
 * until a person is found, and credit them: a worker's turns belong to whoever
 * delegated it. A chain that ends on a machine (the machine web identity, a
 * parent we no longer keep) is unattended work, not a person.
 */
export function resolveOwnerRef(
  meta: Map<string, SessionMeta>,
  start: SessionMeta,
): OwnerRef {
  const seen = new Set<string>([start.id]);
  let cur: SessionMeta | undefined = start;
  let last = start;
  for (let depth = 0; cur && depth <= OWNER_CHAIN_MAX; depth++) {
    last = cur;
    if (cur.isReview) return { kind: "automation", name: REVIEW_OWNER };
    if (cur.automationName)
      return { kind: "automation", name: cur.automationName };
    if (cur.goalId)
      return { kind: "automation", name: goalOwnerName(cur.createdBy) };
    if (!isMachineActor(cur.createdBy)) return { kind: "person", meta: cur };
    const parentId = cur.parentSessionId || delegatedActorParent(cur.createdBy);
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    cur = meta.get(parentId);
  }
  return { kind: "automation", name: machineActorLabel(last.createdBy) };
}

/** Collapse the display name, short name, and verified login for one teammate
 *  onto the first-name label used by the rest of the people UI. */
export function analyticsPersonName(name: string, login = ""): string {
  const identity = gitIdentityFor(login) || gitIdentityFor(name);
  return identity?.name.split(" ")[0] || name;
}

export async function buildAnalytics(
  from: string,
  to: string,
): Promise<AnalyticsSummary> {
  const dates = utcDatesBetween(from, to);
  const meta = loadSessionMeta();
  const slackOwners = loadSlackSessionOwners();

  // PRs: query every repo that has ever hosted a code-mode session, and
  // attribute by head branch against those sessions' branches.
  const codeBranches = new Set<string>();
  const codeRepos = new Set<string>();
  for (const s of meta.values()) {
    if (s.mode !== "code" || !s.branch) continue;
    codeBranches.add(s.branch);
    if (s.repo) codeRepos.add(s.repo);
  }
  const repos = configuredRepos();
  const allPrs: AnalyticsPr[] = [];
  const allFactoryPrs: FactoryPr[] = [];
  await Promise.all(
    [...codeRepos].map(async (repoId) => {
      const repo = repos[repoId];
      if (!repo?.ghRepo) return;
      const [prs, factoryPrs] = await Promise.all([
        fetchRepoPrs(repoId, repo.ghRepo, from),
        fetchRepoFactoryPrs(repoId, repo.ghRepo, from),
      ]);
      allPrs.push(...prs);
      allFactoryPrs.push(...factoryPrs);
    }),
  );
  for (const pr of allPrs) pr.byOpensession = codeBranches.has(pr.headRefName);
  const inRange = (iso: string | null) => {
    const d = (iso || "").slice(0, 10);
    return d >= from && d <= to;
  };

  const days: AnalyticsSummary["days"] = [];
  const totals: AnalyticsSummary["totals"] = {
    sessions: 0,
    sessionsCreated: 0,
    turns: 0,
    errors: 0,
    cancelled: 0,
    oneshots: 0,
    durationMs: 0,
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    requests: 0,
    unpricedRequests: 0,
    unmeasuredDays: 0,
    prsOpened: 0,
    prsMerged: 0,
    allPrsOpened: 0,
    allPrsMerged: 0,
    activePeople: 0,
  };
  const modelAgg = new Map<string, ModelAgg>();
  interface OwnerRepoAgg {
    sessions: Set<string>;
    turns: number;
    outputTokens: number;
  }
  interface OwnerAgg {
    sessionsCreated: number;
    sessionsActive: Set<string>;
    turns: number;
    outputTokens: number;
    errors: number;
    byRepo: Map<string, OwnerRepoAgg>;
  }
  const peopleAgg = new Map<string, OwnerAgg>();
  const automationAgg = new Map<string, OwnerAgg>();
  // Session activity per repo (key "" = not attributable to a registered repo:
  // Slack/Linear runs, sessions pruned from the store).
  interface RepoActivity {
    sessions: Set<string>;
    turns: number;
    outputTokens: number;
    errors: number;
  }
  const repoActivity = new Map<string, RepoActivity>();
  const repoActivityOf = (repo: string): RepoActivity => {
    let a = repoActivity.get(repo);
    if (!a)
      repoActivity.set(
        repo,
        (a = { sessions: new Set(), turns: 0, outputTokens: 0, errors: 0 }),
      );
    return a;
  };
  const ownerAgg = (m: Map<string, OwnerAgg>, name: string): OwnerAgg => {
    let a = m.get(name);
    if (!a)
      m.set(
        name,
        (a = {
          sessionsCreated: 0,
          sessionsActive: new Set(),
          turns: 0,
          outputTokens: 0,
          errors: 0,
          byRepo: new Map(),
        }),
      );
    return a;
  };
  const allSessions = new Set<string>();

  // People arrive as free-text createdBy strings with inconsistent casing —
  // merge case variants, preferring a variant that carries real capitals.
  const personDisplay = new Map<string, string>();
  const personKey = (name: string, login = ""): string => {
    const canonical = analyticsPersonName(name, login);
    const lower = canonical.toLowerCase();
    const stored = personDisplay.get(lower);
    if (!stored || (stored === stored.toLowerCase() && canonical !== lower)) {
      personDisplay.set(
        lower,
        canonical === lower
          ? canonical.charAt(0).toUpperCase() + canonical.slice(1)
          : canonical,
      );
    }
    return personDisplay.get(lower)!;
  };

  // Both attribution passes below resolve the owner the same way, or a
  // session's created and active counts land on different rows.
  const aggForOwner = (ref: OwnerRef): OwnerAgg =>
    ref.kind === "automation"
      ? ownerAgg(automationAgg, ref.name)
      : ownerAgg(
          peopleAgg,
          personKey(ref.meta.createdBy || "Unknown", ref.meta.createdByLogin),
        );

  // Sessions *created* in range, from the store (owner attribution).
  for (const s of meta.values()) {
    if (!inRange(s.createdAt)) continue;
    totals.sessionsCreated++;
    aggForOwner(resolveOwnerRef(meta, s)).sessionsCreated++;
  }

  const engineModels = new Map<
    string,
    { requests: number; costUsd: number } & TokenTotals
  >();
  // Pi's native session JSONL records every assistant request, including tool
  // rounds, failed attempts and cache writes that older audit terminals omit.
  const engineDays = await piUsageForDates(dates);

  const reviewByDate = new Map<string, ReviewDayAgg>();
  for (const date of dates) {
    const r = cachedRollup(date);
    const engine = engineDays.get(date);
    reviewByDate.set(date, r.review || emptyReviewAgg());
    const sessionsByKind: Record<string, number> = {};
    // Audit supplies turns/errors; the engine store supplies every model
    // request's output, including tool rounds and spawned sessions that never
    // emitted one of our result events. Walk the union so those sessions still
    // reach their owner and repo.
    const sessionIds = new Set([
      ...Object.keys(r.bySession),
      ...Object.keys(engine?.bySession || {}),
    ]);
    for (const id of sessionIds) {
      const s = r.bySession[id] || {
        kind: "prompt",
        turns: 0,
        output: 0,
        tokens: 0,
        costUsd: 0,
        errors: 0,
      };
      // Historical audit rows kept only the final request in a Pi turn,
      // while retained engine rows include every tool round and inherited task.
      // Direct engines have no equivalent native-session index, so add only
      // their explicitly separated audit output to avoid overlap.
      const engineOutput =
        engine?.sessionAttribution === "measured"
          ? engine.bySession?.[id]?.output
          : undefined;
      const output = engineOutput ?? s.output;
      allSessions.add(id);
      const m = meta.get(id);
      // Review sessions run with run_kind "prompt"; give them their own
      // stack slice — they're volume-dominant and qualitatively different.
      // (Id-prefix fallback: review sessions get pruned from the store.)
      const isReview = m?.isReview || id.startsWith("bks-ghpr-");
      // "action" is the retired Actions feature; sessions it created are
      // still in the store, so the kind stays counted.
      const isUnattendedKind =
        ["automation", "plain", "action", "security-scan"].includes(s.kind) ||
        s.kind.startsWith("github");
      const kind = isReview
        ? "review"
        : m?.automationName || (!m && isUnattendedKind)
          ? "automation"
          : s.kind;
      sessionsByKind[kind] = (sessionsByKind[kind] || 0) + 1;
      const agg = isReview
        ? ownerAgg(automationAgg, REVIEW_OWNER)
        : m
          ? aggForOwner(resolveOwnerRef(meta, m))
          : isUnattendedKind
            ? ownerAgg(automationAgg, "Removed automation sessions")
            : // A Slack thread names its author, so credit them rather than
              // the surface the message arrived on.
              slackThreadOwner(slackOwners, id)
              ? ownerAgg(
                  peopleAgg,
                  personKey(slackThreadOwner(slackOwners, id)!),
                )
              : ownerAgg(peopleAgg, kindOwner(s.kind));
      agg.sessionsActive.add(id);
      agg.turns += s.turns;
      agg.outputTokens += output;
      agg.errors += s.errors;
      const repoKey = m?.repo || "";
      const ra = repoActivityOf(repoKey);
      ra.sessions.add(id);
      ra.turns += s.turns;
      ra.outputTokens += output;
      ra.errors += s.errors;
      let orr = agg.byRepo.get(repoKey);
      if (!orr)
        agg.byRepo.set(
          repoKey,
          (orr = { sessions: new Set(), turns: 0, outputTokens: 0 }),
        );
      orr.sessions.add(id);
      orr.turns += s.turns;
      orr.outputTokens += output;
    }
    const outputByModel: Record<string, number> = {};
    const costByModel: Record<string, number> = {};
    for (const m of engine?.byModel || []) {
      outputByModel[m.model] = (outputByModel[m.model] || 0) + m.output;
      if (m.costUsd)
        costByModel[m.model] = (costByModel[m.model] || 0) + m.costUsd;
      const agg = engineModels.get(m.model) || {
        requests: 0,
        costUsd: 0,
        ...emptyTokens(),
      };
      agg.requests += m.requests;
      agg.input += m.input;
      agg.output += m.output;
      agg.cacheRead += m.cacheRead;
      agg.cacheWrite += m.cacheWrite;
      agg.costUsd += m.costUsd;
      engineModels.set(m.model, agg);
    }
    const addModel = (model: string, m: ModelAgg) => {
      const agg = modelAgg.get(model) || emptyModelAgg();
      agg.turns += m.turns;
      agg.input += m.input;
      agg.output += m.output;
      agg.cacheRead += m.cacheRead;
      agg.cacheWrite += m.cacheWrite;
      agg.costUsd += m.costUsd || 0;
      agg.costedTurns += m.costedTurns || 0;
      modelAgg.set(model, agg);
    };
    for (const [model, m] of Object.entries(r.byModel)) addModel(model, m);
    for (const [sid, m] of Object.entries(r.unknownModel)) {
      const storeModel = meta.get(sid)?.model;
      addModel(storeModel ? shortModel(storeModel) : "unknown", m);
    }
    const dayPrs = allPrs.filter((pr) => pr.byOpensession);
    const prsOpened = dayPrs.filter(
      (pr) => pr.createdAt.slice(0, 10) === date,
    ).length;
    const prsMerged = dayPrs.filter(
      (pr) => pr.mergedAt?.slice(0, 10) === date,
    ).length;
    const unmeasuredSources = engine
      ? Object.entries(engine.coverage)
          .filter(([, coverage]) => coverage === "unmeasured")
          .map(([source]) => source)
      : [];
    days.push({
      date,
      sessions: sessionIds.size,
      sessionsByKind,
      turns: r.turns,
      errors: r.errors,
      cancelled: r.cancelled,
      outputTokens: engine?.output || 0,
      inputTokens: engine?.input || 0,
      cacheReadTokens: engine?.cacheRead || 0,
      cacheWriteTokens: engine?.cacheWrite || 0,
      totalTokens: engine?.totalTokens || 0,
      costUsd: round2(engine?.costUsd || 0),
      ...(engine?.unmeasured ? { unmeasured: true as const } : {}),
      ...(unmeasuredSources.length ? { unmeasuredSources } : {}),
      outputByModel,
      costByModel: Object.fromEntries(
        Object.entries(costByModel).map(([m, c]) => [m, round2(c)]),
      ),
      prsOpened,
      prsMerged,
      durationMs: r.durationMs,
    });
    totals.turns += r.turns;
    totals.errors += r.errors;
    totals.cancelled += r.cancelled;
    totals.oneshots += r.oneshots;
    totals.durationMs += r.durationMs;
    totals.outputTokens += engine?.output || 0;
    totals.inputTokens += engine?.input || 0;
    totals.cacheReadTokens += engine?.cacheRead || 0;
    totals.cacheWriteTokens += engine?.cacheWrite || 0;
    totals.costUsd += engine?.costUsd || 0;
    totals.requests += engine?.requests || 0;
    totals.unpricedRequests += engine?.unpricedRequests || 0;
    if (engine?.unmeasured) totals.unmeasuredDays++;
  }
  totals.totalTokens =
    totals.inputTokens +
    totals.outputTokens +
    totals.cacheReadTokens +
    totals.cacheWriteTokens;
  totals.costUsd = round2(totals.costUsd);
  totals.sessions = allSessions.size;

  const repoAgg = new Map<string, AnalyticsSummary["repos"][number]>();
  const repoRow = (repo: string): AnalyticsSummary["repos"][number] => {
    let r = repoAgg.get(repo);
    if (!r) {
      repoAgg.set(
        repo,
        (r = {
          repo,
          sessions: 0,
          turns: 0,
          outputTokens: 0,
          errors: 0,
          prsOpened: 0,
          prsMerged: 0,
          allOpened: 0,
          allMerged: 0,
        }),
      );
    }
    return r;
  };
  for (const [repo, a] of repoActivity) {
    const r = repoRow(repo);
    r.sessions = a.sessions.size;
    r.turns = a.turns;
    r.outputTokens = a.outputTokens;
    r.errors = a.errors;
  }
  for (const pr of allPrs) {
    const r = repoRow(pr.repo);
    if (inRange(pr.createdAt)) {
      r.allOpened++;
      if (pr.byOpensession) r.prsOpened++;
    }
    if (pr.mergedAt && inRange(pr.mergedAt)) {
      r.allMerged++;
      if (pr.byOpensession) r.prsMerged++;
    }
  }
  for (const r of repoAgg.values()) {
    totals.prsOpened += r.prsOpened;
    totals.prsMerged += r.prsMerged;
    totals.allPrsOpened += r.allOpened;
    totals.allPrsMerged += r.allMerged;
  }

  const models = [...engineModels.entries()]
    .map(([model, m]) => ({
      model,
      // Turns are ours (audit); requests and tokens are the engine's.
      turns: modelAgg.get(model)?.turns || 0,
      requests: m.requests,
      inputTokens: m.input,
      outputTokens: m.output,
      cacheReadTokens: m.cacheRead,
      cacheWriteTokens: m.cacheWrite,
      totalTokens: m.input + m.output + m.cacheRead + m.cacheWrite,
      costUsd: round2(m.costUsd),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  const people = [...peopleAgg.entries()]
    .map(([name, a]) => ({
      name,
      sessionsCreated: a.sessionsCreated,
      sessionsActive: a.sessionsActive.size,
      turns: a.turns,
      outputTokens: a.outputTokens,
      ...(SURFACE_OWNERS.has(name) ? { unattributed: true as const } : {}),
      repos: [...a.byRepo.entries()]
        .map(([repo, r]) => ({
          repo,
          sessions: r.sessions.size,
          turns: r.turns,
          outputTokens: r.outputTokens,
        }))
        .sort((x, y) => y.outputTokens - x.outputTokens),
    }))
    .filter((p) => p.sessionsCreated > 0 || p.sessionsActive > 0)
    .sort(
      (a, b) =>
        b.sessionsActive - a.sessionsActive ||
        b.sessionsCreated - a.sessionsCreated,
    );
  // Machine actors never reach this list (resolveOwnerRef sends them to the
  // automations bucket), so what is left to drop is the surface rows.
  totals.activePeople = people.filter((p) => !p.unattributed).length;
  const automations = [...automationAgg.entries()]
    .map(([name, a]) => ({
      name,
      runs: a.sessionsCreated,
      sessionsActive: a.sessionsActive.size,
      turns: a.turns,
      outputTokens: a.outputTokens,
      errors: a.errors,
    }))
    .sort((a, b) => b.sessionsActive - a.sessionsActive || b.runs - a.runs);

  const prs = allPrs
    .filter(
      (pr) =>
        pr.byOpensession && (inRange(pr.createdAt) || inRange(pr.mergedAt)),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 400);

  const factoryInRange = allFactoryPrs.filter((pr) => inRange(pr.mergedAt));
  const factoryDays = dates.map((date) => {
    const merged = factoryInRange.filter(
      (pr) => pr.mergedAt.slice(0, 10) === date,
    );
    const reviewed = merged.filter((pr) => pr.humanReviews > 0).length;
    return { date, reviewed, unreviewed: merged.length - reviewed };
  });
  const factory = {
    days: factoryDays,
    agent: factoryCohort(
      factoryInRange.filter((pr) => codeBranches.has(pr.headRefName)),
    ),
    other: factoryCohort(
      factoryInRange.filter((pr) => !codeBranches.has(pr.headRefName)),
    ),
  };

  // Review quality: audit-rollup run facts per day + the feedback store's
  // finding cohorts folded in by posted date.
  const reviewQualityDays: ReviewQualityDay[] = dates.map((date) => {
    const rv = reviewByDate.get(date) || emptyReviewAgg();
    return {
      date,
      posted: 0,
      addressed: 0,
      ignored: 0,
      dismissed: 0,
      pending: 0,
      missedBugs: 0,
      reviews: rv.completed,
      findings: rv.findings,
      withheld: rv.withheld,
      confidenceSum: rv.confidenceSum,
      confidenceN: rv.confidenceN,
    };
  });
  const reviewDayIndex = new Map(reviewQualityDays.map((d) => [d.date, d]));
  for (const rec of loadAllFeedbackRecords()) {
    const d = reviewDayIndex.get((rec.postedAt || "").slice(0, 10));
    if (!d) continue;
    if (rec.falseNegative) {
      d.missedBugs++;
      continue;
    }
    d.posted++;
    d[outcomeBucket(rec)]++;
  }
  const half = Math.floor(dates.length / 2);
  const reviewQuality = {
    days: reviewQualityDays,
    earlier: reviewQualityCohort(reviewQualityDays.slice(0, half)),
    recent: reviewQualityCohort(reviewQualityDays.slice(half)),
  };

  return {
    from,
    to,
    days,
    totals,
    models,
    people,
    automations,
    repos: [...repoAgg.values()].sort(
      (a, b) => b.sessions - a.sessions || b.allOpened - a.allOpened,
    ),
    prs,
    factory,
    reviewQuality,
  };
}

// ── Composed-summary cache (stale-while-revalidate) ──
//
// buildAnalytics is gh-bound: a cold 30d build takes tens of seconds when the
// paginated GraphQL queries run (or 504). The route therefore serves through
// this cache: a fresh summary returns directly; a stale one returns
// immediately while a single background rebuild refreshes it; concurrent
// misses share one build. Summaries also persist to disk so the first request
// after a restart serves the last known numbers instead of blocking.

const SUMMARY_FRESH_MS = 5 * 60 * 1000;
/** Older than this and we'd rather make the user wait than show it. */
const SUMMARY_STALE_SERVE_MS = 24 * 60 * 60 * 1000;
// Bump when composition semantics change so a restart cannot serve a fresh but
// obsolete disk summary before the background prewarm replaces it.
const SUMMARY_VERSION = 10;
const summaryCache = new Map<
  string,
  { at: number; summary: AnalyticsSummary }
>();
const summaryInflight = new Map<string, Promise<AnalyticsSummary>>();

function summaryDiskName(from: string, to: string): string {
  return `summary-v${SUMMARY_VERSION}-${from}-${to}`;
}

async function buildAndStore(
  key: string,
  from: string,
  to: string,
): Promise<AnalyticsSummary> {
  const summary = await buildAnalytics(from, to);
  summaryCache.set(key, { at: Date.now(), summary });
  writeDiskCache(summaryDiskName(from, to), summary);
  // Bound the map under arbitrary custom ranges (entries are ~100KB).
  if (summaryCache.size > 24) {
    const oldest = [...summaryCache.entries()].sort(
      (a, b) => a[1].at - b[1].at,
    )[0];
    if (oldest) summaryCache.delete(oldest[0]);
  }
  return summary;
}

export async function getAnalytics(
  from: string,
  to: string,
): Promise<AnalyticsSummary> {
  const key = `${from}:${to}`;
  let cached = summaryCache.get(key);
  if (!cached) {
    const disk = readDiskCache<AnalyticsSummary>(summaryDiskName(from, to));
    if (disk)
      summaryCache.set(key, (cached = { at: disk.at, summary: disk.data }));
  }
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < SUMMARY_FRESH_MS) return cached.summary;
  let inflight = summaryInflight.get(key);
  if (!inflight) {
    inflight = buildAndStore(key, from, to).finally(() =>
      summaryInflight.delete(key),
    );
    summaryInflight.set(key, inflight);
  }
  if (cached && age < SUMMARY_STALE_SERVE_MS) {
    inflight.catch((e) =>
      console.error("[analytics] background summary rebuild failed:", e),
    );
    return cached.summary;
  }
  return inflight;
}

// ── Preset prewarm ──
//
// The date-range presets (7/14/30/90d) roll their `from` at UTC midnight, so
// without this the first Analytics visitor of the day always ate a cold
// build. Refresh them sequentially on a ticker; actual GitHub traffic stays
// bounded by the gh caches' own TTLs (10/30 min), so most ticks are cheap
// rollup+compose passes.

const PREWARM_INTERVAL_MS = 5 * 60 * 1000;
let prewarmTimer: ReturnType<typeof setInterval> | null = null;

/** Start the preset prewarm. Call once from the __opensessionBooted block. */
export function startAnalyticsPrewarm(): void {
  if (prewarmTimer) return;
  if (process.env.OPENSESSION_ANALYTICS_PREWARM === "0") {
    console.log(
      "[analytics] prewarm disabled (OPENSESSION_ANALYTICS_PREWARM=0)",
    );
    return;
  }
  const run = async () => {
    for (const days of [7, 14, 30, 90]) {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - (days - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      // Sequential on purpose: one gh-heavy build at a time. getAnalytics
      // no-ops when the summary is still fresh.
      await getAnalytics(from, to).catch((e) =>
        console.error(`[analytics] prewarm ${days}d failed:`, e),
      );
    }
  };
  setTimeout(() => void run(), 20_000);
  prewarmTimer = setInterval(() => void run(), PREWARM_INTERVAL_MS);
  console.log(
    `[analytics] preset prewarm started (every ${PREWARM_INTERVAL_MS / 60_000}m)`,
  );
}

// ── Home overview strip ──

export interface HomeStatsBucket {
  /** Sessions that had at least one turn in the window. */
  sessions: number;
  turns: number;
  errors: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Compact numbers for the Home overview strip. Audit rollups supply activity;
 *  engine usage supplies tokens. This avoids the session-store and gh scans. */
export async function buildHomeStats(
  now = Date.now(),
  loadEngineUsage: (
    dates: string[],
  ) => Promise<
    Map<
      string,
      { input: number; output: number; cacheRead: number; cacheWrite: number }
    >
  > = piUsageForDates,
): Promise<{
  today: HomeStatsBucket;
  week: HomeStatsBucket;
  completeWeek: HomeStatsBucket;
  priorWeek: HomeStatsBucket;
}> {
  const empty = (): HomeStatsBucket => ({
    sessions: 0,
    turns: 0,
    errors: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  // Fifteen days back: today, the seven whole days behind it, and the seven
  // behind those, which is what a week-over-week comparison needs.
  const days: { date: string; bucket: HomeStatsBucket; ids: string[] }[] = [];
  for (let back = 0; back <= 14; back++) {
    const date = new Date(now - back * 86_400_000).toISOString().slice(0, 10);
    const r = cachedRollup(date);
    days.push({
      date,
      bucket: {
        sessions: Object.keys(r.bySession).length,
        turns: r.turns,
        errors: r.errors,
        durationMs: r.durationMs,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      ids: Object.keys(r.bySession),
    });
  }
  // Audit owns activity, while the engine stores own usage. Reading tokens
  // from audit result events here undercounts multi-step turns and omits every
  // spawned sub-session, making Home disagree with the Analytics view.
  const engineDays = await loadEngineUsage(days.map((day) => day.date));
  for (const day of days) {
    const usage = engineDays.get(day.date);
    day.bucket.inputTokens = usage?.input || 0;
    day.bucket.outputTokens = usage?.output || 0;
    day.bucket.cacheReadTokens = usage?.cacheRead || 0;
    day.bucket.cacheWriteTokens = usage?.cacheWrite || 0;
  }
  // Both ends inclusive, counted in days back from today. Sessions are the
  // one field that can't be summed: a session that ran across three days is
  // one session in the window, so the ids are deduped instead.
  const fold = (from: number, to: number): HomeStatsBucket => {
    const out = empty();
    const ids = new Set<string>();
    for (let back = from; back <= to; back++) {
      const day = days[back];
      if (!day) continue;
      out.turns += day.bucket.turns;
      out.errors += day.bucket.errors;
      out.durationMs += day.bucket.durationMs;
      out.inputTokens += day.bucket.inputTokens;
      out.outputTokens += day.bucket.outputTokens;
      out.cacheReadTokens += day.bucket.cacheReadTokens;
      out.cacheWriteTokens += day.bucket.cacheWriteTokens;
      for (const id of day.ids) ids.add(id);
    }
    out.sessions = ids.size;
    return out;
  };
  return {
    today: days[0]!.bucket,
    week: fold(0, 6),
    // The two comparable windows leave today out. It is still running, so a
    // window holding it always reads low against one that doesn't, and at
    // breakfast that reads as a collapse in activity rather than a morning.
    completeWeek: fold(1, 7),
    priorWeek: fold(8, 14),
  };
}
