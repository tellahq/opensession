/**
 * Force merge: the agent asks the person driving a session to merge a pull
 * request that GitHub reports as blocked by checks or reviews, and waits
 * while they decide.
 *
 * The agent can only open the card. It names the PR and a reason; the
 * gateway reads the PR's live state and writes everything else on the card
 * itself: the title, the head SHA, the merge method the repository allows,
 * and exactly which checks and reviews the merge would bypass. Only the
 * driver can confirm: the request records the GitHub login of the person who
 * prompted the session, and the route requires that same verified sign-in
 * (machine auth and the no-auth name picker cannot). The merge then runs on
 * the server with the confirmer's own GitHub token, so whether it may bypass
 * branch protection is GitHub's decision about that person; nothing here
 * grants a bypass.
 *
 * The merge is pinned to the head SHA shown on the card. Confirming re-reads
 * the head first and aborts if it moved, and the merge request carries the
 * SHA so GitHub refuses it if the head moves in between.
 *
 * Cancel, an expired card, and a cancelled tool call all close the card
 * without touching GitHub. Every step is audited (kind `pr_force_merge`),
 * and a merged PR gets a short comment saying who confirmed it, why, and
 * what was bypassed.
 *
 * Same shape as credential-registrations.ts: one pending request per
 * session, held in memory, broadcast to every viewer. A restart drops the
 * request and the waiting tool call with it, and nothing is merged.
 */
import { auditAsync } from "./audit";
import {
  resolveGithubCredential,
  serviceGithubCredential,
  type GithubCredential,
} from "./github-auth";
import type { MergeMethod } from "./pr-contract";
import {
  assessPrMergeReadiness,
  fetchPrReadinessSource,
  type PrMergeVerdict,
  type PrReadinessTarget,
} from "./pr-merge-readiness";
import { broadcastToSession } from "./ws-hub";

/** One thing GitHub would normally require that this merge goes around. */
export type ForceMergeBypass =
  | {
      kind: "check";
      name: string;
      state: "failing" | "pending" | "missing";
      required: boolean;
    }
  | { kind: "review" | "branch"; detail: string };

export interface ForceMergeRequest {
  id: string;
  /** Registered repo id. */
  repo: string;
  /** GitHub owner/name. */
  ghRepo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  base: string;
  head: string;
  /** The merge is pinned to this commit. */
  headSha: string;
  method: MergeMethod;
  reason: string;
  bypass: ForceMergeBypass[];
  /** Roster name of the driver, the only person who can confirm. */
  driver: string;
  requestedAt: number;
  expiresAt: number;
}

export type ForceMergeResult =
  | {
      status: "merged";
      confirmedBy: string;
      mergeSha?: string;
      commented: boolean;
    }
  | { status: "cancelled"; by?: string }
  | { status: "expired" }
  | { status: "head_changed"; expected: string; actual: string }
  | { status: "refused"; error: string };

export type ForceMergeOutcome = {
  request: ForceMergeRequest;
  result: ForceMergeResult;
};

export type GithubMergeResponse =
  | { ok: true; sha?: string }
  | { ok: false; status: number; message: string };

/** The GitHub calls force merge makes, injectable for tests. */
export interface ForceMergeGithub {
  /** Live readiness verdict, read as the bot. */
  verdict(target: PrReadinessTarget): Promise<PrMergeVerdict>;
  /** Merge methods the repository allows; empty when not readable. */
  mergeMethods(ghRepo: string): Promise<MergeMethod[]>;
  /** The PR's current head commit and state, read as the bot. */
  head(target: PrReadinessTarget): Promise<{ sha: string; open: boolean }>;
  /** PUT /pulls/:n/merge with the confirmer's credential. */
  merge(
    ghRepo: string,
    number: number,
    opts: { sha: string; method: MergeMethod; title: string },
    credential: GithubCredential,
  ): Promise<GithubMergeResponse>;
  /** POST /issues/:n/comments with the confirmer's credential. */
  comment(
    ghRepo: string,
    number: number,
    body: string,
    credential: GithubCredential,
  ): Promise<void>;
}

