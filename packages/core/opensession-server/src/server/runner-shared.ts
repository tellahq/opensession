/**
 * Engine-neutral runner infrastructure shared across the engine and agents:
 *
 * - filterMcpServers: per-run MCP resolution (allowlist + per-user
 *   `allowedUsers` gating, strips our metadata before the config reaches an
 *   engine).
 * - STRIPE_CONFIRM_TOOLS: the money-moving Stripe tool catalog (confirm-listed
 *   in interactive runs, denied/stripped in unattended ones).
 * - isClaudeUsageLimitError / isCodexUsageLimitError: provider usage-limit
 *   detection driving account rotation and model fallback.
 * - CLAUDE_CODE_BIN: the Claude Code CLI path (the Meridian bridge's motor).
 */
import {
  hasValidRequiredAllowedUsers,
  readMcpConfig,
  requiresAllowedUsers,
  withDynamicCredentials,
} from "./connections";
import { userMatchesAny } from "./shared/user-mappings";
import { configuredPaths } from "./config";

/** Claude Code CLI binary the Meridian bridge / anthropic-bridge spawn.
 *  OPENSESSION_CLAUDE_BIN env → config `paths.claudeBin` → this VPS's path. */
export const CLAUDE_CODE_BIN = configuredPaths().claudeBin;

/** Moved to the protocol package; re-exported for existing import sites. */
export type { McpScope } from "@tellahq/opensession-protocol/runner";
import type { McpScope } from "@tellahq/opensession-protocol/runner";
import { GH_CHECKS_CLI_PATH } from "./run-instructions";

/**
 * Resolve the MCP servers for a run: all configured, or just the allowlist,
 * minus any server whose per-user `allowedUsers` list excludes the run. Most
 * servers accept the prompter or session creator; `apple-release` is stricter
 * and accepts only the current prompter. The metadata is stripped before the
 * entry reaches an engine.
 */
export function mcpServerAllowedForRun(
  name: string,
  allowedUsers: unknown,
  user?: string,
  grantUsers?: Array<string | undefined>,
): boolean {
  const protectedServer = requiresAllowedUsers(name);
  if (protectedServer && !hasValidRequiredAllowedUsers(allowedUsers)) {
    return false;
  }
  if (!Array.isArray(allowedUsers) || allowedUsers.length === 0) return true;
  const gateUsers = protectedServer ? [user] : [user, ...(grantUsers || [])];
  return gateUsers
    .filter((candidate): candidate is string => !!candidate)
    .some((candidate) => userMatchesAny(candidate, allowedUsers));
}

export function filterMcpServers(
  scope: McpScope,
  user?: string,
  /** OAuth grant identities in priority order (default: [user]). The
   *  allowedUsers VISIBILITY gate below always uses `user` (the prompter) —
   *  that's least-privilege, not identity preference. */
  grantUsers?: Array<string | undefined>,
): Record<string, unknown> {
  const all = withDynamicCredentials(
    readMcpConfig().mcpServers,
    grantUsers ?? user,
  );
  const out: Record<string, unknown> = {};
  const allowlist = scope === "all" ? undefined : scope;
  const names = allowlist ?? Object.keys(all);
  for (const name of names) {
    const cfg = all[name] as any;
    if (!cfg) {
      if (allowlist)
        console.warn(
          `[runner] MCP allowlist names unknown server "${name}" — skipping`,
        );
      continue;
    }
    const { allowedUsers, oauthUrl, ...entry } = cfg;
    if (!mcpServerAllowedForRun(name, allowedUsers, user, grantUsers)) {
      continue;
    }
    out[name] = entry;
  }
  return out;
}

/**
 * Money-moving Stripe tools: interactive Open Session runs drop the whole
 * server fail-closed (no per-call approval bridge on the the previous runner engine);
 * unattended runs strip these from the tool list with propose-it-in-your-
 * output guidance. The raw-API tools are included because they can hit any
 * endpoint the restricted key allows, including refunds and cancels.
 *
 * Keep this list in sync with mcp.stripe.com's live catalog: verified
 * 2026-07-09 the server now exposes `stripe_api_write` (mutating raw API
 * call — the successor of `stripe_api_execute`) plus read-only
 * `stripe_api_read`/`stripe_api_search`/`stripe_api_details`, and no longer
 * ships cancel/update_subscription as named tools. The superseded names stay
 * listed (a deny/confirm entry for a tool that doesn't exist is harmless; a
 * missing entry for one that does is a hole).
 */
export const STRIPE_CONFIRM_TOOLS: Record<string, string> = {
  mcp__stripe__create_refund: "Create a refund",
  mcp__stripe__cancel_subscription: "Cancel a subscription",
  mcp__stripe__update_subscription: "Update a subscription",
  mcp__stripe__stripe_api_execute: "Execute a raw Stripe API call",
  mcp__stripe__stripe_api_write: "Execute a mutating Stripe API call",
};

// `strict` matching applies to successful results too — the CLI reports usage
// limits as a plain result text ("Claude AI usage limit reached|<ts>",
// "5-hour limit reached ∙ resets …"), with subtype "success". The looser
// heuristic only applies to error results, where false positives can't
// clobber a legitimate answer.
export function isClaudeUsageLimitError(
  message: string,
  isErrorResult: boolean,
): boolean {
  const s = message.toLowerCase();
  // Observed CLI phrasings: "You've hit your session limit · resets 12:50pm (UTC)",
  // "Claude AI usage limit reached|<ts>", "5-hour limit reached ∙ resets 3am"
  if (/you've (?:hit|reached) your .{0,30}limit/.test(s)) return true;
  // Credit-metered premium models (e.g. Fable 5.1) exhaust a separate per-account
  // credit pool, not the 5-hour session limit, and say so with none of the
  // "limit/reached/resets" tokens: "You're out of usage credits. Run
  // /usage-credits to keep using Fable 5.1 or /model to switch models." Treat it
  // as a usage limit so the run rotates to another account (each has its own
  // credit balance) and, once the pool is drained, falls back off the model.
  if (/out of (usage )?credits/.test(s) || s.includes("/usage-credits"))
    return true;
  if (/claude (ai )?usage limit reached/.test(s)) return true;
  if (/limit (reached|hit).{0,60}resets/.test(s)) return true;
  // Short result that is just a limit notice, whatever the exact phrasing
  if (s.length < 200 && /\blimit\b/.test(s) && /\bresets\b/.test(s))
    return true;
  if (!isErrorResult) return false;
  if (
    s.includes("rate_limit_error") ||
    s.includes("429") ||
    s.includes("too many requests")
  )
    return true;
  return (
    (s.includes("usage") || s.includes("rate") || s.includes("limit")) &&
    (s.includes("exceeded") || s.includes("reached"))
  );
}

const RESET_MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * The reset an account's own limit message states, verbatim: "Aug 20, 9am
 * (UTC)", "12:50pm (UTC)", "3am". Returned as the account wrote it rather
 * than reformatted, so a phrasing we have not seen still reads correctly.
 * Bounded to one line and 40 characters, since this text reaches a person.
 */
export function describeUsageLimitReset(message: string): string | undefined {
  const m = /\bresets?\s+(.{1,40}?)\s*$/im.exec(message || "");
  const text = m?.[1]?.trim().replace(/[.,;]$/, "");
  return text || undefined;
}

/**
 * The same reset as a timestamp, for how long to sideline the account.
 *
 * This matters more than it looks. markExhausted otherwise reads a reset only
 * from CACHED usage data, and falls back to one hour when there is none. An
 * account whose weekly limit resets in two days therefore came back into the
 * pool every hour, got picked, failed, and was benched again, burning a
 * request each time and making the pool look larger than it was.
 *
 * Deliberately conservative: it parses only the shapes Claude actually emits,
 * reads them as UTC (which is what those messages carry), and refuses
 * anything in the past or more than 14 days out, so a mis-parse can never
 * bench a healthy account for an absurd stretch. Undefined means "no opinion",
 * and the caller keeps its existing default.
 */
export function usageLimitResetAt(
  message: string,
  now: number = Date.now(),
): number | undefined {
  const text = describeUsageLimitReset(message);
  if (!text) return undefined;
  const s = text
    .toLowerCase()
    .replace(/\((?:utc|gmt)\)/g, " ")
    .trim();
  const time = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(s);
  if (!time) return undefined;
  let hour = Number(time[1]) % 12;
  if (time[3] === "pm") hour += 12;
  const minute = Number(time[2] || 0);
  if (!Number.isFinite(hour) || minute > 59) return undefined;

  const date = /\b([a-z]{3,9})\.?\s+(\d{1,2})\b/.exec(s);
  let at: number;
  if (date) {
    const month = RESET_MONTHS[date[1].slice(0, 3)];
    if (month === undefined) return undefined;
    const day = Number(date[2]);
    if (day < 1 || day > 31) return undefined;
    // No year in the message: pick the one that lands nearest ahead of now,
    // so a December limit resetting in January does not read as ten months ago.
    const year = new Date(now).getUTCFullYear();
    at = Date.UTC(year, month, day, hour, minute);
    if (at < now) at = Date.UTC(year + 1, month, day, hour, minute);
  } else {
    // Time only: the next occurrence of it.
    const d = new Date(now);
    at = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      hour,
      minute,
    );
    if (at <= now) at += 24 * 60 * 60 * 1000;
  }
  if (!(at > now) || at > now + 14 * 24 * 60 * 60 * 1000) return undefined;
  return at;
}