export interface ForceMergeDeps {
  github: ForceMergeGithub;
  audit: (event: Record<string, unknown>) => void;
}

type Pending = {
  request: ForceMergeRequest;
  target: PrReadinessTarget;
  /** Lower-cased GitHub login of the only person who may confirm. */
  login: string;
  resolve: (result: ForceMergeResult) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Set while a confirmed merge is running: cancel and expiry wait. */
  merging: boolean;
  deps: ForceMergeDeps;
};

/** Long enough to look at the failing check before deciding. */
export const FORCE_MERGE_TTL_MS = 15 * 60 * 1000;
const MAX_REASON = 500;

const g = globalThis as { __pendingForceMerges?: Map<string, Pending> };
const pending: Map<string, Pending> = (g.__pendingForceMerges ??= new Map());
/** Sessions whose request is still reading the PR, before the card shows. */
const opening = new Set<string>();

export class ForceMergeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function printable(value: unknown, max: number): string {
  return typeof value === "string"
    ? value
        .replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";
}

/**
 * What a merge of this PR would bypass, from its readiness verdict. Throws
 * for what no force merge can get around: a closed or draft PR, or merge
 * conflicts.
 */
export function forceMergeBypasses(v: PrMergeVerdict): ForceMergeBypass[] {
  const label = `${v.pr.ghRepo}#${v.pr.number}`;
  if (v.state === "MERGED")
    throw new ForceMergeError(`${label} is already merged.`);
  if (v.state === "CLOSED")
    throw new ForceMergeError(`${label} is closed. Reopen it first.`);
  if (v.draft)
    throw new ForceMergeError(
      `${label} is a draft. Mark it ready for review first.`,
    );
  if (v.mergeable === "CONFLICTING")
    throw new ForceMergeError(
      `${label} has merge conflicts with ${v.pr.base}. A force merge cannot skip those; resolve them first.`,
    );
  const bypass: ForceMergeBypass[] = [];
  for (const c of v.checks.failing)
    bypass.push({
      kind: "check",
      name: c.name,
      state: "failing",
      required: c.required,
    });
  for (const c of v.checks.pending)
    bypass.push({
      kind: "check",
      name: c.name,
      state: "pending",
      required: c.required,
    });
  for (const name of v.checks.missingRequired)
    bypass.push({ kind: "check", name, state: "missing", required: true });
  const r = v.review;
  if (r.decision === "CHANGES_REQUESTED")
    bypass.push({
      kind: "review",
      detail: r.changesRequestedBy.length
        ? `Changes requested by ${r.changesRequestedBy.join(", ")}`
        : "Changes requested",
    });
  else if (r.decision === "REVIEW_REQUIRED")
    bypass.push({ kind: "review", detail: "Approving review required" });
  else if (r.requiredApprovals > r.approvedBy.length)
    bypass.push({
      kind: "review",
      detail: `${r.requiredApprovals} approving reviews required, ${r.approvedBy.length} given`,
    });
  const mss = v.mergeStateStatus.toUpperCase();
  if (mss === "BEHIND")
    bypass.push({
      kind: "branch",
      detail: `Branch is behind ${v.pr.base}`,
    });
  else if (mss === "BLOCKED" && !bypass.length && !v.rules.restrictsUpdates)
    bypass.push({
      kind: "branch",
      detail: "Blocked by a branch rule that is not readable here",
    });
  return bypass;
}

/** "failing check ci / test (required)", "approving review required". */
export function describeBypass(b: ForceMergeBypass): string {
  if (b.kind !== "check") return b.detail;
  const what =
    b.state === "failing"
      ? "failing"
      : b.state === "pending"
        ? "still running"
        : "not reported";
  return `Check ${b.name} ${what}${b.required ? " (required)" : ""}`;
}