/**
 * A Claude account whose *subscription* is the fault: an expired, downgraded,
 * billing-blocked Max plan, or an organization policy that disables Claude Code
 * subscription access. The bridge surfaces these as either
 * "AI_APICallError: Claude Max subscription issue. Check your subscription
 * status at https://claude.ai/settings/subscription" or "Your organization has
 * disabled Claude subscription access for Claude Code". This is NOT a usage limit
 * (no reset frees it) but it IS an account-level fault that is dead on retry, so
 * callers should sideline the account and rotate off it exactly like a usage
 * limit rather than retrying the same account into a timeout. the previous runner's ai-sdk
 * treats it as retryable, so if it's not caught it manifests as a long hang.
 */
export function isClaudeSubscriptionError(message: string): boolean {
  const s = message.toLowerCase();
  return (
    s.includes("subscription issue") ||
    s.includes("check your subscription") ||
    (s.includes("claude max") && s.includes("subscription")) ||
    (s.includes("organization has disabled") &&
      s.includes("subscription access"))
  );
}

/**
 * The Meridian bridge could not start Claude Code for a run at all — the agent
 * SDK spawns the native binary and it either exited immediately ("Claude Code
 * native binary at <path> exists but failed to launch.") or was missing.
 *
 * This is a spawn-time failure on THIS box, not a verdict on the account: the
 * runs it hit were on two accounts, both
 * healthy and serving other sessions at that moment, and the binary launches
 * fine by hand. Treat it as a wedge — sideline briefly, respawn, retry — not
 * as an account-level fault.
 *
 * Worth catching because the previous runner's ai-sdk classes it retryable and nothing
 * else matches the string: uncaught it becomes ~13 backoff retries over ~2h16m
 * against a proxy that can't spawn, and then a turn that idles to the
 * wall-clock deadline and reports "Stopped after 3 hours".
 */
export function isClaudeBridgeLaunchError(message: string): boolean {
  const s = message.toLowerCase();
  if (!s.includes("claude code native binary")) return false;
  return s.includes("failed to launch") || s.includes("not found");
}

/**
 * Meridian's idle guard killed an upstream stream that produced zero bytes
 * ("Upstream stalled: no data for <n>ms") — the SDK daemon behind the proxy
 * accepted the request and went silent. Unlike an ordinary provider error,
 * every one of these already represents 90s+ of measured dead air on a FRESH
 * request, and the previous runner's retry re-enters the same wedged daemon, so a streak
 * of them can never recover on its own (2026-08-03 bks-019fc819: three of
 * these 7 min apart, 25 min of dead air until the human cancelled). The stall
 * backstop fires on a lower bar when a retry streak is made of only these.
 */
export function isUpstreamIdleStallError(message: string): boolean {
  return /upstream stalled: no data for/i.test(message);
}

export function isCodexUsageLimitError(message: string): boolean {
  const s = message.toLowerCase();
  return (
    s.includes("rate limit") ||
    s.includes("rate_limit") ||
    s.includes("429") ||
    s.includes("usage limit") ||
    (s.includes("limit") && s.includes("reached")) ||
    s.includes("too many requests")
  );
}