/** Squash where allowed, then a merge commit, then rebase. */
export function pickMergeMethod(
  allowed: MergeMethod[],
  wanted?: MergeMethod,
): MergeMethod {
  if (wanted) {
    if (allowed.length && !allowed.includes(wanted))
      throw new ForceMergeError(
        `This repository does not allow ${wanted} merges (allowed: ${allowed.join(", ")}).`,
      );
    return wanted;
  }
  for (const m of ["squash", "merge", "rebase"] as const)
    if (allowed.includes(m)) return m;
  return "squash";
}

function announce(sessionId: string, request: ForceMergeRequest | null) {
  broadcastToSession(sessionId, {
    type: "force_merge_request",
    sessionId,
    forceMergeRequest: request,
  });
}

function auditEvent(
  entry: Pending,
  event: string,
  extra: Record<string, unknown> = {},
): void {
  const r = entry.request;
  entry.deps.audit({
    kind: "pr_force_merge",
    event,
    request_id: r.id,
    repo: r.ghRepo,
    number: r.number,
    head_sha: r.headSha,
    method: r.method,
    driver: r.driver,
    reason: r.reason,
    bypassed: r.bypass.map(describeBypass),
    ...extra,
  });
}

function settle(
  sessionId: string,
  entry: Pending,
  result: ForceMergeResult,
): void {
  if (pending.get(sessionId) !== entry) return;
  pending.delete(sessionId);
  clearTimeout(entry.timer);
  entry.resolve(result);
  broadcastToSession(sessionId, {
    type: "force_merge_request_resolved",
    sessionId,
    requestId: entry.request.id,
    status: result.status,
    ...(result.status === "refused" ? { error: result.error } : {}),
  });
}

/**
 * Open a confirmation card and wait for the driver. Reads the PR first and
 * throws (before any card appears) when it cannot be force merged or the
 * session already has a card open. Resolves when the driver confirms or
 * cancels, the card expires, or `signal` aborts (which cancels the card).
 */
export async function requestForceMerge(
  sessionId: string,
  input: {
    target: PrReadinessTarget;
    reason: unknown;
    method?: MergeMethod;
    driver: { name: string; login: string };
  },
  signal?: AbortSignal,
  deps: ForceMergeDeps = defaultForceMergeDeps(),
  ttlMs = FORCE_MERGE_TTL_MS,
): Promise<ForceMergeOutcome> {
  if (!sessionId || !input.driver.login || !input.driver.name)
    throw new ForceMergeError(
      "A signed-in teammate must be driving this session to confirm a force merge.",
    );
  const reason = printable(input.reason, MAX_REASON);
  if (!reason)
    throw new ForceMergeError(
      "Give a reason: why these checks or reviews can be skipped.",
    );
  if (pending.has(sessionId) || opening.has(sessionId))
    throw new ForceMergeError(
      "This session already has a force merge waiting for confirmation.",
    );
  opening.add(sessionId);
  let request: ForceMergeRequest;
  try {
    const [verdict, allowed] = await Promise.all([
      deps.github.verdict(input.target),
      deps.github.mergeMethods(input.target.ghRepo).catch(() => []),
    ]);
    const bypass = forceMergeBypasses(verdict);
    const method = pickMergeMethod(allowed, input.method);
    if (!verdict.pr.headSha)
      throw new ForceMergeError("GitHub did not report the PR's head commit.");
    const now = Date.now();
    request = {
      id: crypto.randomUUID(),
      repo: input.target.repoId,
      ghRepo: verdict.pr.ghRepo,
      number: verdict.pr.number,
      title: printable(verdict.pr.title, 300),
      url: verdict.pr.url,
      author: verdict.pr.author,
      base: verdict.pr.base,
      head: verdict.pr.head,
      headSha: verdict.pr.headSha,
      method,
      reason,
      bypass,
      driver: input.driver.name,
      requestedAt: now,
      expiresAt: now + ttlMs,
    };
  } finally {
    opening.delete(sessionId);
  }
  if (signal?.aborted)
    return { request, result: { status: "cancelled", by: "agent" } };
  return new Promise<ForceMergeOutcome>((resolve) => {
    const entry: Pending = {
      request,
      target: input.target,
      login: input.driver.login.toLowerCase(),
      merging: false,
      deps,
      resolve: (result) => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ request, result });
      },
      timer: setTimeout(function expire() {
        // A merge in flight wins over expiry; look again once it lands.
        if (entry.merging) entry.timer = setTimeout(expire, 1_000);
        else {
          auditEvent(entry, "expired");
          settle(sessionId, entry, { status: "expired" });
        }
      }, ttlMs),
    };
    const onAbort = () => {
      if (entry.merging) return;
      auditEvent(entry, "cancelled", { by: "agent" });
      settle(sessionId, entry, { status: "cancelled", by: "agent" });
    };
    pending.set(sessionId, entry);
    signal?.addEventListener("abort", onAbort, { once: true });
    auditEvent(entry, "requested");
    announce(sessionId, request);
  });
}