/**
 * Infrastructure/transient run failures worth recovering from rather than
 * surfacing as a dead turn: a fresh server/account (the previous runner-runner) or the
 * next model in the fallback graph (agent-runner) usually clears them. The goal
 * is "continue without failing" — so this deliberately matches the failure
 * *shapes* our runner emits (server death, wedged bridge, network blips, 5xx,
 * SQLite write contention), NOT model output.
 *
 * Kept TIGHT on purpose. It must never match:
 *  - usage limits (their own rotation/fallback path owns those — check those
 *    classifiers first at every call site), or
 *  - a user abort / MessageAbortedError (callers already gate on
 *    `abortController.signal.aborted` before consulting this), or
 *  - a genuine tool/model error the model itself produced.
 * A false positive here spends real budget retrying / silently downgrades the
 * model, so when in doubt this returns false and the error surfaces.
 */
export function isTransientRunError(
  message: string | undefined | null,
): boolean {
  if (!message) return false;
  if (
    isClaudeMalformedTerminalError(message) ||
    isClaudeBridgeLaunchError(message)
  )
    return true;
  const s = message.toLowerCase();
  // Never treat a user/engine abort as transient — that's an intentional stop.
  if (s.includes("messageabortederror") || s.includes("aborted")) return false;
  return (
    // Network / socket
    s.includes("econnrefused") ||
    s.includes("econnreset") ||
    s.includes("etimedout") ||
    s.includes("enotfound") ||
    s.includes("epipe") ||
    s.includes("socket hang up") ||
    s.includes("socket connection") ||
    s.includes("network error") ||
    s.includes("fetch failed") ||
    s.includes("connection error") ||
    s.includes("connection closed") ||
    s.includes("connection refused") ||
    // Liveness wedge — the Meridian proxy stopped returning bytes mid-run
    s.includes("produced no output within") ||
    // Server death / boot failure
    s.includes("server exited") ||
    s.includes("server died") ||
    // The status-poll watchdog only emits these after six failed polls and a
    // second, independent health probe. A dead/refusing server and a server
    // temporarily unable to schedule its health handler are both recoverable
    // by the normal bounded continuation path; do not make a person send the
    // prompt again after a restart/re-adoption spike.
    s.includes("econnaborted") ||
    // HTTP 5xx / gateway / provider overload
    s.includes("bad gateway") ||
    s.includes("service unavailable") ||
    s.includes("gateway timeout") ||
    s.includes("internal server error") ||
    s.includes("overloaded_error") ||
    s.includes("overloaded") ||
    /\b50[234]\b/.test(s) ||
    // The previous runner's shared SQLite store under write contention — transient, retry
    // clears it (see the SQLite-statement-failure runbook).
    s.includes("failed to execute statement")
  );
}

/**
 * Claude Code occasionally ends a request with an internal `ede_diagnostic`
 * instead of a terminal assistant message. This has been observed both during
 * normal turns and while reattaching a turn after an Open Session restart.
 *
 * It is neither a user cancellation nor an account fault: the engine session
 * remains usable, and a single continuation reliably resumes the work. Its
 * precise shape is included in isTransientRunError, while this separate
 * classifier keeps the broad matcher from matching model output that merely
 * mentions the term.
 */
export function isClaudeMalformedTerminalError(
  message: string | undefined | null,
): boolean {
  if (!message) return false;
  return /claude code returned an error result:\s*\[ede_diagnostic\]\s*result_type=user\b/i.test(
    message,
  );
}

/** A provider-declared overload is capacity pressure upstream, not an engine,
 * MCP, or network fault on this host. Retrying different models immediately
 * tends to produce the same error and obscures the real cause. */
export function isProviderOverloadError(
  message: string | undefined | null,
): boolean {
  if (!message) return false;
  return /(?:our )?servers? (?:are )?(?:currently )?overloaded|overloaded_error/i.test(
    message,
  );
}

/**
 * Meridian's internal tool-result envelope shape — `[your <tool> …]: <output>`.
 * That envelope is how the bridge represents tool results in the model's
 * context, so assistant TEXT should never open with it: when it does, the
 * model is reciting tool results it invented, and every value inside is
 * fabricated (2026-07-29: a dial/opus-fable turn wrote four fake
 * `acme_create_source` results — wrong bucket, wrong ids, a signature reading
 * "I_TRUNCATED_FOR_BREVITY" — two seconds after the real results landed, then
 * spent five minutes debugging its own fake URLs and blamed the MCP relay).
 * The tool name is deliberately unconstrained: MCP tool ids like
 * `acme_create_source` must match, not just the builtin set. Anchored to the
 * start of the text to stay narrow — prose that merely quotes an envelope
 * mid-answer should not trip it.
 */