export function pendingForceMerge(
  sessionId: string,
): { request: ForceMergeRequest; login: string } | null {
  const entry = pending.get(sessionId);
  return entry ? { request: entry.request, login: entry.login } : null;
}

function answerable(
  sessionId: string,
  requestId: string,
  login: string,
): Pending {
  const entry = pending.get(sessionId);
  if (!entry || entry.request.id !== requestId)
    throw new ForceMergeError("This request is no longer open", 409);
  if (entry.merging) throw new ForceMergeError("Already merging", 409);
  if (!login || login.toLowerCase() !== entry.login)
    throw new ForceMergeError(
      `Only ${entry.request.driver} can answer this request`,
      403,
    );
  return entry;
}

/**
 * Why GitHub refused, naming what is missing. `as` is the confirmer's login.
 */
export function explainMergeRefusal(
  response: { status: number; message: string },
  request: Pick<ForceMergeRequest, "ghRepo" | "base" | "method">,
  as: string,
): string {
  const msg = printable(response.message, 300) || `HTTP ${response.status}`;
  const who = `@${as}`;
  if (response.status === 401)
    return `GitHub rejected ${who}'s token (${msg}). Reconnect GitHub in Settings and try again.`;
  if (response.status === 403)
    return `${who} cannot merge in ${request.ghRepo} (${msg}). Merging needs write access to the repository, and the Open Session GitHub App needs contents: write.`;
  if (response.status === 404)
    return `${request.ghRepo} or the PR is not visible to ${who} (${msg}).`;
  if (response.status === 405) {
    const missing = /status check/i.test(msg)
      ? "bypass the required status checks"
      : /review/i.test(msg)
        ? "bypass the required reviews"
        : /merge method|not allowed/i.test(msg)
          ? `use the ${request.method} merge method`
          : "bypass the branch rules";
    return `GitHub refused the merge: ${msg}. ${who} is not allowed to ${missing} on ${request.base}. A repository admin, or a bypass actor in the branch's ruleset, has to merge it.`;
  }
  return `GitHub refused the merge: ${msg}.`;
}

export function forceMergeComment(
  request: ForceMergeRequest,
  confirmedBy: string,
): string {
  const lines = [
    `Force-merged from Open Session by @${confirmedBy}, who confirmed it explicitly.`,
    "",
    `**Reason:** ${request.reason}`,
    "",
  ];
  if (request.bypass.length) {
    lines.push("**Bypassed:**");
    for (const b of request.bypass) lines.push(`- ${describeBypass(b)}`);
  } else {
    lines.push("Nothing was blocking it when it was confirmed.");
  }
  lines.push("", `Head: ${request.headSha}`);
  return lines.join("\n");
}

/**
 * The driver's confirmation. Re-reads the head and aborts if it moved since
 * the card was shown, then merges with `credential` (the confirmer's own
 * token) pinned to that SHA. Throws ForceMergeError, leaving the card open,
 * when the caller may not answer or has no GitHub credential; every other
 * outcome closes the card and is returned.
 */
export async function confirmForceMerge(
  sessionId: string,
  requestId: string,
  login: string,
  credential: GithubCredential | null,
): Promise<ForceMergeResult> {
  const entry = answerable(sessionId, requestId, login);
  if (!credential)
    throw new ForceMergeError(
      "Connect your GitHub account in Settings before merging.",
      403,
    );
  const { request, deps } = entry;
  entry.merging = true;
  auditEvent(entry, "confirmed", { confirmed_by: login });
  const finish = (result: ForceMergeResult) => {
    entry.merging = false;
    auditEvent(entry, result.status, {
      confirmed_by: login,
      ...(result.status === "refused" ? { error: result.error } : {}),
      ...(result.status === "head_changed" ? { actual: result.actual } : {}),
      ...(result.status === "merged" && result.mergeSha
        ? { merge_sha: result.mergeSha, commented: result.commented }
        : {}),
    });
    settle(sessionId, entry, result);
    return result;
  };
  try {
    const head = await deps.github.head(entry.target);
    if (!head.open)
      return finish({
        status: "refused",
        error: `${request.ghRepo}#${request.number} is no longer open.`,
      });
    if (head.sha !== request.headSha)
      return finish({
        status: "head_changed",
        expected: request.headSha,
        actual: head.sha,
      });
    const response = await deps.github.merge(
      request.ghRepo,
      request.number,
      {
        sha: request.headSha,
        method: request.method,
        title: `${request.title} (#${request.number})`,
      },
      credential,
    );
    if (!response.ok) {
      // 409: GitHub saw a different head than the pinned SHA.
      if (response.status === 409)
        return finish({
          status: "head_changed",
          expected: request.headSha,
          actual: "",
        });
      return finish({
        status: "refused",
        error: explainMergeRefusal(response, request, login),
      });
    }
    let commented = true;
    try {
      await deps.github.comment(
        request.ghRepo,
        request.number,
        forceMergeComment(request, login),
        credential,
      );
    } catch (error) {
      commented = false;
      console.error("[force-merge] PR comment failed:", error);
    }
    return finish({
      status: "merged",
      confirmedBy: login,
      ...(response.sha ? { mergeSha: response.sha } : {}),
      commented,
    });
  } catch (error) {
    return finish({
      status: "refused",
      error: `Couldn't merge: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** Cancel the card. Any signed-in person watching may; nothing is merged. */
export function cancelForceMerge(
  sessionId: string,
  requestId: string,
  by: string,
): void {
  const entry = pending.get(sessionId);
  if (!entry || entry.request.id !== requestId)
    throw new ForceMergeError("This request is no longer open", 409);
  if (entry.merging) throw new ForceMergeError("Already merging", 409);
  auditEvent(entry, "cancelled", { by });
  settle(sessionId, entry, { status: "cancelled", by });
}

/** The tool's answer, in words the agent can relay. */
export function formatForceMergeOutcome({
  request,
  result,
}: ForceMergeOutcome): string {
  const label = `${request.ghRepo}#${request.number}`;
  const bypassed = request.bypass.length
    ? `Bypassed: ${request.bypass.map(describeBypass).join("; ")}.`
    : "Nothing was bypassed.";
  switch (result.status) {
    case "merged":
      return [
        `${label} was merged (${request.method}) at ${request.headSha.slice(0, 7)} after @${result.confirmedBy} confirmed.`,
        bypassed,
        result.commented
          ? "A comment on the PR records the reason."
          : "The merge landed, but the PR comment could not be posted.",
        request.url,
      ].join("\n");
    case "cancelled":
      return result.by === "agent"
        ? `The force merge of ${label} was withdrawn. Nothing was merged.`
        : `${result.by || "The person"} cancelled the force merge of ${label}. Nothing was merged; do not ask again unless they say so.`;
    case "expired":
      return `Nobody confirmed the force merge of ${label} within ${Math.round(FORCE_MERGE_TTL_MS / 60_000)} minutes, so the card closed. Nothing was merged.`;
    case "head_changed":
      return `The head of ${label} moved after the card was shown (${request.headSha.slice(0, 7)} on the card${result.actual ? `, now ${result.actual.slice(0, 7)}` : ""}), so nothing was merged. Ask again to confirm the new head.`;
    case "refused":
      return `${label} was not merged. ${result.error}`;
  }
}

// ---------------------------------------------------------------------------
// GitHub, through gh with an explicit credential.

async function gh(args: string[], credential: GithubCredential) {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...credential.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

/** gh api prints `gh: <message> (HTTP 405)` on an error response. */
export function parseGhApiError(stderr: string): {
  status: number;
  message: string;
} {
  const text = stderr.trim();
  const m = text.match(/\(HTTP (\d{3})\)/);
  const message = text
    .replace(/^gh:\s*/m, "")
    .replace(/\s*\(HTTP \d{3}\)\s*/g, " ")
    .split("\n")[0]!
    .trim();
  return { status: m ? Number(m[1]) : 0, message };
}

async function botCredential(ghRepo: string): Promise<GithubCredential> {
  return resolveGithubCredential(serviceGithubCredential, { repo: ghRepo });
}

export const githubForceMergeApi: ForceMergeGithub = {
  async verdict(target) {
    return assessPrMergeReadiness(await fetchPrReadinessSource(target));
  },
  async mergeMethods(ghRepo) {
    const { out, code } = await gh(
      [
        "api",
        `repos/${ghRepo}`,
        "--jq",
        "[.allow_squash_merge, .allow_merge_commit, .allow_rebase_merge]",
      ],
      await botCredential(ghRepo),
    );
    if (code !== 0) return [];
    const flags = JSON.parse(out) as Array<boolean | null>;
    // Fields are omitted for tokens that cannot see repository settings;
    // then GitHub decides at merge time.
    if (flags.every((f) => f === null || f === undefined)) return [];
    const methods: MergeMethod[] = [];
    if (flags[0]) methods.push("squash");
    if (flags[1]) methods.push("merge");
    if (flags[2]) methods.push("rebase");
    return methods;
  },
  async head(target) {
    const { out, err, code } = await gh(
      [
        "api",
        `repos/${target.ghRepo}/pulls/${target.number}`,
        "--jq",
        "{sha: .head.sha, state: .state, merged: .merged}",
      ],
      await botCredential(target.ghRepo),
    );
    if (code !== 0) throw new Error(parseGhApiError(err).message);
    const pr = JSON.parse(out) as {
      sha: string;
      state: string;
      merged: boolean;
    };
    return { sha: pr.sha, open: pr.state === "open" && !pr.merged };
  },
  async merge(ghRepo, number, opts, credential) {
    const args = [
      "api",
      "-X",
      "PUT",
      `repos/${ghRepo}/pulls/${number}/merge`,
      "-f",
      `sha=${opts.sha}`,
      "-f",
      `merge_method=${opts.method}`,
    ];
    if (opts.method === "squash") args.push("-f", `commit_title=${opts.title}`);
    const { out, err, code } = await gh(args, credential);
    if (code !== 0) return { ok: false, ...parseGhApiError(err) };
    try {
      const body = JSON.parse(out) as { sha?: string };
      return { ok: true, ...(body.sha ? { sha: body.sha } : {}) };
    } catch {
      return { ok: true };
    }
  },
  async comment(ghRepo, number, body, credential) {
    const { err, code } = await gh(
      [
        "api",
        "-X",
        "POST",
        `repos/${ghRepo}/issues/${number}/comments`,
        "-f",
        `body=${body}`,
      ],
      credential,
    );
    if (code !== 0) throw new Error(parseGhApiError(err).message);
  },
};

export function defaultForceMergeDeps(): ForceMergeDeps {
  return { github: githubForceMergeApi, audit: auditAsync };
}