export const TOOL_RESULT_ENVELOPE_RE =
  /^\s*\[your [a-z0-9][\w.:-]*(?:\s[^\]]*)?\]:/i;

/**
 * Second observed costume of the same confabulation (2026-07-29, ~1h after
 * the first): instead of `[your …]:` blocks, the model narrated a whole fake
 * transcript as text — raw tool-input JSON under UI-style duration chips
 * (`– 5s` on its own line, en-dash exactly as the session view renders it,
 * likely copied from a screenshot in context) plus todowrite's canonical
 * result string — for tools it never called, including an invented
 * explore-subagent report the session later had to debunk itself. Meridian's
 * async-tool protocol trains the model that results arrive as in-band text
 * ("The result will be delivered in a future turn"), which makes
 * "write them yourself" a short hop.
 *
 * Markers are chosen for precision over recall: the en-dash chip immediately
 * followed by a JSON object/array line matches the fabricated-transcript
 * rendering but not markdown bullet lists (ASCII `-`), and the todowrite
 * result sentence is emitted only by the tool. False positives cost one
 * corrective steer notice, capped per turn at the detection sites.
 */
const DURATION_CHIP_JSON_RE = /(^|\n)[–—]\s*\d+(?:\.\d+)?\s*m?s\s*\n\s*[{[]/;

/**
 * Third observed costume (2026-07-29, bks-019fad97): the model wrote a raw
 * function-call block — `<invoke name="…">` with `<parameter name="…">`
 * lines — as assistant text, invented the tool's output inline, and ended
 * the turn convinced the call was in flight. That syntax is pure harness
 * protocol and never belongs in prose; requiring BOTH tags keeps a passing
 * mention of "<invoke" in code discussion from tripping it.
 */
const INVOKE_XML_RE =
  /<invoke name="[^"\n]{1,120}">[\s\S]{0,2000}?<parameter name="[^"\n]{1,120}">/;

export function looksLikeFabricatedToolTranscript(text: string): boolean {
  if (!text) return false;
  return (
    TOOL_RESULT_ENVELOPE_RE.test(text) ||
    DURATION_CHIP_JSON_RE.test(text) ||
    INVOKE_XML_RE.test(text) ||
    text.includes("Todos have been modified successfully")
  );
}

/**
 * Agent-declared run failure: prompts that end their final message with a
 * `SCAN STATUS:` / `RUN STATUS:` line let the ledger record what actually
 * happened instead of "the turn finished" (2026-08-09: deepsec scans analyzed
 * zero batches for days while every run recorded ok). Returns the declared
 * failure line (reason included) or null. Matching is line-anchored and takes
 * the LAST status line, so an early quote of the instruction can't win over
 * the closing declaration; a trailing `ok` clears an earlier `failed`.
 */
export function declaredRunFailure(text: string): string | null {
  const lines = text.match(/^(?:SCAN|RUN) STATUS:[^\n]*$/gm);
  const last = lines?.[lines.length - 1]?.trim();
  if (!last) return null;
  return /^(?:SCAN|RUN) STATUS:\s*failed\b/i.test(last) ? last : null;
}

/** True when the text carries any (last-wins) status declaration at all —
 *  callers that REQUIRE a declaration (security scans) treat absence as its
 *  own failure. */
export function hasRunStatusDeclaration(text: string): boolean {
  return /^(?:SCAN|RUN) STATUS:[^\n]*$/m.test(text);
}

/** Read-only bash surface for ask mode: allow common inspection commands,
 *  deny everything else.
 *
 *  ORDER MATTERS — the catch-all deny MUST come first. The previous runner evaluates
 *  permission rules LAST-match-wins (Permission.evaluate is a findLast over
 *  the rules in config-object insertion order; there is NO specificity
 *  ranking), so later specific allows override the earlier "*" deny. With
 *  the catch-all LAST it won every match — every command denied — and,
 *  worse, Permission.disabled() hides a tool entirely when its last-matching
 *  rule is a "*" deny, which is what made bash vanish from every unattended
 *  ask run (the PR #4676 review starvation, the health-monitor blinding).
 *  Used by the the previous runner config generation (the previous runner-runner.ts).
 *  Verified against the previous runner v1.17.15 source (permission/index.ts
 *  evaluate/disabled, session/llm/request.ts resolveTools). */
export const ASK_BASH_PERMISSIONS: Record<string, "allow" | "deny"> = {
  "*": "deny",
  "cat *": "allow",
  "ls*": "allow",
  "rg *": "allow",
  "grep *": "allow",
  "find *": "allow",
  "head *": "allow",
  "tail *": "allow",
  "wc *": "allow",
  "tree*": "allow",
  "file *": "allow",
  "stat *": "allow",
  "du *": "allow",
  "df*": "allow",
  "which *": "allow",
  pwd: "allow",
  "echo *": "allow",
  // Identity, kernel, environment, and path inspection. These commands only
  // print process or filesystem metadata and cannot mutate the host.
  whoami: "allow",
  id: "allow",
  "id *": "allow",
  uname: "allow",
  "uname *": "allow",
  printenv: "allow",
  "printenv *": "allow",
  "readlink *": "allow",
  "realpath *": "allow",
  // Read-only clock reads (timestamp math in digests/triage). Only the read
  // forms — bare "date */date -s" (setting the clock) needs root and is not
  // allowed here; these globs cover `date +%s`, `date -u`, `date -d '…'`.
  date: "allow",
  "date +*": "allow",
  "date -u*": "allow",
  "date -d*": "allow",
  "date -r*": "allow",
  "git status*": "allow",
  "git log*": "allow",
  "git diff*": "allow",
  "git show*": "allow",
  "git branch*": "allow",
  "git blame*": "allow",
  "git grep*": "allow",
  "git ls-files*": "allow",
  // git plumbing reads: rev-parse just prints resolved revs/paths (no mutation),
  // and review agents routinely chain `… && git rev-parse HEAD` — the previous runner
  // evaluates each sub-command, so an unlisted rev-parse denied the whole line.
  "git rev-parse*": "allow",
  "git cat-file*": "allow",
  "git describe*": "allow",
  "git merge-base*": "allow",
  // Read-only stdout filters — the usual tails on allowed git/gh reads
  // (`git show X:f | nl -ba`, `… | cut -d…`); an unlisted filter denies the
  // whole pipeline (each sub-command is evaluated, see rev-parse note).
  // Deliberately NOT sort/uniq (`sort -o FILE` and `uniq in out` both write
  // files) and not awk/perl (arbitrary code; sed's exclusion is noted below).
  nl: "allow",
  "nl *": "allow",
  "cut *": "allow",
  "tr *": "allow",
  "comm *": "allow",
  column: "allow",
  "column *": "allow",
  "diff *": "allow",
  "sha256sum*": "allow",
  "md5sum*": "allow",
  // Exact spelling, no trailing glob: `git hash-object --stdin*` would also
  // match `--stdin -w`, which writes the object into .git.
  "git hash-object --stdin": "allow",
  // The PR-checks helper every run's instructions point at (see the
  // "GitHub checks authentication" block in run-instructions.ts).
  // Read-only by construction: it wraps `gh pr checks` with a short-lived
  // read-only App installation token.
  [`bun ${GH_CHECKS_CLI_PATH} *`]: "allow",
  // NOTE: sed stays denied even as `sed -n` — "sed -n *" also matches
  // `sed -n -i …` (in-place edit) and scripts with the `w /path` write
  // command, so no sed glob is actually read-only. Use head/tail/cat/rg
  // for line ranges instead.
  // Read-only GitHub inspection (PR-backlog digests, review triage). Only the
  // non-mutating `gh pr`/`gh run` read verbs — NOT bare "gh *" (that would
  // allow pr create/merge/close/comment, run rerun/cancel/delete) and NOT
  // "gh api *" (which can -X POST/PATCH any endpoint). These only ever read.
  "gh pr list*": "allow",
  "gh pr view*": "allow",
  "gh pr checks*": "allow",
  "gh pr status*": "allow",
  "gh run view*": "allow",
  "gh run list*": "allow",
  "gh run watch*": "allow",
  // jq: a pure read-only JSON filter (no file writes, no shell-out, no code
  // exec — its language is sandboxed data transformation), so it's on par with
  // grep/wc for the allowlist. Lets ask-mode runs process `gh --json` / API
  // output instead of thrashing on the (correctly denied) `python3 -c`.
  "jq *": "allow",
  "jq*": "allow",
  // Read-only system inspection (health checks, diagnosing the box). Only
  // no-op systemctl verbs — bare "systemctl *" would allow restart/stop.
  "free*": "allow",
  "uptime*": "allow",
  "nproc*": "allow",
  ps: "allow",
  "ps *": "allow",
  "top -b*": "allow",
  "systemctl status*": "allow",
  "systemctl is-active*": "allow",
  "systemctl is-enabled*": "allow",
  "systemctl list-units*": "allow",
};

// Compiled lazily on first use: building regexes at import would be harmless
// but pointless for the many processes that import this module and never run
// an ask-mode bash command.
let askBashRules: Array<{ re: RegExp; value: "allow" | "deny" }> | null = null;

/** Last-match-wins over insertion order: the exact evaluation the previous runner's
 *  Permission.evaluate applies to these same rules (a findLast with no
 *  specificity ranking), so the two engines cannot drift on what a pattern
 *  means. `*` matches any run of characters, everything else is literal. */
function askBashVerdict(segment: string): "allow" | "deny" {
  if (!askBashRules) {
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    askBashRules = Object.entries(ASK_BASH_PERMISSIONS).map(
      ([pattern, value]) => ({
        re: new RegExp(`^${pattern.split("*").map(escape).join("[\\s\\S]*")}$`),
        value,
      }),
    );
  }
  let verdict: "allow" | "deny" = "deny";
  for (const rule of askBashRules)
    if (rule.re.test(segment)) verdict = rule.value;
  return verdict;
}

/**
 * Why `command` may not run under read-only ask mode, or null when it may.
 *
 * Pi has no engine-side permission evaluator, so this is ASK_BASH_PERMISSIONS
 * applied the way the previous runner applies it: the command is split into its
 * pipeline/list segments and EVERY segment must match an allow rule.
 * `cat x && rm y` is denied for the rm, not allowed for the cat (the
 * rev-parse note above exists because the previous runner evaluates per sub-command;
 * matching only the whole line would let any allowed prefix smuggle a write).
 * Fail-closed on what a scanner cannot prove read-only: command and process
 * substitution embed commands this never sees, and output redirection writes
 * a file, so both are refused outright. Fd dups (2>&1) and redirects to
 * /dev/null stay allowed, since they appear in ordinary read pipelines.
 */
export function askBashDenyReason(command: string): string | null {
  const REFUSE =
    "Read-only ask mode: bash is limited to a read-only allowlist (file, git, gh and system reads). " +
    "Propose the exact command in your reply for a human to run.";
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let i = 0;
  const push = () => {
    segments.push(current);
    current = "";
  };
  while (i < command.length) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        current += command.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
        return `Command substitution is not allowed here. ${REFUSE}`;
      }
      if (ch === '"') quote = null;
      current += ch;
      i++;
      continue;
    }
    if (ch === "\\") {
      current += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === "`" || (ch === "$" && command[i + 1] === "(")) {
      return `Command substitution is not allowed here. ${REFUSE}`;
    }
    if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
      return `Process substitution is not allowed here. ${REFUSE}`;
    }
    if (ch === ">" || (ch === "&" && command[i + 1] === ">")) {
      // Redirection: allowed only as an fd dup (2>&1) or aimed at /dev/null.
      // Anything else writes a file, which read-only mode must refuse.
      let j = i + (ch === "&" ? 2 : 1);
      if (command[j] === ">") j++;
      if (command[j] === "&" && /\d/.test(command[j + 1] || "")) {
        while (command[j] && !/\s/.test(command[j])) j++;
        current += command.slice(i, j);
        i = j;
        continue;
      }
      while (command[j] === " " || command[j] === "\t") j++;
      let k = j;
      while (command[k] && !/[\s;|&<>]/.test(command[k])) k++;
      if (command.slice(j, k) !== "/dev/null") {
        return `Output redirection writes a file. ${REFUSE}`;
      }
      current += command.slice(i, k);
      i = k;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      push();
      i++;
      continue;
    }
    if (ch === "|") {
      push();
      i += command[i + 1] === "|" || command[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      push();
      i += command[i + 1] === "&" ? 2 : 1;
      continue;
    }
    current += ch;
    i++;
  }
  push();
  for (const raw of segments) {
    const segment = raw.trim();
    if (!segment) continue;
    if (askBashVerdict(segment) === "deny") {
      return `"${segment}" is not on the read-only allowlist. ${REFUSE}`;
    }
  }
  return null;
}
