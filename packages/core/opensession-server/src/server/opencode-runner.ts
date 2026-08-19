/**
 * OpenCode runner: THE engine (the legacy Claude/Codex SDK runners are
 * deleted — agent-runner maps every model id onto its opencode form and
 * dispatches here). Wraps a per-session `opencode serve` HTTP server
 * (OpenCode is MIT, 75+ providers) in the StreamEvent generator shape the
 * session pipeline / journal / audit contract downstream consumes.
 *
 * Model ids are `opencode/<provider>/<model>`
 * (e.g. opencode/anthropic/claude-sonnet-5, opencode/openai/gpt-5.5).
 * Provider auth is OpenCode's own
 * (`opencode auth login` → ~/.local/share/opencode/auth.json; HOME is passed
 * through), except two subscription paths: `opencode/openai/*` runs on our
 * ChatGPT-subscription auth (the codex accounts pool, seeded per-account — see
 * opencode-openai-auth.ts), and `opencode/anthropic/*`, which runs on
 * Claude-subscription capacity via one of two bridges selected by `bridge.mode`
 * in ~/.opensession-opencode.json (see opencode-config.ts):
 *
 *  - "meridian" (the default when enabled):
 *    the literal opencode-with-claude + @rynfar/meridian stack, bundled as
 *    exact-pinned npm deps and injected as an OpenCode plugin into the
 *    session's server config. The plugin starts Meridian in-process inside
 *    `opencode serve` (ephemeral loopback port, per-server MERIDIAN_API_KEY
 *    auth) and Meridian drives the official Claude Agent SDK. Completes turns
 *    on flat subscription quota (verified live 2026-07-08) — its bundled
 *    scrub plugin removes the opencode prompt fingerprints Anthropic's
 *    third-party-billing classifier keys on. Per-run account selection is
 *    ours: pool + the run user's own personal accounts (optionally restricted
 *    to bridge.accounts), pinned into the server via CLAUDE_CONFIG_DIR
 *    isolation + CLAUDE_CODE_OAUTH_TOKEN (see meridianAccountEnv).
 *  - "native": our own anthropic-bridge.ts (Agent SDK reimplementation with
 *    per-request HTTP audit and NO fingerprint scrubbing — Anthropic bills it
 *    to extra-usage credits). Kept selectable as the anti-evasion fallback.
 *  - "off" / config missing / enabled:false: anthropic models fail with a
 *    clear error.
 *
 * Audit granularity differs by mode: the native bridge audits EVERY HTTP
 * request (anthropic_bridge_request in/out); meridian runs inside the opencode
 * server process where we have no per-request hook, so we emit RUN-level
 * events instead (`opencode_meridian_run` start/end with session, model,
 * account, versions) — per-request detail exists only in opencode's own log
 * (~/.local/share/opencode/log/).
 *
 * Server lifecycle — TWO pools ("one opencode server, multiple sessions"):
 *
 *  - SHARED always-warm servers for eligible interactive runs (see
 *    sharedOpencodeEligible): ONE `opencode serve` per (bridge account ×
 *    user) tuple hosts every such session concurrently, multiplexed via
 *    opencode's per-directory app instances (`?directory=` on every API
 *    call; events + session.status are directory-scoped, so each run pumps
 *    its own directory's SSE stream). Everything per-run rides the prompt
 *    body — model, `system` (session context; appends to opencode's own
 *    system prompt), `agent` ("ask" = the config-defined read-only agent),
 *    and `tools` strips (unattended deny-sets, confirm-server `<name>_*`
 *    wildcards, in-process servers the run doesn't carry) — all verified
 *    live on opencode 1.17.15. In-process opensession-* tool calls
 *    are routed per session via opencode-plugin-session-tag.js + run-rpc's
 *    ocSession registry. cwd = a neutral state dir (never a worktree); idle
 *    kill after 6h; a config change while runs are active DRAINS the old
 *    server (fresh spawn takes the key, the old one dies with its last run)
 *    instead of aborting other sessions' turns. This pool is also the fix
 *    for the 2026-07-09 SQLite write-contention incident (21 per-session
 *    processes on one opencode.db WAL).
 *
 *  - Per-session servers (keyed by bks session id, falling back to cwd) for
 *    everything else: automations & unattended kinds (their least-privilege
 *    MCP allowlist stays CONFIG-level), runs carrying an explicit mcpServers
 *    allowlist, runner-host runs with prebuilt stdio proxies, and runs with
 *    in-process servers outside SHARED_INPROCESS_SERVERS (goal wakes).
 *    Killed after 30 minutes idle; config changes respawn immediately (runs
 *    are serial per session).
 *
 * Both pools: bound to 127.0.0.1 on an ephemeral port with a per-server
 * Basic-auth password, minimal env (PATH/HOME/LANG + git identity — mirrors
 * codexEnv; no opensession tokens). Parked on globalThis so `bun --hot` reloads
 * keep servers alive. Config (permissions, MCP servers, bridge provider
 * override, meridian plugin) is injected via OPENCODE_CONFIG_CONTENT at
 * spawn; a config OR per-server-env change (e.g. a different meridian
 * account was picked) respawns the server (sessions persist in OpenCode's
 * own storage, so this is safe between runs). In meridian mode
 * the Meridian proxy + its Agent SDK children live inside/under the opencode
 * server process, so killing the server reaps them too — but the meridian
 * plugin installs SIGTERM/SIGINT handlers that swallow the default terminate
 * action (verified live 2026-07-08: a meridian-enabled server survives
 * SIGTERM), so killServer escalates to SIGKILL after a short grace. The
 * 30-min idle kill and shutdown paths go through the same killServer.
 *
 * Permission model vs the Claude runner:
 *  - mode "ask" ⇒ read-only permission config: edit denied, bash restricted to
 *    a read-only command allowlist (everything else denied), write/edit/patch
 *    tools disabled. Backstop: any OpenCode permission ask that still surfaces
 *    is auto-rejected (there is no interactive permission bridge here yet).
 *  - `confirmTools` (per-call human approval, e.g. money-moving Stripe) have
 *    no approval bridge on this engine, so they are STRIPPED from the model's
 *    tool list on every run (the server itself stays mounted — reads work),
 *    and the instructions note tells the agent to propose such actions for a
 *    human instead. (Until 2026-07-26 interactive runs dropped the whole
 *    server, which needlessly blanked Stripe reads.)
 *  - Unattended least-privilege runs (automations, and any run carrying
 *    `deniedTools` — e.g. an interactive resume of an automation session) ARE
 *    allowed on this engine (automations run on opencode).
 *    Their deny-set is enforced by STRIPPING the tools from the model's tool
 *    list via OpenCode's `tools` config (opencodeRunPolicy → `<server>_<tool>`
 *    ids, naming verified live 2026-07-09 against opencode 1.17.15 + the
 *    stripe MCP; wildcard drift-guards on the money-movers only — see
 *    opencodeDeniedToolIds) — same mechanism ask-mode uses for
 *    write/edit/patch. confirmTools (Stripe money-movers) fold into that
 *    deny-set with the claude-runner `confirm_unattended` message (post the
 *    proposed action in the note for a human) instead of dropping the server,
 *    so Stripe READ tools stay available to automations. The per-call
 *    approval card is deliberately NOT ported. Other unattended kinds
 *    (action, github-*, security-scan) stay deny-by-default.
 *
 * Failure containment: each run watches `proc.exited` for its server, so a
 * mid-turn `opencode serve` death emits a clean error event (instead of
 * wedging the drain loop on `wake` forever and holding the session busy),
 * removes the dead server from the pool, and lets normal cleanup run. Each
 * turn also carries a hard wall-clock deadline (default 60 min,
 * `turnTimeoutMinutes` in ~/.opensession-opencode.json) that aborts the turn
 * with a clear error.
 *
 * Steering/interrupt: mid-turn steers land in-band via steerOpencodeRun
 * (noReply message append — the running turn reads it at its next LLM call;
 * see the doc at its definition). What OpenCode still lacks is
 * interrupt-and-steer (a forced turn boundary, Esc+Enter style) — that path
 * falls back to abort + queue until opencode v2's delivery:"steer"; cancel
 * maps to `POST /session/:id/abort` + process-level abort.
 *
 * Resume after a opensession restart: the journal records the OpenCode session
 * id (in ActiveRunRecord.claudeSessionId, like Codex thread ids) and the full
 * `opencode/...` model id, so the dispatcher routes the resume back here and
 * we re-prompt the same OpenCode session (a fresh `opencode serve` finds it in
 * OpenCode's on-disk storage). What resume CANNOT preserve: the interrupted
 * turn's in-flight output/tool state (the continuation prompt asks the model
 * to review and pick up), any queued-but-undelivered steers, and pending
 * permission asks.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import type { Subprocess } from "bun";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { RunAgentOpts } from "./agent-runner";
import {
  journalSet,
  buildRunJournalRecord,
  journalClear,
  registerActiveRunProbe,
  activeRunRecords,
  type ActiveRunRecord,
} from "./run-journal";
import { BlockFlusher, streamPartialTextEnabled, TextPartStream } from "./stream-text";
import { transitionRunState } from "./run-state";
import {
  adoptedProcHandle,
  bunProcHandle,
  opencodeDetachActive,
  opencodeServerHealthy,
  pickFreePort,
  readDetachedRegistry,
  removeDetachedRecord,
  spawnDetachedOpencodeServer,
  reapUnregisteredScopes,
  stopDetachedUnit,
  upsertDetachedRecord,
  type DetachedServerRecord,
  type ServerProcHandle,
} from "./opencode-detach";
import {
  isClaudeUsageLimitError,
  isClaudeSubscriptionError,
  isClaudeBridgeLaunchError,
  isUpstreamIdleStallError,
  isCodexUsageLimitError,
  isTransientRunError,
  CLAUDE_CODE_BIN,
  looksLikeFabricatedToolTranscript,
  ASK_BASH_PERMISSIONS,
} from "./runner-shared";
import {
  contextRebuildNotice,
  isContextRebuildStep,
  isLikelyPromptCacheMiss,
  type StepPromptUsage,
  type StreamEvent,
  type ImageInput,
  type TurnUsage,
} from "./run-events";
import { audit, summarizeText } from "./audit";
import { gitIdentityEnv, userMatchesAny, type GitIdentity } from "./shared/user-mappings";
import { buildRunInstructions } from "./run-instructions";
import { githubAuthEnv, githubUserLoginForRun } from "./github-auth";
import { homeDir, OPENSESSION_SESSIONS_DIR } from "./paths";
import { stateDir } from "./paths";
import { resolveOpencodeBin, versionTuple } from "./opencode-bin";
import { isDevInstance } from "./dev-mode";
import {
  normalizeModelEffort,
  dialPreset,
  DIAL_ORACLE_AGENTS,
  sameBridgeDialOracle,
  orchestratorPreset,
  ORCHESTRATOR_WORKER_AGENTS,
  orchestratorWorkerForBridge,
  opencodeModelLabel,
} from "./models";
import { resolveWorkspaceModelPreset } from "./workspace-model-presets";
import {
  registerRunToken,
  unregisterRunToken,
  registerOcSessionContext,
  unregisterOcSessionContext,
  releaseOcSessionContext,
  type OcSessionContext,
} from "./run-rpc";
import {
  parseOpencodeModel,
  INTERACTIVE_KINDS,
  isUnattendedKind,
  poolWaitMsFor,
  baseJournalKind,
  SHARED_INPROCESS_SERVERS,
  sharedOpencodeEligible,
  sharedServerKey,
  opencodeGateReason,
  opencodeRunPolicy,
  buildOpencodeMcpConfig,
  inProcessOpencodeMcpConfigs,
  opencodeMcpFromPrebuiltProxies,
  readLocalInstructions,
} from "./opencode-policy";
// The run-policy layer (gating, tool stripping, shared-server eligibility,
// MCP config builders) was extracted verbatim into opencode-policy.ts.
// Re-export its public surface from this module — its historical home — so
// existing imports, docs, and security notes stay valid. poolWaitMsFor was
// private here and is deliberately not re-exported (imported above for use).
export {
  parseOpencodeModel,
  INTERACTIVE_KINDS,
  isUnattendedKind,
  baseJournalKind,
  sharedOpencodeEligible,
  sharedServerKey,
  opencodeGateReason,
  type OpencodeRunPolicy,
  opencodeDeniedToolIds,
  opencodeRunPolicy,
  buildOpencodeMcpConfig,
  proxyOpencodeMcpConfigs,
  remoteOpencodeMcpConfigs,
  inProcessOpencodeMcpConfigs,
  readLocalInstructions,
} from "./opencode-policy";
import {
  appendOpencodeTranscript,
  backfillOpencodeTranscriptGap,
  ensureOpencodeTranscriptFile,
  opencodeOpenTaskSnapshot,
  opencodeTurnActivitySnapshot,
  opencodeTurnLooksCompleted,
  recordBksSessionFor,
  recordOpencodeDbFor,
  recordedOpencodeDbFor,
  storeAppendUserLineEarly,
  transcriptLineUser,
  transcriptLineRunnerNotice,
  transcriptLineAssistantText,
  transcriptLineCompactionSummary,
  transcriptLineToolUse,
  transcriptLineToolResult,
  opencodeToolResultImages,
} from "./opencode-transcript";
import { toolResultMedia } from "./transcript-media";
import { bashAskPolicyReply } from "./command-policy";
import { buildEngineSwitchHandoffNote } from "./fork-handoff";
import { recoverFreshEngineTranscript } from "./engine-handoff-transcript";
import { wrapContext } from "./prompt-context";
import { logInjectedContext, logStandingContext, logStandingJson } from "./context-log";
import { ensureAnthropicBridge } from "./anthropic-bridge";
import { ensureAgentAwsCredsFile } from "./aws-creds";
import {
  pickOpenaiAccount,
  bindOpenaiAccount,
  linkGhDataDir,
  maskOpenaiAccount,
  opencodeHasNativeOpenaiAuth,
  openaiPromptVariant,
  type OpenaiAuthMechanism,
} from "./opencode-openai-auth";
import {
  markCodexExhausted,
  markCodexWedged,
  clearCodexWedge,
  type CodexAccount,
} from "./codex-accounts";
import {
  opencodeTurnTimeoutMs,
  toolStallError,
  toolStallNotice,
  turnTimeoutError,
  turnTimeoutNotice,
  readOpencodeBridgeConfig,
  opencodeProviderOptions,
} from "./opencode-config";
import {
  pickAccount,
  peekAccount,
  getUsableAccountById,
  getAccountById,
  markExhausted,
  markWedged,
  clearWedge,
  refreshUsageIfNearLimit,
  registerMeridianQuotaProvider,
  waitForUsableAccount,
  type ClaudeAccount,
} from "./claude-accounts";

const HOME = homeDir();
/** opencode binary (installed user-level: `npm i -g opencode-ai`).
 * `let`, not `const`: an `npm i -g` upgrade can replace the bin tree out from
 * under a module-load-time resolution (2026-08-03: ENOENT on a stale
 * .nvm/…/bin/opencode path killed in-flight runs while the binary existed at
 * its new path) — freshOpencodeBin() re-resolves when the cached path dies. */
export let OPENCODE_BIN = resolveOpencodeBin();

/** The cached path if it still exists, else one re-resolution of the full
 * chain (PATH, nvm scan, installer default). Updates OPENCODE_BIN on a move
 * so version asserts and log lines name the binary actually in use. */
function freshOpencodeBin(): string {
  if (existsSync(OPENCODE_BIN)) return OPENCODE_BIN;
  const re = resolveOpencodeBin();
  if (re !== OPENCODE_BIN && existsSync(re)) {
    console.warn(`[opencode-runner] opencode binary moved: ${OPENCODE_BIN} -> ${re}`);
    OPENCODE_BIN = re;
  }
  return OPENCODE_BIN;
}

// Source-verified floor: anomalyco/opencode@fa95a61c4 first classified
// absolute paths as file plugins, and v1.3.8 is the first release containing it.
/** Instructions/state under the session store (exported for the state-path
 *  regression test — must stay derived from the SAME dual-read resolution the
 *  docker adapter mounts by, or in-container runs break; see
 *  containerStateDirFixups in sandbox/docker.ts). */
export const OPENCODE_STATE_DIR = `${OPENSESSION_SESSIONS_DIR}/opencode`;

/** Per-server SQLite shards (2026-07-17 storage review): every `opencode
 *  serve` process gets its own DB file via the official OPENCODE_DB env var —
 *  per-session servers one DB per session, shared servers one DB per
 *  (account × user). One writer per file by construction, so the July 9/17
 *  cross-process SQLITE_BUSY melts can't recur. Engine sessions that predate
 *  sharding live in the legacy DBs; a resume that misses on the new shard
 *  degrades to the existing transcript-seeded fresh session. Kill switch:
 *  OPENSESSION_OC_DB_SHARD=0 reverts to opencode's default DB locations. */
const SHARD_DB_DIR = `${OPENCODE_STATE_DIR}/db`;

function opencodeDbShardActive(): boolean {
  const v = (process.env.OPENSESSION_OC_DB_SHARD || "").trim().toLowerCase();
  return v !== "0" && v !== "false";
}

export function shardDbPathForKey(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${SHARD_DB_DIR}/${safe}.db`;
}

/** How long a status-poll failure streak may ride on "the server is starved,
 *  not dead" verdicts before the turn is ended anyway. */
const STARVED_POLL_GRACE_MS = 10 * 60_000;

/** Starvation-aware verdict for the status-poll zombie guards. After ~60s of
 *  consecutive poll failures the guards used to end the turn unconditionally —
 *  but under a host load spike a perfectly healthy `opencode serve` can be too
 *  CPU-starved to answer a status poll for minutes while its turn keeps
 *  running (a turn was dropped this way during the 2026-08-05 spike, load 13+
 *  with ~18 engine servers). Probe with a generous timeout: an answer means
 *  starved (keep watching, bounded by STARVED_POLL_GRACE_MS per streak); a
 *  refusal means the server is actually gone (end the turn as before). */
async function zombiePollVerdict(
  url: string,
  password: string,
  streakStartedAt: number
): Promise<"starved" | "dead" | "gave_up"> {
  const alive = await opencodeServerHealthy(url, password, 20_000);
  if (!alive) return "dead";
  return Date.now() - streakStartedAt < STARVED_POLL_GRACE_MS ? "starved" : "gave_up";
}

function zombiePollFailureMessage(verdict: "dead" | "gave_up"): string {
  return verdict === "dead"
    ? "opencode server stopped answering status polls and refused a health probe — ending the turn " +
        "(engine state preserved; send again to continue)"
    : "opencode server answered health probes but was too starved to serve status for " +
        `${Math.round(STARVED_POLL_GRACE_MS / 60_000)} minutes — ending the turn ` +
        "(engine state preserved; send again to continue)";
}

// 90s, not 30s: under heavy host IO/swap pressure a healthy `opencode serve`
// can genuinely take >30s to answer. A premature timeout is worse than a slow
// start — the detached path falls back to a DIRECT child (dies with the next
// restart, MCP children and all) and abandons a scope that often comes alive
// moments later (see reapUnregisteredScopes). Broken spawns still fail fast
// via the exit-code check.
const SERVER_START_TIMEOUT_MS = 90_000;
const IDLE_KILL_MS = 30 * 60 * 1000;
/** Shared servers are the always-warm pool — kept alive far longer than the
 *  per-session 30-min kill (they serve every eligible interactive session on
 *  their account, and their whole point is no cold boots / MCP reconnects).
 *  Still bounded so an abandoned pool member (e.g. its account went unusable
 *  and every session rotated away) doesn't linger forever. 2h, not the old 6h:
 *  the Anthropic prompt cache is dead after ~1h anyway, so past that an idle
 *  server only buys skipping a ~5s cold boot — and at (accounts × users)
 *  fan-out the fleet reached 46 servers / 25GB RSS and pushed the box 14GB
 *  into swap (2026-07-22). */
const SHARED_IDLE_KILL_MS = 2 * 60 * 60 * 1000;
/** Neutral cwd for shared servers — sessions bring their own directory via
 *  the per-call `?directory=` query (verified live 2026-07-09: opencode
 *  instantiates per-directory app instances; bash/tools run in the session's
 *  directory, events + status are scoped to it). Never a worktree. */
const SHARED_CWD = `${OPENCODE_STATE_DIR}/shared-cwd`;
/** Plugin that tags michael-* / opensession-* tool calls with the opencode
 *  session id so run-rpc can route them to the right opensession session on a
 *  shared server (see opencode-plugin-session-tag.js). */
const SESSION_TAG_PLUGIN_PATH = join(import.meta.dir, "opencode-plugin-session-tag.js");
/** Repairs model-stringified object args on MCP tool calls (see the plugin's
 *  module doc; upstream closed coercion as not-planned). */
const ARG_COERCE_PLUGIN_PATH = join(import.meta.dir, "opencode-plugin-arg-coerce.js");

const PROVIDER = "opencode" as const;

// ── Meridian bridge (opencode/anthropic/* default path) ──────────────────────
//
// VERSION PINNING (package.json): opencode-with-claude 1.6.18 +
// @rynfar/meridian 1.51.0 + @rynfar/meridian-plugin-opencode-scrub 0.2.0 are
// pinned EXACT. These versions chase Anthropic's third-party billing-gate
// behavior (the scrub plugin exists to keep turns on flat subscription quota);
// bump deliberately after watching the repos' releases, and re-run
// scripts/verify-opencode.ts against a scratch config before shipping a bump.

interface MeridianStackInfo {
  /** Absolute path to the plugin entry, injected into OPENCODE_CONFIG_CONTENT `plugin`. */
  pluginPath: string;
  pluginVersion: string;
  meridianVersion: string;
}

export function meridianProxyBaseUrl(port: string | number | undefined): string {
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid Meridian proxy port: ${port ?? "missing"}`);
  }
  return `http://127.0.0.1:${parsed}`;
}

export function missingAssistantTurnError(provider: string): string {
  return (
    `opencode ${provider} turn ended without an assistant message. ` +
    "The provider or engine bridge failed before producing output; retry after checking the Open Session server logs."
  );
}

export function latestTurnAssistant<T extends { info?: { role?: string } }>(messages: T[]): T | undefined {
  const lastUser = messages.findLastIndex((message) => message.info?.role === "user");
  return messages
    .slice(lastUser + 1)
    .reverse()
    .find((message) => message.info?.role === "assistant");
}

/**
 * Every assistant message of the CURRENT turn, oldest first.
 *
 * opencode emits one assistant message per model request, so a turn that calls
 * tools is many messages, each carrying its own `tokens` and `cost`. Anything
 * measuring work DONE (tokens moved, money spent) has to sum them; only the
 * context-window LEVEL comes from the final one. Reading just the last message
 * is what made Analytics under-report cost 6.6x and tokens 7.8x. A turn
 * averages 7.5 steps here, and runs to 123.
 */
export function currentTurnAssistants<T extends { info?: { role?: string } }>(messages: T[]): T[] {
  const lastUser = messages.findLastIndex((message) => message.info?.role === "user");
  return messages.slice(lastUser + 1).filter((message) => message.info?.role === "assistant");
}

/** Delete trailing assistant messages that carry no text and no tool call
 *  from the engine session. A reasoning-only tail (Sol empty completion,
 *  first seen 2026-08-04 in slack-C09BAFFK8F8-1785828070) is rejected
 *  wholesale by the OpenAI Responses backend on every LATER request
 *  ("reasoning item without its required following item"), so leaving it in
 *  place turns the session into a deterministic death loop. Walks from the
 *  tail: user messages are kept (queued prompts re-deliver fine), the first
 *  substantive assistant message stops the walk. Uses the raw DELETE
 *  /session/:id/message/:id endpoint (verified live on 1.17.15; the pinned
 *  v1 SDK has no deleteMessage). Best-effort — any failure stops the walk. */
async function pruneOrphanedAssistantTail(
  server: { url: string; password: string },
  ocSessionId: string,
  list: Array<{ info?: { id?: string; role?: string }; parts?: Array<{ type?: string; text?: string }> }>,
  directory?: string,
): Promise<number> {
  let pruned = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const role = list[i].info?.role;
    if (role === "user") continue;
    if (role !== "assistant") break;
    const parts = list[i].parts || [];
    const substantive = parts.some(
      (p) => (p.type === "text" && p.text) || p.type === "tool",
    );
    if (substantive) break;
    const id = list[i].info?.id;
    if (!id) break;
    try {
      const dir = directory ? `?directory=${encodeURIComponent(directory)}` : "";
      const res = await fetch(
        `${server.url}/session/${ocSessionId}/message/${id}${dir}`,
        {
          method: "DELETE",
          headers: { Authorization: `Basic ${btoa(`opencode:${server.password}`)}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) break;
      pruned++;
      console.warn(
        `[opencode-runner] pruned orphaned assistant tail message ${id} from ${ocSessionId}`,
      );
    } catch {
      break;
    }
  }
  return pruned;
}

/** An assistant message that is opencode's autocompact handoff summary — the
 *  reply to the synthetic `compaction`-part user message. Its text must land
 *  in the transcript as a "context compacted" system chip, never as the
 *  model's own reply (and never be pushed to stream consumers like the Slack
 *  loop). NOTE: user messages carry `summary` as a diffs OBJECT — gate on
 *  role + `summary === true`, never truthiness. */
function isCompactionMessageInfo(info: unknown): boolean {
  const m = info as { role?: string; summary?: unknown; mode?: string; agent?: string } | null;
  return (
    !!m &&
    m.role === "assistant" &&
    (m.summary === true || m.mode === "compaction" || m.agent === "compaction")
  );
}

let cachedMeridianStack: MeridianStackInfo | undefined;

function pkgVersionNear(entryPath: string): string {
  try {
    // dist/index.js → ../package.json (both packages ship dist/ at the root).
    return JSON.parse(readFileSync(join(dirname(entryPath), "..", "package.json"), "utf-8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

/** Resolve the bundled opencode-with-claude plugin (throws a clear error when
 *  the packages are missing — e.g. a checkout without `bun install`). */
export function meridianStackInfo(): MeridianStackInfo {
  if (cachedMeridianStack) return cachedMeridianStack;
  let pluginPath: string;
  let meridianEntry: string;
  try {
    pluginPath = Bun.resolveSync("opencode-with-claude", import.meta.dir);
    meridianEntry = Bun.resolveSync("@rynfar/meridian", import.meta.dir);
  } catch (e: any) {
    throw new Error(
      "The meridian bridge packages are not installed (opencode-with-claude / @rynfar/meridian) — " +
        `run \`bun install\` in the opensession checkout. (${e?.message || e})`
    );
  }
  cachedMeridianStack = {
    pluginPath,
    pluginVersion: pkgVersionNear(pluginPath),
    meridianVersion: pkgVersionNear(meridianEntry),
  };
  return cachedMeridianStack;
}

/** Per-account Claude config dirs for Meridian's SDK subprocesses. Isolating
 *  CLAUDE_CONFIG_DIR is what actually pins the account: with the host HOME
 *  passed through, the claude CLI silently falls back to ~/.claude/
 *  .credentials.json (the host login) even when CLAUDE_CODE_OAUTH_TOKEN is
 *  set — verified live 2026-07-08 (an invalid env token still completed via
 *  the host store; with an isolated CLAUDE_CONFIG_DIR it hard-fails instead).
 *  So each account gets an empty config dir + the env token: the selected
 *  account is the only reachable credential, and a bad token fails closed
 *  instead of burning the host login's quota. */
export const MERIDIAN_CFG_ROOT = `${stateDir("opencode")}/meridian-cfg`;

/**
 * Private Meridian session-mapping store per (server key × account).
 *
 * Meridian's default is ONE `~/.cache/meridian/sessions.json` shared by every
 * proxy process (getStorePath in the bundle). Its read-modify-write is atomic
 * WITHIN a process but has no cross-process safety: the advisory lock gives up
 * after a single retry and writes anyway, and every writer renames through the
 * same fixed `sessions.json.tmp`. With ~24 servers live that store is a shared
 * mutable file with no mutual exclusion — measured over 11 days of server logs:
 * 1462 "could not acquire lock, proceeding without", 167 ENOENT renames, 14
 * stale-lock recovery failures. Losing a mapping makes Meridian classify a
 * mid-conversation request as diverged and replay the whole history into a
 * fresh SDK session (a silent context rebuild — see makeContextRebuildWatcher).
 * One writer per directory removes the whole class by construction.
 *
 * accountId is in the path because `bks-*` and oneshot server keys are
 * account-independent: without it, an account rotation would inherit mappings
 * pointing into another account's CLAUDE_CONFIG_DIR.
 */
export const MERIDIAN_SESSION_ROOT = `${stateDir("opencode")}/meridian-sessions`;

function meridianSessionDir(serverKey: string, accountId: string): string {
  return `${MERIDIAN_SESSION_ROOT}/${serverKey.replace(/[^A-Za-z0-9._-]/g, "_")}/${accountId}`;
}

/**
 * One-time seed of a fresh per-key store from the legacy shared file, so live
 * conversations survive the cutover respawn instead of each paying one forced
 * full-history replay.
 *
 * Safe because the keys are opaque, globally-unique opencode `ses_*` ids (638/638
 * verified on this host) with no proxy/account/cwd scoping: a copy preserves
 * exactly the lookups this server will perform, and entries belonging to other
 * servers are never looked up. A copied entry can't cause a WRONG resume either
 * — Meridian only reuses one whose stored messageHashes match the incoming
 * conversation, and if its claudeSessionId belongs to another account's config
 * dir the SDK throws, the entry is evicted as stale, and the request replays:
 * exactly the cost of having had no entry at all.
 */
function seedMeridianSessionDir(dir: string): void {
  try {
    if (existsSync(`${dir}/sessions.json`)) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const legacy = `${HOME}/.cache/meridian/sessions.json`;
    if (existsSync(legacy)) writeFileSync(`${dir}/sessions.json`, readFileSync(legacy));
  } catch (e) {
    console.warn("[opencode-runner] meridian session-store seed failed:", e);
  }
}

/**
 * Install the opencode-fingerprint scrub as a Meridian PROXY plugin so it runs
 * SERVER-SIDE (in the proxy's onRequest pipeline) rather than only in the v1
 * OpenCode `experimental.chat.system.transform` hook. Why this exists: the
 * scrub is what strips opencode's identity tells from the system prompt so
 * Anthropic bills the request against the Claude subscription plan instead of
 * third-party extra-usage. The v1 hook only fires on the v1 engine; when a run
 * dispatches through the v2 session loop (no equivalent hook shipped yet —
 * v2's plugin domains are agent/aisdk/catalog/… with no request/system hook,
 * 2026-07-12) the system prompt would reach Anthropic un-scrubbed and get
 * billed as third-party. Both engines send through the SAME in-process proxy
 * on the `opencode` adapter, so scrubbing at the proxy is engine-agnostic and
 * future-proofs the v2 cutover. Idempotent for v1 (the client hook already
 * scrubbed the identical text, so the server pass is a no-op).
 *
 * Meridian reads plugins from `<HOME>/.config/meridian/plugins/*.{js,ts}`
 * (not overridable via env in the bundled build), loaded fault-tolerantly at
 * proxy startup. We drop a one-line re-export of the version-pinned installed
 * scrub package so it tracks node_modules. Runs once per process; the proxy
 * picks it up when the next meridian server (and its proxy) spawns.
 */
let meridianProxyScrubInstalled = false;
function ensureMeridianProxyScrub(): void {
  if (meridianProxyScrubInstalled) return;
  meridianProxyScrubInstalled = true;
  try {
    const scrubPkg = Bun.resolveSync(
      "@rynfar/meridian-plugin-opencode-scrub",
      import.meta.dir,
    );
    // Meridian's proxy resolves the plugin dir via os.homedir(); with HOME set
    // (systemd unit + opencodeEnv both pass it) that equals this HOME. The
    // proxy runs in-process in the opencode server, which inherits it.
    const pluginDir = `${HOME}/.config/meridian/plugins`;
    mkdirSync(pluginDir, { recursive: true });
    // The loader matches .js/.ts only and imports the default export by
    // absolute path — a re-export resolves without relative-path juggling.
    writeFileSync(
      `${pluginDir}/opencode-scrub.js`,
      `export { default } from ${JSON.stringify(scrubPkg)}\n`,
    );
  } catch (e) {
    // Non-fatal: a missing scrub package just leaves v2 traffic un-scrubbed
    // (v1 still scrubs client-side). Never block a run on this.
    console.error("[opencode-runner] meridian proxy scrub install failed:", e);
    meridianProxyScrubInstalled = false;
  }
}

/**
 * Env for a meridian-mode `opencode serve` process. The Meridian proxy runs
 * in-process in that server (the plugin calls startProxyServer) and passes its
 * process env through to the Agent SDK subprocess, so this is the per-session
 * account-auth channel. Note the token is therefore visible to the session's
 * own shell tools via `env` — the same exposure class as claude-runner, whose
 * SDK subprocess (and its Bash children) carry CLAUDE_CODE_OAUTH_TOKEN today.
 */
export function meridianAccountEnv(
  account: ClaudeAccount,
  meridianKey: string,
  serverKey: string,
): Record<string, string> {
  const cfgDir = `${MERIDIAN_CFG_ROOT}/${account.id}`;
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  return {
    CLAUDE_CODE_OAUTH_TOKEN: account.token,
    CLAUDE_CONFIG_DIR: cfgDir,
    // Loopback-only is Meridian's default bind; MERIDIAN_API_KEY additionally
    // requires x-api-key on every /v1/* request (verified live: 401 without
    // it), so another local process can't ride the proxy. The same key is set
    // as the opencode anthropic provider apiKey.
    MERIDIAN_API_KEY: meridianKey,
    // A port we allocate (never the shared 3456 default) — one Meridian per
    // opencode server, no cross-server contention, and knowing the port lets
    // us query the proxy's /v1/usage/quota for account usage. Freshly picked
    // per call and EXCLUDED from the server config hash (ensureOpencodeServer)
    // so it never forces a respawn; a reused server keeps serving on the port
    // it originally bound (entry.meridianPort is the truth).
    CLAUDE_PROXY_PORT: String(pickFreePort()),
    // Deterministic SDK executable (same binary claude-runner uses) instead of
    // Meridian's bundled/platform/PATH probing.
    MERIDIAN_CLAUDE_PATH: CLAUDE_CODE_BIN,
    // Keep non-core schemas out of Anthropic's stable prompt prefix. Meridian
    // marks everything but opencode's core tools deferrable and lets the Agent
    // SDK's ToolSearch surface them on demand. NOTE: upstream this saved
    // nothing until the `tools: []` → `--tools ""` patch below (patches/), which
    // is what actually keeps ToolSearch itself enabled — without it every
    // "deferred" schema still rode every request (243k-token first prompts).
    MERIDIAN_DEFER_TOOL_THRESHOLD: "15",
    // Private session-mapping store (see MERIDIAN_SESSION_ROOT). Deterministic
    // per key+account, so it rides the server config hash without churning it.
    MERIDIAN_SESSION_DIR: meridianSessionDir(serverKey, account.id),
    // Meridian's own cap is 10k entries with no TTL, and it rewrites the whole
    // file on every request. A per-key store holds a handful of sessions; 200
    // keeps the rewrite cheap with a wide margin.
    MERIDIAN_MAX_STORED_SESSIONS: "200",
    // Meridian collapses every *opus* model id to the SDK's `opus` alias and
    // pins the concrete version itself (1.51.0 pins claude-opus-4-8, which
    // predates Opus 5). This env var wins over Meridian's pin, so all opus
    // requests — including old sessions stored as claude-opus-4-8 — serve
    // Claude Opus 5 (launched 2026-07-24; same $5/$25 rate card as 4.8).
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
  };
}

/** Reverse of meridianAccountEnv: which Meridian proxy port/account a spawn
 *  env carries, for recording on the server entry at spawn time. */
function meridianEnvIdentity(
  env?: Record<string, string>
): { meridianPort?: number; accountId?: string } {
  if (!env?.MERIDIAN_API_KEY) return {};
  const dir = env.CLAUDE_CONFIG_DIR;
  return {
    meridianPort: Number(env.CLAUDE_PROXY_PORT) || undefined,
    accountId: dir?.startsWith(`${MERIDIAN_CFG_ROOT}/`)
      ? dir.slice(MERIDIAN_CFG_ROOT.length + 1)
      : undefined,
  };
}

/**
 * Pick the account a meridian run authenticates as, most-specific first:
 *
 *  1. `pinnedId` — the session's pinned subscription (session.accountId).
 *     Soft pin by default: an unusable/foreign pin falls through to the
 *     normal pick. `strict` (automation cost cap) errors instead, so the
 *     model-fallback chain takes over rather than the shared pool.
 *  2. `stickyId` — the account this session's server is already running on.
 *     Switching accounts mid-session respawns the opencode server (the env
 *     is part of the config hash → full MCP/LSP/meridian cold boot) AND
 *     forfeits Anthropic's prompt cache, so a session stays on its account
 *     until it stops being usable (usage limit → markExhausted → re-pick).
 *  3. `ids` (bridge.accounts) restricts to designated accounts in list
 *     order; otherwise the normal accounts-layer pick (personal-first for
 *     the run user, then shared pool, least-utilized first).
 *
 * In every path another user's personal account is never used — same rule
 * as accountsForRemoteUpload (fail closed).
 */
export function pickMeridianAccount(
  user: string | undefined,
  model: string | readonly string[],
  ids?: string[],
  pinnedId?: string,
  strict?: boolean,
  stickyId?: string,
  out?: { reason?: string },
  recordPick = true,
  allowExtraUsage?: boolean,
): ClaudeAccount | { error: string } {
  const allowedOwner = (a: ClaudeAccount) => !a.owner || (!!user && userMatchesAny(user, [a.owner]));
  const designated = (id: string) => !ids?.length || ids.includes(id);
  if (pinnedId) {
    const pinned = getUsableAccountById(pinnedId, model, allowExtraUsage);
    if (pinned && allowedOwner(pinned) && designated(pinnedId)) {
      if (out) out.reason = "pinned";
      return pinned;
    }
    if (strict) {
      const name = getAccountById(pinnedId)?.name || pinnedId;
      return { error: `pinned account ${name} is not currently usable (hard pin — not falling back to the pool)` };
    }
  }
  if (stickyId && designated(stickyId)) {
    const sticky = getUsableAccountById(stickyId, model, allowExtraUsage);
    if (sticky && allowedOwner(sticky)) {
      if (out) out.reason = "sticky";
      return sticky;
    }
  }
  if (ids?.length) {
    for (const id of ids) {
      const a = getUsableAccountById(id, model, allowExtraUsage);
      if (a && allowedOwner(a)) {
        if (out) out.reason = "designated";
        return a;
      }
    }
    const known = ids.map((id) => getAccountById(id)?.name || id).join(", ");
    return { error: `no designated meridian bridge account is currently usable (tried: ${known})` };
  }
  const picked = recordPick
    ? pickAccount(undefined, user, model, allowExtraUsage)
    : peekAccount(undefined, user, model, allowExtraUsage);
  if (picked) {
    if (out) out.reason = picked.owner ? "personal-first" : "pool";
    return picked;
  }
  return { error: "no usable Claude account for the meridian bridge (pool exhausted or none configured)" };
}

/** Provider-dry dispatch circuit: when the configured Meridian account set is
 * already known unusable, let agent-runner enter its fallback graph without
 * starting an OpenCode attempt that can only emit another identical error.
 * Returns null for non-Anthropic models and bridge modes whose availability is
 * not represented by the Meridian subscription pool. */
export function claudePoolDryReason(
  opts: Pick<
    RunAgentOpts,
    "user" | "accountId" | "accountStrict" | "usageCredits" | "journal"
  >,
  model: string,
): string | null {
  // Unattended runs intentionally wait for a near reset instead of model-
  // hopping immediately; preserve that backpressure path in runOpencode.
  if (poolWaitMsFor(opts.journal?.kind) > 0) return null;
  const parsed = parseOpencodeModel(model);
  if (parsed?.providerID !== "anthropic") return null;
  const cfg = readOpencodeBridgeConfig();
  if (!cfg?.enabled || cfg.bridgeMode !== "meridian") return null;
  const picked = pickMeridianAccount(
    opts.user,
    parsed.modelID,
    cfg.bridgeAccountIds,
    opts.accountId,
    opts.accountStrict,
    undefined,
    undefined,
    false,
    opts.usageCredits,
  );
  return "error" in picked ? picked.error : null;
}

/**
 * Every Anthropic model a Dial preset may need during the turn. Account
 * selection used to consider only the main model, so Opus+Fable could start
 * on an account whose Opus allowance was healthy but whose Fable-scoped
 * allowance was already dry. The later oracle request then hung behind
 * Meridian instead of letting runAgent enter its normal Sol fallback graph.
 */
export function meridianRequiredModels(
  mainModelID: string,
  dialOracleAgent?: string
): string[] {
  const required = [mainModelID];
  if (dialOracleAgent) {
    const effectiveAgent = sameBridgeDialOracle(dialOracleAgent, "anthropic");
    const oracleModel = DIAL_ORACLE_AGENTS[effectiveAgent]?.model;
    if (oracleModel?.startsWith("anthropic/")) {
      required.push(oracleModel.slice("anthropic/".length));
    }
  }
  return [...new Set(required)];
}

// Sticky meridian account per server key (bks session id / cwd): parked on
// globalThis so hot reloads keep live sessions on their account.
const stickyMeridianAccounts: Map<string, string> = (
  (globalThis as any).__stickyMeridianAccounts ??= new Map()
);

// globalThis does NOT survive a real `systemctl restart`: with the sticky map
// empty, the next prompt on an existing engine session pool-picks freely, and
// when it lands on a different account the (account × user) shared server has
// never seen that session — the runner logs "not found — starting fresh" and
// the session silently loses its whole engine context (bks-019fa3cd,
// 2026-07-27). db-map.json persistently records which account-shard DB every
// engine session lives in, so derive the account from there when the
// in-memory map has no answer.
function stickyAccountFromDbMap(ocSessionId: string): string | undefined {
  if (!ocSessionId) return undefined;
  const db = recordedOpencodeDbFor(ocSessionId);
  return db?.match(/\/shared_anthropic-([0-9a-f-]{36})_[^/]+\.db$/)?.[1];
}

/** The account id a next run on this session would stick to, resolved the same
 *  way the run does: the in-memory map first, then the durable db-map (which
 *  is the only answer that survives a restart). Read-only — for the
 *  effective-config endpoint; the run itself still re-picks if it is not
 *  usable. */
export function stickyMeridianAccountFor(
  sessionKey: string,
  ocSessionId?: string | null
): string | undefined {
  return stickyMeridianAccounts.get(sessionKey) ?? stickyAccountFromDbMap(ocSessionId || "");
}

// ── OpenCode config generation ───────────────────────────────────────────────

/** Ask-mode external_directory rules: composer attachments are staged under
 *  the sessions uploads dir (outside any worktree), so reading them must work in
 *  read-only sessions too; everything else outside the worktree stays denied
 *  (deny errors immediately — never "ask", which blocks the tool on a
 *  permission ask; see the permission-ask bridge in runOpencodeAttempt).
 *  Catch-all deny FIRST — last-match-wins, see ASK_BASH_PERMISSIONS. */
const ASK_EXTERNAL_DIR_PERMISSIONS: Record<string, "allow" | "deny"> = {
  "*": "deny",
  [`${OPENSESSION_SESSIONS_DIR}/uploads/**`]: "allow",
  // Shared scratch: digests, triage and other read-only runs stage working
  // files under /tmp/opencode/<subdir>/… — a single-star glob wouldn't match
  // those nested paths, so allow the whole subtree (deny catch-all is first,
  // last-match-wins). It's a throwaway scratch dir, no security surface.
  "/tmp/opencode/**": "allow",
};

// ── Server pool ──────────────────────────────────────────────────────────────

export interface OpencodeServerEntry {
  /** Direct Bun child, this process's systemd-run waiter, or an ADOPTED
   *  detached scope from before a restart (see opencode-detach.ts). */
  proc: ServerProcHandle;
  url: string;
  password: string;
  cwd: string;
  configHash: string;
  /** Pool key this entry was registered under (logs + drain bookkeeping). */
  key: string;
  /** Shared always-warm pool member (multi-session, long idle, drains instead
   *  of dying on a config change). */
  shared?: boolean;
  /** Config changed while runs were active (shared servers only): removed
   *  from the pool, kept alive until its last run finishes, then killed. */
  draining?: boolean;
  /** Busy turns observed during boot adoption but not yet claimed by journal
   *  reattachment. Protects the survivor during the restart recovery gap. */
  recoveringSessionIds?: Set<string>;
  /** Reservations backed by a successful non-idle status probe. Conservative
   *  reservations stay only in recoveringSessionIds. */
  confirmedRecoverySessionIds?: Set<string>;
  /** When those reservations were taken — the ceiling on how long one may be
   *  held by a recovery probe that can never go false. */
  recoveryReservedAt?: number;
  /** Stable per-server run-rpc token for the in-process stdio proxies. */
  rpcToken: string;
  /** Stable per-server Meridian proxy API key (meridian-mode servers only) —
   *  reused across runs so the config hash (and thus the server) stays put. */
  meridianKey?: string;
  /** Loopback port the in-process Meridian proxy bound (we allocate it via
   *  CLAUDE_PROXY_PORT at spawn) — the usage/telemetry endpoint address. */
  meridianPort?: number;
  /** Claude account the Meridian proxy authenticates as (from spawn env). */
  accountId?: string;
  /** Local-profile first-run check completed against this server's proxy. */
  meridianReady?: boolean;
  /** Per-server SQLite shard this process writes (OPENCODE_DB at spawn) —
   *  absent on legacy/unsharded servers, which use opencode's default paths. */
  dbPath?: string;
  lastUsed: number;
  activeRuns: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const g = globalThis as any;
const servers: Map<string, OpencodeServerEntry> = (g.__opencodeServers ??= new Map());

// Shared servers whose config changed mid-flight: out of the pool (a fresh
// server owns the key) but alive until their last active run ends.
const drainingServers: Set<OpencodeServerEntry> = (g.__opencodeDraining ??= new Set());

// In-flight spawns per key: shared keys get CONCURRENT ensure calls from
// different sessions (per-session keys never did — one session, serial runs),
// and two racing spawns would leak the loser's process.
const spawningServers: Map<string, Promise<OpencodeServerEntry>> = (g.__opencodeSpawning ??=
  new Map());

// Active runs, keyed by run key + bks session id + opencode session id
// (busy checks, cancellation, shutdown drain).
const activeOpencodeRuns: Map<string, AbortController> = (g.__activeOpencodeRuns ??= new Map());

// Journaled runs still driven by this process (hot reload) are not
// "interrupted" — run-journal consults this on takeInterruptedRuns.
registerActiveRunProbe((runKey) => activeOpencodeRuns.has(runKey));

export function isOpencodeSessionBusy(id: string): boolean {
  return activeOpencodeRuns.has(id);
}

export function activeOpencodeRunCount(): number {
  // Distinct RUNS, not map keys — each run registers up to three alias keys
  // (runKey, bks session id, opencode session id) for one controller. Key
  // counting made the shutdown drain wait its full 60s on phantom
  // "undrainable" runs (live 2026-07-11: one detached run's extra aliases
  // outnumbered the detached-key set, so the subtraction never hit zero).
  return new Set(activeOpencodeRuns.values()).size;
}

export function cancelOpencodeRun(id: string): boolean {
  const ac = activeOpencodeRuns.get(id);
  if (ac) {
    ac.abort();
    return true;
  }
  return false;
}

// In-band mid-turn steer, registered per active run (same alias keys as
// activeOpencodeRuns). Mechanism: POST /session/{id}/message with
// noReply:true appends the user message to the engine session's history
// WITHOUT scheduling a reply turn, and the v1 session loop rebuilds its
// message list on every step — so the running turn picks the message up at
// its next LLM call, Claude-SDK-steer style (verified live 2026-07-12: a
// mid-turn noReply landed between assistant steps and the final reply
// incorporated it). This is what makes busy-sends deliverable without
// aborting the turn (the abort residue is the announce-then-stop trigger).
type OpencodeSteerFn = (text: string, images?: ImageInput[]) => void;
const activeOpencodeSteers: Map<string, OpencodeSteerFn> = (g.__activeOpencodeSteers ??=
  new Map());

/** In-band correction injected when an assistant text part arrives in
 * Meridian's tool-result envelope shape (TOOL_RESULT_ENVELOPE_RE): the model
 * just recited tool results it invented and is about to act on the fabricated
 * values. Delivered as a noReply steer so the running turn reads it at its
 * next step, before the fake values propagate into commands. Capped per turn
 * at the detection sites — a model that keeps re-emitting envelopes after two
 * corrections won't be argued out of it by a third. */
const ENVELOPE_LEAK_STEER_PROMPT =
  "Runner notice: your last message contains what looks like a tool-call " +
  "transcript — tool inputs, results, `[your <tool> …]:` blocks, or duration " +
  "chips written out as text. None of that was executed: you authored it, and " +
  "every value in it (ids, URLs, signatures, file contents, reports) is " +
  "fabricated. Real tool results only ever arrive as tool-result messages, " +
  "never as text you write. Discard the values you just wrote, re-read the " +
  "genuine tool outputs earlier in this conversation, actually invoke any tool " +
  "you only narrated, and continue from real outputs only.";

/** Fold a message into a live opencode run at its next step boundary.
 *  True = accepted for delivery (fire-and-forget POST; the caller keeps a
 *  steer receipt as the durable record until the transcript shows it). */
export function steerOpencodeRun(id: string, text: string, images?: ImageInput[]): boolean {
  const fn = activeOpencodeSteers.get(id);
  if (!fn) return false;
  fn(text, images);
  return true;
}

/** Minimal env for the opencode server process (mirrors codexEnv). Provider
 * auth is bound explicitly before spawn; OpenCode's native auth store is not
 * part of the local-profile contract. Open Session tokens never are.
 *
 * Public-repo containment note (2026-07-26): the gh-guard PATH shims that
 * used to front this env are gone — GitHub writes outside tellahq are now
 * blocked by credential scope instead (bot = fine-grained PAT with resource
 * owner tellahq; per-user = GitHub App user tokens limited to the tellahq
 * installation). Writes elsewhere fail at GitHub's side with 403 "Resource
 * not accessible", for every code path including raw API calls the shims
 * could never see. */
function opencodeEnv(author?: GitIdentity | null): Record<string, string> {
  const basePath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  return {
    PATH: basePath,
    HOME,
    LANG: process.env.LANG || "en_US.UTF-8",
    ...gitIdentityEnv(author),
  };
}

/** Stop every managed `opencode serve` process (verify scripts / tests, and
 *  the run-host's exit reap). Returns how many servers were told to die; await
 *  `awaitOpencodeServersDead` after when the caller is about to process.exit
 *  (the SIGKILL escalation is a timer that a fast exit would beat). */
export function killAllOpencodeServers(reason = "shutdown"): number {
  const entries = [...servers.entries()];
  const drained = [...drainingServers];
  const procs = [...entries.map(([, e]) => e.proc), ...drained.map((e) => e.proc)];
  for (const [key, entry] of entries) killServer(key, entry, reason);
  for (const entry of drained) {
    drainingServers.delete(entry);
    killServerProc(entry, reason);
  }
  pendingKilled.push(...procs);
  return entries.length + drained.length;
}

const pendingKilled: ServerProcHandle[] = [];

/** Wait (bounded) for servers killed via killAllOpencodeServers to actually
 *  exit — covers the SIGTERM-swallowing meridian plugin, whose SIGKILL
 *  escalation fires KILL_ESCALATION_MS after the kill. */
export async function awaitOpencodeServersDead(timeoutMs = KILL_ESCALATION_MS + 3_000): Promise<void> {
  const waits = pendingKilled.splice(0).map((p) => p.exited);
  if (!waits.length) return;
  await Promise.race([
    Promise.all(waits),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

/** Grace before SIGTERM escalates to SIGKILL: the meridian plugin installs
 *  SIGTERM/SIGINT handlers inside `opencode serve` that swallow the default
 *  terminate action (verified live 2026-07-08 — plain opencode exits on
 *  SIGTERM, a meridian-enabled one survives it), so every kill path escalates.
 *  Meridian itself is in-process and its Agent SDK children are per-request
 *  (none linger between turns — verified), so killing the server reaps the
 *  whole stack. */
const KILL_ESCALATION_MS = 5_000;

/** Kill an entry's process (SIGTERM → SIGKILL escalation) without touching
 *  the pool map — killServer/drain-reap wrap this with their own
 *  bookkeeping. */
function killServerProc(entry: OpencodeServerEntry, reason: string): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  const proc = entry.proc;
  try {
    proc.kill();
  } catch {}
  if (proc.detached && proc.unit) {
    // The scope's own TimeoutStopSec=5 (set at spawn) escalates the stop job
    // to SIGKILL — no timer needed here. Keep the registry in sync so the
    // next boot doesn't try to adopt a corpse.
    removeDetachedRecord(proc.unit);
  } else {
    const escalate = setTimeout(() => {
      if (proc.exitCode === null) {
        console.warn(
          `[opencode-runner] server for ${entry.key} ignored SIGTERM — escalating to SIGKILL`
        );
        try {
          proc.kill(true);
        } catch {}
      }
    }, KILL_ESCALATION_MS);
    (escalate as unknown as { unref?: () => void }).unref?.();
    void proc.exited.then(() => clearTimeout(escalate));
  }
  console.log(`[opencode-runner] server for ${entry.key} stopped (${reason})`);
}

function killServer(key: string, entry: OpencodeServerEntry, reason: string): void {
  servers.delete(key);
  killServerProc(entry, reason);
}

/** A shared server whose config changed while runs were active: hand the pool
 *  key to a fresh spawn, keep this one alive until its last run ends (the run
 *  finally + the proc-exit watcher both reap). Killing it outright would
 *  abort every OTHER session's in-flight turn — the exact blast radius the
 *  per-session pool never had. */
function drainServer(key: string, entry: OpencodeServerEntry, reason: string): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.draining = true;
  drainingServers.add(entry);
  servers.delete(key);
  console.log(
    `[opencode-runner] server for ${key} draining (${reason}; ${entry.activeRuns} active run(s))`
  );
}

/** Called from a run's finally once activeRuns is decremented. */
function recoveringRunCount(entry: OpencodeServerEntry): number {
  return entry.recoveringSessionIds?.size ?? 0;
}

function reapDrainedServer(entry: OpencodeServerEntry): void {
  if (!entry.draining || entry.activeRuns > 0 || recoveringRunCount(entry) > 0) return;
  drainingServers.delete(entry);
  killServerProc(entry, "drained (config changed)");
}

function idleKillMsFor(entry: OpencodeServerEntry): number {
  return entry.shared ? SHARED_IDLE_KILL_MS : IDLE_KILL_MS;
}

/** When the server last did real work: every turn writes its DB shard, so the
 *  shard's mtime is the honest last-activity signal (used by adoption and the
 *  idle sweep — `lastUsed` alone lies after restarts and lost timers). */
function dbLastActivityMs(dbPath?: string): number | null {
  if (!dbPath) return null;
  try {
    return statSync(dbPath).mtimeMs;
  } catch {
    return null;
  }
}

// Belt-and-braces idle sweep. Each entry's idle kill rides a setTimeout that
// can silently die (the bun --hot timer-poisoning failure killed every timer
// in the process while health stayed green), and before 2026-07-22 nothing
// re-checked survivors — the shared fleet grew to 46 servers / 25GB RSS and
// 14GB of swap. This scan is the backstop: kill anything past its idle TTL by
// the most generous signal available (pool bookkeeping or DB activity).
// Parked on globalThis so hot reloads don't stack intervals.
// Dev instances skip the sweep: it only touches this process's OWN pool map
// (benign), but a dev instance stays fully ticker-free by policy.
// Armed lazily, the first time this process actually owns a pool entry
// (ensureOpencodeIdleSweep below): a pool that was never filled has nothing to
// sweep, and arming at module scope made every script and test that merely
// imported this graph carry the ticker.
const IDLE_SWEEP_MS = 10 * 60 * 1000;
function ensureOpencodeIdleSweep(): void {
  if (g.__opencodeIdleSweep || isDevInstance()) return;
  g.__opencodeIdleSweep = setInterval(() => {
    for (const [key, entry] of servers) {
      if (entry.activeRuns > 0 || recoveringRunCount(entry) > 0 || entry.draining) continue;
      const lastActivity = Math.max(entry.lastUsed, dbLastActivityMs(entry.dbPath) ?? 0);
      if (Date.now() - lastActivity >= idleKillMsFor(entry)) {
        killServer(key, entry, "idle sweep");
      }
    }
    // Draining backstop: normally a run's finally reaps a drained server, but
    // an ADOPTED draining entry (boot kept a superseded server for its live
    // turns) has no run attached until a reattach claims it — if none ever
    // does, nothing else kills it. DB mtime is useless here (the shard is per
    // KEY and the successor keeps writing it), so reap on pool bookkeeping
    // alone: no active runs and past the base idle TTL since adoption/last
    // attach. Reattach happens seconds after boot, so a still-idle draining
    // entry at 30 minutes is dead weight.
    for (const entry of drainingServers) {
      if (entry.activeRuns > 0 || recoveringRunCount(entry) > 0) continue;
      if (Date.now() - entry.lastUsed >= IDLE_KILL_MS) {
        drainingServers.delete(entry);
        killServerProc(entry, "idle sweep (draining)");
      }
    }
  }, IDLE_SWEEP_MS);
  g.__opencodeIdleSweep.unref?.();
}

function scheduleIdleKill(key: string): void {
  const entry = servers.get(key);
  if (!entry) return;
  // Every path that puts a server in the pool lands here, so this is where the
  // backstop sweep gets armed — in the run host as well as in opensession,
  // and in neither if the pool stayed empty.
  ensureOpencodeIdleSweep();
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  const idleMs = idleKillMsFor(entry);
  entry.idleTimer = setTimeout(() => {
    const cur = servers.get(key);
    if (!cur || cur !== entry) return;
    if (
      cur.activeRuns > 0 ||
      recoveringRunCount(cur) > 0 ||
      Date.now() - cur.lastUsed < idleMs
    ) {
      scheduleIdleKill(key);
      return;
    }
    killServer(key, cur, "idle");
  }, idleMs + 1000);
}

async function spawnOpencodeServer(
  key: string,
  cwd: string,
  config: Record<string, unknown>,
  configHash: string,
  author?: GitIdentity | null,
  extraEnv?: Record<string, string>,
  shared?: boolean
): Promise<OpencodeServerEntry> {
  const bin = freshOpencodeBin();
  if (!existsSync(bin)) {
    throw new Error(
      `opencode binary not found at ${bin} — install it with \`npm i -g opencode-ai\` ` +
        "(or set OPENSESSION_OPENCODE_BIN)."
    );
  }
  if (shared) mkdirSync(cwd, { recursive: true });
  const password = crypto.randomUUID();

  // Detached spawn (opensession.ts main process only, see opencode-detach.ts):
  // the server lives in its own transient systemd user scope, OUTSIDE this
  // service's cgroup, so a `systemctl restart` leaves it — and every turn it
  // is executing — running. The registry record is what the next boot adopts
  // it back from. Any failure here falls through to the classic direct child.
  if (opencodeDetachActive()) {
    try {
      const det = await spawnDetachedOpencodeServer({
        bin,
        cwd,
        env: {
          ...opencodeEnv(author),
          ...(extraEnv || {}),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_SERVER_PASSWORD: password,
        },
        password,
        logDir: `${OPENCODE_STATE_DIR}/server-logs`,
        startTimeoutMs: SERVER_START_TIMEOUT_MS,
      });
      const entry: OpencodeServerEntry = {
        proc: det.handle,
        url: det.url,
        password,
        cwd,
        configHash,
        key,
        shared,
        rpcToken: crypto.randomUUID(),
        ...meridianEnvIdentity(extraEnv),
        dbPath: extraEnv?.OPENCODE_DB,
        lastUsed: Date.now(),
        activeRuns: 0,
      };
      servers.set(key, entry);
      scheduleIdleKill(key);
      syncDetachedRecord(entry);
      console.log(
        `[opencode-runner] ${shared ? "shared " : ""}server for ${key} listening on ${det.url} ` +
          `(detached scope ${det.unit}, cwd ${cwd})`
      );
      return entry;
    } catch (e) {
      console.warn(
        `[opencode-runner] detached spawn failed for ${key} — falling back to direct child:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  const proc = Bun.spawn({
    cmd: [bin, "serve", "--hostname=127.0.0.1", "--port=0"],
    cwd,
    env: {
      ...opencodeEnv(author),
      ...(extraEnv || {}),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill();
      } catch {}
      reject(new Error(`opencode serve didn't start within ${SERVER_START_TIMEOUT_MS / 1000}s: ${buf.slice(-500)}`));
    }, SERVER_START_TIMEOUT_MS);
    const scan = (chunk: string) => {
      if (settled) return;
      buf += chunk;
      const m = buf.match(/opencode server listening on\s+(https?:\/\/\S+)/);
      if (m) {
        settled = true;
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    // Keep draining both pipes for the server's lifetime — a full pipe would
    // block the process. Startup errors land in `buf` for the timeout message.
    const drain = (stream: ReadableStream<Uint8Array>) =>
      void (async () => {
        // Bun's ReadableStream is async-iterable at runtime; TS lib doesn't know.
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
          scan(new TextDecoder().decode(chunk));
        }
      })().catch(() => {});
    drain(proc.stdout);
    drain(proc.stderr);
    void proc.exited.then((code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`opencode serve exited with code ${code}: ${buf.slice(-500)}`));
    });
  });

  const entry: OpencodeServerEntry = {
    proc: bunProcHandle(proc),
    url,
    password,
    cwd,
    configHash,
    key,
    shared,
    rpcToken: crypto.randomUUID(),
    ...meridianEnvIdentity(extraEnv),
    dbPath: extraEnv?.OPENCODE_DB,
    lastUsed: Date.now(),
    activeRuns: 0,
  };
  servers.set(key, entry);
  scheduleIdleKill(key);
  console.log(
    `[opencode-runner] ${shared ? "shared " : ""}server for ${key} listening on ${url} (cwd ${cwd})`
  );
  return entry;
}

/** Peek the live pool entry for a server key (meridian-key reuse across
 *  ensure calls — the key must go into extraEnv BEFORE ensure computes the
 *  config hash). */
/** Release a run's hold on a pooled server: decrement, touch lastUsed, and
 *  reap it if it was draining (config changed mid-flight) — the same
 *  bookkeeping the full-run finally does, for callers outside runOpencode
 *  (the oneshot path). */
export function releaseOpencodeServer(entry: OpencodeServerEntry): void {
  entry.activeRuns = Math.max(0, entry.activeRuns - 1);
  entry.lastUsed = Date.now();
  reapDrainedServer(entry);
}

export function peekOpencodeServer(key: string): OpencodeServerEntry | undefined {
  return servers.get(key);
}

/** Content hash of our local plugin files, read once at module init. The
 *  server config only carries their PATHS, so without this an edited plugin
 *  never reaches a warm server: it neither hot-reloads (opencode loads
 *  plugins at boot) nor drains as a config change, and a busy shared server
 *  can carry stale plugin code for days. Folding the content into the config
 *  identity makes the first ensure after a restart drain/respawn through the
 *  normal "config changed" path. */
const LOCAL_PLUGIN_CONTENT_HASH = (() => {
  try {
    let acc = "";
    for (const p of [SESSION_TAG_PLUGIN_PATH, ARG_COERCE_PLUGIN_PATH]) {
      acc += Bun.hash(readFileSync(p, "utf8")).toString(16) + "\n";
    }
    return Bun.hash(acc).toString(16);
  } catch {
    return "unreadable";
  }
})();

export function opencodeServerConfigHash(
  config: Record<string, unknown>,
  cwd: string,
  extraEnv: Record<string, string> = {},
): string {
  const { CLAUDE_PROXY_PORT: _proxyPort, ...identityEnv } = extraEnv;
  const serializedConfig = JSON.stringify(config);
  const identityConfig = extraEnv.CLAUDE_PROXY_PORT
    ? serializedConfig.replaceAll(
        meridianProxyBaseUrl(extraEnv.CLAUDE_PROXY_PORT),
        "http://127.0.0.1:<meridian-port>",
      )
    : serializedConfig;
  return Bun.hash(
    identityConfig +
      "\n" +
      cwd +
      "\n" +
      JSON.stringify(identityEnv) +
      "\n" +
      LOCAL_PLUGIN_CONTENT_HASH,
  ).toString(16);
}

export function opencodeServerDisposition(input: {
  alive: boolean;
  sameConfig: boolean;
  sharedRequest: boolean;
  activeRuns: number;
  recoveringRuns?: number;
}): "reuse" | "drain" | "replace" {
  const recovering = (input.recoveringRuns ?? 0) > 0;
  // A shared server can safely accept a different session while its recovered
  // sessions finish. A per-session server cannot: its one session is already
  // occupied by the pre-restart turn.
  if (input.alive && input.sameConfig && (input.sharedRequest || !recovering)) {
    return "reuse";
  }
  if (input.alive && (recovering || (input.sharedRequest && input.activeRuns > 0))) {
    return "drain";
  }
  return "replace";
}

export async function ensureOpencodeServer(
  key: string,
  cwd: string,
  config: Record<string, unknown>,
  author?: GitIdentity | null,
  extraEnv?: Record<string, string>,
  opts?: { shared?: boolean }
): Promise<OpencodeServerEntry> {
  // Boot starts detached-server adoption before agents/webhooks accept work.
  // Do not race it: a fresh spawn for a key adoption has not reached yet would
  // leave the surviving server alive but untracked under the same key.
  if (detachedAdoptionPromise) await detachedAdoptionPromise.catch(() => {});
  // Per-server DB shard rides extraEnv so it participates in the identity:
  // flipping sharding on/off (or a key collision after a rename) respawns the
  // server rather than silently mixing DB files. Derived from the key, so it's
  // stable across respawns of the same server.
  if (opencodeDbShardActive()) {
    const dbPath = shardDbPathForKey(key);
    mkdirSync(SHARD_DB_DIR, { recursive: true });
    extraEnv = { ...(extraEnv || {}), OPENCODE_DB: dbPath };
  }
  // extraEnv is part of the identity: a different meridian account/token must
  // respawn the server (env only applies at spawn). CLAUDE_PROXY_PORT is the
  // one exception — it's freshly allocated on every call (meridianAccountEnv),
  // so hashing it would drain/respawn the server on every run. The direct
  // provider baseURL contains that same ephemeral port, so normalize it too;
  // a reused server keeps its originally-spawned config and meridianPort.
  const configHash = opencodeServerConfigHash(config, cwd, extraEnv);
  for (;;) {
    const existing = servers.get(key);
    if (existing) {
      const alive = existing.proc.exitCode === null && !existing.proc.killed;
      const recovering = recoveringRunCount(existing) > 0;
      const disposition = opencodeServerDisposition({
        alive,
        sameConfig: existing.configHash === configHash,
        sharedRequest: !!opts?.shared,
        activeRuns: existing.activeRuns,
        recoveringRuns: recoveringRunCount(existing),
      });
      if (disposition === "reuse") return existing;
      // Shared servers with runs in flight DRAIN on a config change (a kill
      // would abort every other session's turn). An adopted per-session server
      // with a recovery reservation drains too: its pre-restart turn is still
      // live, so neither reuse nor immediate replacement is safe yet.
      if (disposition === "drain") {
        drainServer(key, existing, recovering ? "restart recovery" : "config changed");
      } else {
        killServer(key, existing, alive ? "config changed" : "process died");
      }
    }
    // Shared keys get concurrent ensure calls from different sessions; only
    // one spawn may own the key. Losers await the winner and re-check (their
    // config may differ — the loop then drains/respawns as needed).
    const inflight = spawningServers.get(key);
    if (inflight) {
      await inflight.catch(() => {});
      continue;
    }
    const spawn = spawnOpencodeServer(key, cwd, config, configHash, author, extraEnv, opts?.shared);
    spawningServers.set(key, spawn);
    try {
      return await spawn;
    } finally {
      spawningServers.delete(key);
    }
  }
}

export function clientFor(entry: OpencodeServerEntry): OpencodeClient {
  return createOpencodeClient({
    baseUrl: entry.url,
    headers: { Authorization: `Basic ${btoa(`opencode:${entry.password}`)}` },
  });
}

export async function reconnectSharedInProcessMcp(
  client: Pick<OpencodeClient, "mcp">,
  names: string[],
  query: { query?: { directory?: string } } = {},
  opts: { timeoutMs?: number } = {}
): Promise<string[]> {
  if (!names.length) return [];

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const bounded = async <T>(request: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request(controller.signal),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(undefined);
          }, timeoutMs);
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const status = await bounded((signal) => client.mcp.status({ ...query, signal } as any));
  if (!status) return names;
  const current = (status.data || {}) as Record<string, { status?: string }>;
  const disconnected = names.filter((name) => current[name]?.status !== "connected");
  const results = await Promise.all(
    disconnected.map(async (name) => {
      const result = await bounded((signal) =>
        client.mcp.connect({ path: { name }, ...query, signal } as any)
      );
      return !result || result.error ? name : undefined;
    })
  );
  return results.filter((name): name is string => !!name);
}

// ── Meridian usage quota (accounts-layer data source) ────────────────────────
//
// Every live meridian-mode server carries an in-process Meridian proxy whose
// /v1/usage/quota endpoint serves the account's rate-limit picture from two
// sources: Anthropic's OAuth usage endpoint AND SDK-observed rate-limit events
// from live requests. The SDK half works even for setup-token accounts that
// 403 on the OAuth endpoint (usageScope "missing") — accounts the accounts
// layer is otherwise blind to. claude-accounts consumes this through the
// provider registered below (injection, not an import: this module imports
// claude-accounts, so the dependency can't point the other way).
function meridianQuotaEndpoints(): { accountId: string; url: string; key: string }[] {
  const out: { accountId: string; url: string; key: string; lastUsed: number }[] = [];
  for (const e of servers.values()) {
    if (!e.meridianKey || !e.meridianPort || !e.accountId) continue;
    if (e.proc.exitCode !== null || e.proc.killed) continue;
    out.push({
      accountId: e.accountId,
      url: `http://127.0.0.1:${e.meridianPort}`,
      key: e.meridianKey,
      lastUsed: e.lastUsed,
    });
  }
  // Most recently used first — freshest SDK-observed rate-limit data.
  return out.sort((a, b) => b.lastUsed - a.lastUsed);
}
registerMeridianQuotaProvider(meridianQuotaEndpoints);

/**
 * Why a context rebuild happened, straight from Meridian's own per-request
 * telemetry (`GET /telemetry/requests`, same auth as the quota endpoint).
 * `lineageType` is the bridge's verdict on the request we just observed:
 *  - "continuation" → Meridian resumed the right SDK session and the rewrite
 *    came from BELOW it: the Claude Agent SDK compacted its own session.
 *  - anything else ("new"/"diverged"/"undo") mid-conversation → Meridian threw
 *    the SDK session away and replayed the history into a fresh one.
 * Joined on the step's cache-creation count, which is unique enough to pin the
 * exact request on a shared server serving several sessions at once. Best
 * effort: telemetry is in-memory per proxy, so a respawn loses it.
 */
async function meridianLineageForStep(
  cacheCreationTokens: number,
): Promise<{ lineageType?: string; sdkSessionId?: string; messageCount?: number; toolCount?: number } | undefined> {
  const since = Date.now() - 120_000;
  for (const ep of meridianQuotaEndpoints().slice(0, 6)) {
    try {
      const res = await fetch(`${ep.url}/telemetry/requests?limit=25&since=${since}`, {
        headers: { "x-api-key": ep.key },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) continue;
      const rows = (await res.json()) as any[];
      const hit = Array.isArray(rows)
        ? rows.find((r) => Number(r?.cacheCreationInputTokens) === cacheCreationTokens)
        : undefined;
      if (hit)
        return {
          lineageType: hit.lineageType,
          sdkSessionId: hit.sdkSessionId,
          messageCount: hit.messageCount,
          toolCount: hit.toolCount,
        };
    } catch {
      // Best effort — a dead/slow proxy just means no verdict on this one.
    }
  }
  return undefined;
}

/**
 * Did the Claude CLI just fail to (re)connect Meridian's in-process "oc" MCP
 * server? At that moment the CLI strips every mcp__oc__* tool from the session
 * (cold prompt rewrite; the model then announces-and-stops or returns empty)
 * and leaves a one-line jsonl under ~/.cache/claude-cli-nodejs/<cwd-slug>/
 * mcp-logs-oc/. A hit inside the window turns a generic context_rebuild into a
 * diagnosed tool-drop (2026-08-03: bks-019fc72d/-72e/-75f all died on this;
 * root cause patched in patches/@rynfar%2Fmeridian, this is the tripwire in
 * case it resurfaces). Matches on the SDK session id when lineage produced
 * one; otherwise any fresh error in the window is attributed.
 */
function recentOcMcpDropError(sdkSessionId: string | undefined, windowMs = 180_000): string | undefined {
  const root = `${HOME}/.cache/claude-cli-nodejs`;
  let cwdSlugs: string[];
  try {
    cwdSlugs = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const slug of cwdSlugs) {
    const logDir = `${root}/${slug}/mcp-logs-oc`;
    let names: string[];
    try {
      names = readdirSync(logDir);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const path = `${logDir}/${name}`;
        if (Date.now() - statSync(path).mtimeMs > windowMs) continue;
        const lines = readFileSync(path, "utf-8").trim().split("\n");
        const entry = JSON.parse(lines[lines.length - 1] || "{}");
        if (sdkSessionId && entry.sessionId && entry.sessionId !== sdkSessionId) continue;
        if (typeof entry.error === "string" && entry.error) return entry.error;
      } catch {
        // Unreadable/partial log line — skip; this is best-effort diagnosis.
      }
    }
  }
  return undefined;
}

/**
 * Per-attempt watcher for silent context rebuilds under the engine (see
 * isContextRebuildStep). Fed every `message.updated`; fires at most once per
 * completed step, and never on an attempt's first step (no warm predecessor →
 * a cold cache is ordinary), which is also what keeps an account rotation's
 * fresh pump from tripping it.
 */
function makeContextRebuildWatcher(opts: {
  ocSessionId: string;
  model: string;
  turnEvent: (e: Record<string, unknown>) => void;
  onDetected: (notice: string) => void;
}) {
  const scored = new Set<string>();
  let previous: StepPromptUsage | undefined;
  return (info: any): void => {
    const tokens = info?.tokens;
    if (info?.role !== "assistant" || !tokens || scored.has(info.id)) return;
    const current: StepPromptUsage = {
      cacheReadTokens: tokens.cache?.read || 0,
      cacheCreationTokens: tokens.cache?.write || 0,
      contextTokens: (tokens.input || 0) + (tokens.cache?.read || 0) + (tokens.cache?.write || 0),
    };
    // Tokens land when the step completes; earlier updates are all-zero.
    if (current.contextTokens < 1_000) return;
    scored.add(info.id);
    const rebuilt = isContextRebuildStep(previous, current);
    const prior = previous;
    previous = current;
    if (!rebuilt || !prior) return;
    const notice = contextRebuildNotice(prior, current);
    console.warn(`[opencode-runner] ${opts.ocSessionId}: ${notice}`);
    opts.onDetected(notice);
    // The verdict costs a loopback round-trip, so it rides after the notice.
    void meridianLineageForStep(current.cacheCreationTokens).then((lineage) => {
      // Third rebuild cause besides compaction and replay: the CLI lost the
      // "oc" SDK MCP server and stripped every tool (also lineage
      // "continuation" — lineage alone can't tell the shapes apart).
      const mcpDropError = recentOcMcpDropError(lineage?.sdkSessionId);
      if (mcpDropError)
        opts.onDetected(
          "The rebuild coincides with the engine losing its tool bridge " +
            `(${mcpDropError}) — the model was left without tools for the rest of the turn.`,
        );
      opts.turnEvent({
        direction: "out",
        kind: "context_rebuild",
        model: opts.model,
        prev_context_tokens: prior.contextTokens,
        context_tokens: current.contextTokens,
        cache_creation_tokens: current.cacheCreationTokens,
        // "continuation" = the Agent SDK compacted below Meridian; anything
        // else = Meridian replayed into a fresh SDK session.
        lineage_type: lineage?.lineageType,
        sdk_session_id: lineage?.sdkSessionId,
        engine_message_count: lineage?.messageCount,
        tool_count: lineage?.toolCount,
        ...(mcpDropError ? { mcp_drop_error: mcpDropError.slice(0, 300) } : {}),
      });
    });
  };
}

// ── Detached servers: registry sync + boot adoption ──────────────────────────

/** Mirror a detached entry's live identity into the adoption registry. Called
 *  at spawn AND after the run body reassigns rpcToken/meridianKey (per-session
 *  servers bake the run-minted rpc token into their config — the registry must
 *  carry the one the proxies actually authenticate with). */
function syncDetachedRecord(entry: OpencodeServerEntry): void {
  const proc = entry.proc;
  if (!proc.detached || !proc.unit) return;
  const prev = readDetachedRegistry().find((r) => r.unit === proc.unit);
  upsertDetachedRecord({
    key: entry.key,
    unit: proc.unit,
    pid: proc.pid || prev?.pid || 0,
    url: entry.url,
    password: entry.password,
    cwd: entry.cwd,
    configHash: entry.configHash,
    shared: entry.shared,
    rpcToken: entry.rpcToken,
    meridianKey: entry.meridianKey,
    meridianPort: entry.meridianPort,
    accountId: entry.accountId,
    dbPath: entry.dbPath,
    spawnedAt: prev?.spawnedAt || new Date().toISOString(),
  });
}

export interface DetachedRecordProbe {
  healthy: boolean;
  busySessionIds: string[];
  /** Journaled sessions whose status request did not answer. Adoption policy
   *  must not read these as confirmed idle. */
  uncertainSessionIds: string[];
}

type DetachedTurnStatusProbe = (
  rec: DetachedServerRecord,
  run: ActiveRunRecord,
) => Promise<"busy" | "idle">;

const probeDetachedTurnStatus: DetachedTurnStatusProbe = async (rec, run) => {
  const client = clientFor({ url: rec.url, password: rec.password } as OpencodeServerEntry);
  const st = await client.session.status({
    query: { directory: run.cwd },
    signal: AbortSignal.timeout(3_000),
  });
  if (st.error) throw new Error(JSON.stringify(st.error));
  const statuses = st.data as Record<string, { type?: string }> | undefined;
  const mine = statuses?.[run.claudeSessionId!];
  return mine && mine.type !== "idle" ? "busy" : "idle";
};

/** Classify journaled turns pinned to one detached record. The injectable
 *  probe is an adoption-policy test seam; production uses the authenticated
 *  directory-scoped status endpoint above. */
export async function __probeDetachedRecordForTest(
  rec: DetachedServerRecord,
  runs: ActiveRunRecord[],
  probe: DetachedTurnStatusProbe = probeDetachedTurnStatus,
): Promise<Omit<DetachedRecordProbe, "healthy">> {
  const busy: string[] = [];
  const uncertain: string[] = [];
  for (const run of runs.filter(
    (r) => r.serverKey === rec.key && r.claudeSessionId && r.cwd,
  )) {
    try {
      if ((await probe(rec, run)) === "busy") busy.push(run.claudeSessionId!);
    } catch {
      // A timeout is not an idle answer. Preserve the journal's ownership so
      // boot adoption can hand the decision to the longer reattach probe.
      uncertain.push(run.claudeSessionId!);
    }
  }
  return { busySessionIds: busy, uncertainSessionIds: uncertain };
}

async function probeDetachedRecords(
  records: DetachedServerRecord[],
): Promise<Map<string, DetachedRecordProbe>> {
  const queue = [...records];
  const results = new Map<string, DetachedRecordProbe>();
  const runs = activeRunRecords();
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    for (;;) {
      const record = queue.shift();
      if (!record) return;
      const [healthy, turnProbe] = await Promise.all([
        opencodeServerHealthy(record.url, record.password),
        __probeDetachedRecordForTest(record, runs),
      ]);
      results.set(record.unit, { healthy, ...turnProbe });
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Whether some restart recovery still intends to claim this engine session's
 * live turn — queued behind the bounded boot queue, promoted out of it, or
 * mid-probe. Registered by agent-runner at module scope, the same shape as
 * run-journal's `registerActiveRunProbe`, because the recovery lifecycle
 * lives there and the import may only run agent-runner → opencode-runner.
 *
 * No probe registered means nothing is pending. Adoption only runs when
 * `opencodeDetachActive()`, i.e. in the boot path, which imports agent-runner
 * before the first expiry tick can fire; a process with no probe is a test or
 * a script that never scheduled a recovery at all.
 */
const pendingRecoveryProbes: Set<(ocSessionId: string) => boolean> =
  (g.__pendingRecoveryProbes ??= new Set());

export function registerPendingRecoveryProbe(
  probe: (ocSessionId: string) => boolean,
): () => void {
  pendingRecoveryProbes.add(probe);
  return () => pendingRecoveryProbes.delete(probe);
}

function recoveryStillClaimable(ocSessionId: string): boolean {
  for (const probe of pendingRecoveryProbes) {
    try {
      if (probe(ocSessionId)) return true;
    } catch {}
  }
  return false;
}

/** How often an unclaimed reservation is re-examined. */
export let DETACHED_RECOVERY_GRACE_MS = 5 * 60_000;
/**
 * Hard ceiling on how long one reservation may be held, however loudly a
 * probe insists its recovery is still coming. This exists only for a probe
 * that can never go false (a hot reload stranding a worker's globals), so it
 * must sit comfortably ABOVE the longest legitimate wait: a recovery may sit
 * queued for `BOOT_RECOVERY_QUEUE_WAIT_MS` (agent-runner, 10 min) before it
 * is promoted and only then runs its reattach probe. The 2026-08-16 incident
 * was exactly this relationship inverted — a 5-minute release against a
 * 10-minute queue wait. Keep it at >= 3x the queue wait; the test asserts it.
 */
export let DETACHED_RECOVERY_MAX_MS = 30 * 60_000;

/** Test seam: the reservation lifecycle is only reachable from a boot that
 *  adopted a live detached server, so both windows have to be shortenable to
 *  observe it. Returns the previous values. */
export function __setDetachedRecoveryTimingForTest(t: {
  graceMs: number;
  maxMs: number;
}): { graceMs: number; maxMs: number } {
  const prev = { graceMs: DETACHED_RECOVERY_GRACE_MS, maxMs: DETACHED_RECOVERY_MAX_MS };
  DETACHED_RECOVERY_GRACE_MS = t.graceMs;
  DETACHED_RECOVERY_MAX_MS = t.maxMs;
  return prev;
}

/** Test seam: stand in for the adoption sweep — track a draining survivor,
 *  reserve its live turns, and arm the expiry exactly as boot does. Returns a
 *  cleanup that drops the entry from the draining set. */
export function __reserveDetachedRecoveryForTest(
  entry: OpencodeServerEntry,
  ocSessionIds: string[],
): () => void {
  if (entry.draining) drainingServers.add(entry);
  else servers.set(entry.key, entry);
  reserveDetachedRecovery(entry, ocSessionIds);
  scheduleDetachedRecoveryExpiry();
  return () => {
    drainingServers.delete(entry);
    if (servers.get(entry.key) === entry) servers.delete(entry.key);
    entry.recoveringSessionIds = undefined;
    entry.confirmedRecoverySessionIds = undefined;
    entry.recoveryReservedAt = undefined;
  };
}

/** Claim one boot-adoption reservation without reaping the server under the
 *  reattach that is about to increment activeRuns. Teardown performs the
 *  draining reap after finalization. */
function claimDetachedRecovery(entry: OpencodeServerEntry, ocSessionId: string): void {
  if (!entry.recoveringSessionIds?.delete(ocSessionId)) return;
  entry.confirmedRecoverySessionIds?.delete(ocSessionId);
  if (!entry.recoveringSessionIds.size) entry.recoveryReservedAt = undefined;
}

export function __claimDetachedRecoveryForTest(
  entry: OpencodeServerEntry,
  ocSessionId: string,
): void {
  claimDetachedRecovery(entry, ocSessionId);
}

function reserveDetachedRecovery(
  entry: OpencodeServerEntry,
  recoverySessionIds: string[],
  confirmedSessionIds: string[] = recoverySessionIds,
): void {
  if (!recoverySessionIds.length) return;
  entry.recoveringSessionIds = new Set(recoverySessionIds);
  entry.confirmedRecoverySessionIds = new Set(confirmedSessionIds);
  entry.recoveryReservedAt = Date.now();
}

/** Every live entry still holding a reservation. Derived from the two pool
 *  collections rather than a set of its own: both are parked on globalThis,
 *  so a hot reload keeps them, where a private set would go empty while the
 *  reservations it was supposed to be expiring lived on. */
function reservedRecoveryEntries(): OpencodeServerEntry[] {
  const out: OpencodeServerEntry[] = [];
  for (const entry of servers.values()) if (entry.recoveringSessionIds?.size) out.push(entry);
  for (const entry of drainingServers) if (entry.recoveringSessionIds?.size) out.push(entry);
  return out;
}

/** Nothing will claim this engine session's turn on this server key — the
 *  reattach declined it, or the recovery was abandoned outright. Drop the
 *  reservation at the decision point instead of leaving it to the tick. */
function releaseRecoveryReservation(serverKey: string | undefined, ocSessionId: string): void {
  if (!serverKey) return;
  for (const entry of detachedTurnCandidates(serverKey)) {
    if (!entry.recoveringSessionIds?.delete(ocSessionId)) continue;
    entry.confirmedRecoverySessionIds?.delete(ocSessionId);
    if (!entry.recoveringSessionIds.size) {
      entry.recoveryReservedAt = undefined;
      reapDrainedServer(entry);
    }
  }
}

/**
 * Release the reservations no restart recovery still intends to claim.
 *
 * This used to run once, five minutes after adoption, and released EVERY
 * unclaimed reservation — reaping a draining survivor that was still
 * executing its turn. Five minutes is shorter than the recovery queue's own
 * wait (`BOOT_RECOVERY_QUEUE_WAIT_MS`, 10 min), so a recovery that had done
 * nothing worse than queue behind four others lost its engine before it was
 * even promoted to start (2026-08-16). The clock never knew anything the
 * recovery state does not say better, so ask that instead.
 */
function expireDetachedRecoveryReservations(): void {
  const now = Date.now();
  for (const entry of reservedRecoveryEntries()) {
    const reserved = entry.recoveringSessionIds!;
    // The ceiling only fires for a probe that can never go false; a recovery
    // that is merely slow keeps its engine for as long as it needs one.
    const heldMs = now - (entry.recoveryReservedAt ?? now);
    const expired = heldMs >= DETACHED_RECOVERY_MAX_MS;
    let released = 0;
    for (const ocSessionId of reserved) {
      if (!expired && recoveryStillClaimable(ocSessionId)) continue;
      reserved.delete(ocSessionId);
      entry.confirmedRecoverySessionIds?.delete(ocSessionId);
      released++;
    }
    if (released) {
      console.warn(
        `[opencode-runner] released ${released} unclaimed recovery reservation(s) for ${entry.key}` +
          (expired
            ? ` — held ${Math.round(heldMs / 60_000)} min for a recovery that never claimed them`
            : ""),
      );
    }
    if (!reserved.size) {
      entry.recoveryReservedAt = undefined;
      reapDrainedServer(entry);
    }
  }
}

/** Re-examine reservations every grace period for as long as any survives.
 *  Idempotent, and armed only from the boot adoption sweep (never at module
 *  scope), so importing this module stays free of tickers. */
function scheduleDetachedRecoveryExpiry(): void {
  if (g.__detachedRecoveryExpiryTimer || !reservedRecoveryEntries().length) return;
  const timer = setTimeout(() => {
    g.__detachedRecoveryExpiryTimer = undefined;
    try {
      expireDetachedRecoveryReservations();
    } catch (e) {
      console.error("[opencode-runner] recovery reservation sweep failed:", e);
    }
    scheduleDetachedRecoveryExpiry();
  }, DETACHED_RECOVERY_GRACE_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  g.__detachedRecoveryExpiryTimer = timer;
}

/** Adopted instances that could still be hosting a journaled run's engine
 *  session: the pool entry for its serverKey plus same-key draining ones (a
 *  drain-respawn can leave the live turn on a superseded instance). The same
 *  set tryReattachOpencodeRun scans, without its probe. */
function detachedTurnCandidates(serverKey: string): OpencodeServerEntry[] {
  const candidates: OpencodeServerEntry[] = [];
  const pooled = servers.get(serverKey);
  if (pooled && pooled.proc.detached && pooled.proc.exitCode === null) candidates.push(pooled);
  for (const d of drainingServers) {
    if (d.key === serverKey && d.proc.detached && d.proc.exitCode === null) candidates.push(d);
  }
  return candidates;
}

/** What restoreJournaledRunRpcContext registered, per run key, so the release
 *  is exactly-once and only ever drops its own registrations. */
interface JournaledRpcContext {
  tokens: string[];
  ocSessionId?: string;
  ocCtx?: OcSessionContext;
}
const journaledRpcContexts: Map<string, JournaledRpcContext> = (g.__journaledRpcContexts ??=
  new Map());

/**
 * Re-register an interrupted run's in-process MCP auth from the journal, at
 * boot, BEFORE its recovery is scheduled.
 *
 * The run token and the opencode-session → opensession-session mapping live
 * only in this process (run-rpc.ts), so a restart drops them, and until
 * 2026-08-16 the only code that put them back was the reattach generator body
 * — which runs when the bounded recovery queue reaches the run. Meanwhile the
 * run's DETACHED `opencode serve` is still executing its turn and still
 * calling the opensession-* tools: every one of those calls was answered
 * "unauthorized (unknown run token)" or "unauthorized (unresolved opencode
 * session)" for as long as the run sat in the queue, and forever if its
 * recovery was abandoned. Registering from the journal closes that window;
 * the pool is populated by adoptDetachedOpencodeServers, which boot awaits
 * before resuming.
 *
 * Authorization is unchanged: this registers exactly what the reattach
 * registers, and run-rpc still builds every call's tools through the
 * per-session interactive builder (automation-owned sessions stay
 * fail-closed there).
 */
export function restoreJournaledRunRpcContext(run: ActiveRunRecord): boolean {
  const sessionId = run.osSessionId;
  if (!sessionId || !run.serverKey || journaledRpcContexts.has(run.runKey)) return false;
  const candidates = detachedTurnCandidates(run.serverKey);
  if (!candidates.length) return false;
  const held: JournaledRpcContext = { tokens: [] };
  for (const entry of candidates) {
    if (!entry.rpcToken) continue;
    registerRunToken(entry.rpcToken, { sessionId, user: run.user });
    held.tokens.push(entry.rpcToken);
  }
  // Session-tagged calls (shared servers only) need the per-session mapping
  // too, or they resolve to whichever run registered the token last and are
  // refused outright. Adoption already probed which instance reports this
  // engine session busy — prefer it when it differs from the pool entry.
  const ocSessionId = run.claudeSessionId;
  const hosting =
    candidates.find(
      (e) => e.shared && e.confirmedRecoverySessionIds?.has(ocSessionId || ""),
    ) ??
    candidates.find((e) => e.shared && e.recoveringSessionIds?.has(ocSessionId || "")) ??
    candidates.find((e) => e.shared);
  if (ocSessionId && hosting?.rpcToken) {
    const ocCtx: OcSessionContext = { sessionId, user: run.user, token: hosting.rpcToken };
    registerOcSessionContext(ocSessionId, ocCtx);
    held.ocSessionId = ocSessionId;
    held.ocCtx = ocCtx;
  }
  if (!held.tokens.length && !held.ocCtx) return false;
  journaledRpcContexts.set(run.runKey, held);
  return true;
}

/** Drop what restoreJournaledRunRpcContext registered for a run whose
 *  recovery has ended (settled, abandoned, or finished). Idempotent; the
 *  token registry is refcounted and the mapping release is identity-scoped,
 *  so a reattach's own register/unregister pair nests inside this safely. */
export function releaseJournaledRunRpcContext(run: ActiveRunRecord): void {
  const held = journaledRpcContexts.get(run.runKey);
  if (!held) return;
  journaledRpcContexts.delete(run.runKey);
  for (const token of held.tokens) unregisterRunToken(token);
  if (held.ocCtx) releaseOcSessionContext(held.ocSessionId, held.ocCtx);
}

/**
 * Abort the engine turn of a journaled run whose restart recovery is being
 * abandoned before it ever reattached (Stop while the recovery is still
 * queued; a quarantined journal record).
 *
 * A detached `opencode serve` runs outside this process's cgroup and keeps
 * executing its turn whatever opensession decides — and with no reattach
 * there is no in-process AbortController for it either, so cancelOpencodeRun
 * cannot reach it. Telling the session "send the prompt again" while that
 * turn is still running is what put two engines in one worktree on
 * 2026-08-16. Best effort by nature: an instance we cannot reach cannot be
 * told anything.
 */
export async function abortDetachedOpencodeTurn(
  run: ActiveRunRecord,
  signal?: AbortSignal,
): Promise<boolean> {
  const ocSessionId = run.claudeSessionId;
  if (!ocSessionId || !run.serverKey) return false;
  // An engine session id outlives the turn that created it: the session's
  // next prompt resumes the same one. So never abort a session some live
  // in-process run owns: it either attached after all, or the person has
  // re-prompted and this would kill their new turn. That owner has its own
  // cancellation path (cancelOpencodeRun).
  if (activeOpencodeRuns.has(ocSessionId)) return false;
  const attempts = detachedTurnCandidates(run.serverKey).map(async (entry) => {
    const q = entry.shared ? { query: { directory: run.cwd } } : {};
    const candidateSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
      : AbortSignal.timeout(5_000);
    while (!candidateSignal.aborted) {
      try {
        const client = clientFor(entry);
        const sess = await client.session.get({
          path: { id: ocSessionId },
          ...q,
          signal: candidateSignal,
        });
        if (sess.error) throw new Error(JSON.stringify(sess.error));
        if (!sess.data) return false;
        // Ownership can change while the lookup is in flight. Recovery remains
        // gated on this operation, so this final check closes that window.
        if (candidateSignal.aborted || activeOpencodeRuns.has(ocSessionId)) return false;
        const result = await client.session.abort({
          path: { id: ocSessionId },
          ...q,
          signal: candidateSignal,
        });
        if (result.error) throw new Error(JSON.stringify(result.error));
        return true;
      } catch {
        if (candidateSignal.aborted) return false;
        await Bun.sleep(100);
      }
    }
    return false;
  });
  const aborted = (await Promise.all(attempts)).some(Boolean);
  // Abandoned either way: an instance we could not reach cannot be told
  // anything, and no recovery is coming back for this turn. Hand the
  // survivor's reservation back now rather than making the sweep infer it.
  releaseRecoveryReservation(run.serverKey, ocSessionId);
  if (aborted) {
    appendOpencodeTranscript(ocSessionId, [
      transcriptLineRunnerNotice(
        "Restart recovery was abandoned for this turn, so the engine turn that " +
          "survived the restart was stopped. Nothing is still running in the background.",
      ),
    ]);
    audit({
      msg: "claude_turn_event",
      provider: PROVIDER,
      run_key: run.runKey,
      session_id: run.osSessionId,
      run_kind: `${run.kind || "run"}-abandon`,
      claude_session_id: ocSessionId,
      direction: "in",
      kind: "abandoned_turn_aborted",
    });
  }
  return aborted;
}

/**
 * Re-adopt detached `opencode serve` scopes that survived the last restart
 * into the live pool, so (a) journaled runs can REATTACH to their still-
 * running turns (tryReattachOpencodeRun) and (b) idle survivors are reused
 * instead of leaked. Dead or unhealthy records are pruned (scope stopped,
 * registry entry removed). Called from opensession.ts's boot block BEFORE
 * resumeInterruptedRuns; must never throw.
 */
let detachedAdoptionPromise: Promise<number> | undefined;

export function adoptDetachedOpencodeServers(): Promise<number> {
  if (!opencodeDetachActive()) return Promise.resolve(0);
  detachedAdoptionPromise ??= adoptDetachedOpencodeServersInner().catch((e) => {
    console.error("[opencode-runner] detached-server adoption failed:", e);
    return 0;
  }).finally(() => {
    // The grace period starts after the full adoption sweep, not while
    // early entries are still waiting for restart recovery to begin.
    scheduleDetachedRecoveryExpiry();
  });
  return detachedAdoptionPromise;
}

async function adoptDetachedOpencodeServersInner(): Promise<number> {
  const records = readDetachedRegistry();
  if (!records.length) return 0;
  const probes = await probeDetachedRecords(records);
  return applyDetachedAdoption(records, probes, {
    procHandle: adoptedProcHandle,
    stopUnit: stopDetachedUnit,
    removeRecord: removeDetachedRecord,
    scheduleIdle: scheduleIdleKill,
    finish: () => {
      reapOrphanedDetachedScopes();
      ensureScopeReapTicker();
    },
  }).adopted;
}

interface DetachedAdoptionOps {
  procHandle: (unit: string, pid: number) => ServerProcHandle;
  stopUnit: (unit: string) => void;
  removeRecord: (unit: string) => void;
  scheduleIdle: (key: string) => void;
  finish: () => void;
}

interface DetachedAdoptionResult {
  adopted: number;
  managed: OpencodeServerEntry[];
}

function applyDetachedAdoption(
  records: DetachedServerRecord[],
  probes: Map<string, DetachedRecordProbe>,
  ops: DetachedAdoptionOps,
): DetachedAdoptionResult {
  const byKey = new Map<string, typeof records>();
  for (const r of records) {
    const list = byKey.get(r.key);
    if (list) list.push(r);
    else byKey.set(r.key, [r]);
  }
  let adopted = 0;
  const managed: OpencodeServerEntry[] = [];
  for (const [key, recs] of byKey) {
    // Newest per key wins the pool slot; older duplicates are config-change
    // drains the restart cut short. They can STILL be executing live turns —
    // killing one mid-turn is exactly the blast radius draining exists to
    // avoid (bks-019facef, 2026-07-29: the boot stopped a superseded shared
    // server one second before reattaching the run that was mid-write on it;
    // the turn died with "Claude Code process exited unexpectedly (code
    // 143)"). Probe each older duplicate against the run journal: if any
    // journaled run's engine session is busy THERE, adopt it as DRAINING so
    // tryReattachOpencodeRun can find the turn; the run's finally (or the
    // idle-sweep backstop) reaps it once the last turn ends. Idle or
    // unreachable duplicates are stopped as before.
    recs.sort((a, b) => (a.spawnedAt < b.spawnedAt ? 1 : -1));
    const [newest, ...older] = recs;
    for (const r of older) {
      // Hot reload: this process may still hold the superseded server as a
      // live draining entry (or even the pool entry) — don't double-track or
      // stop a unit that's already being managed.
      const tracked =
        [...drainingServers].some((e) => e.proc.unit === r.unit) ||
        [...servers.values()].some((e) => e.proc.unit === r.unit);
      if (tracked) continue;
      const probe = probes.get(r.unit);
      const busySessionIds = probe?.busySessionIds ?? [];
      const uncertainSessionIds = probe?.uncertainSessionIds ?? [];
      const recoverySessionIds = [...new Set([...busySessionIds, ...uncertainSessionIds])];
      if (recoverySessionIds.length > 0) {
        const entry: OpencodeServerEntry = {
          proc: ops.procHandle(r.unit, r.pid),
          url: r.url,
          password: r.password,
          cwd: r.cwd,
          configHash: r.configHash,
          key,
          shared: r.shared,
          draining: true,
          rpcToken: r.rpcToken,
          meridianKey: r.meridianKey,
          meridianPort: r.meridianPort,
          accountId: r.accountId,
          dbPath: r.dbPath,
          lastUsed: Date.now(),
          activeRuns: 0,
        };
        reserveDetachedRecovery(entry, recoverySessionIds, busySessionIds);
        drainingServers.add(entry);
        managed.push(entry);
        // Registry record stays: a further restart re-probes it, and the
        // eventual killServerProc removes it.
        console.log(
          `[opencode-runner] kept superseded detached server ${r.unit} (${key}): ` +
            `${busySessionIds.length} live, ${uncertainSessionIds.length} uncertain turn(s), draining`
        );
        continue;
      }
      ops.stopUnit(r.unit);
      ops.removeRecord(r.unit);
      console.log(`[opencode-runner] stopped superseded detached server ${r.unit} (${key})`);
    }
    if (servers.has(key)) continue; // hot reload — the pool entry never died
    const probe = probes.get(newest.unit);
    const healthy = probe?.healthy ?? false;
    const busySessionIds = probe?.busySessionIds ?? [];
    const uncertainSessionIds = probe?.uncertainSessionIds ?? [];
    const recoverySessionIds = [...new Set([...busySessionIds, ...uncertainSessionIds])];
    if (!healthy && !recoverySessionIds.length) {
      ops.stopUnit(newest.unit);
      ops.removeRecord(newest.unit);
      continue;
    }
    const entry: OpencodeServerEntry = {
      proc: ops.procHandle(newest.unit, newest.pid),
      url: newest.url,
      password: newest.password,
      cwd: newest.cwd,
      configHash: newest.configHash,
      key,
      shared: newest.shared,
      // A status timeout is not an idle answer even when the cheap health
      // endpoint happened to answer. Keep it out of the reusable pool until
      // restart recovery's session-specific probe adjudicates the journal.
      draining: !healthy || uncertainSessionIds.length > 0,
      rpcToken: newest.rpcToken,
      meridianKey: newest.meridianKey,
      meridianPort: newest.meridianPort,
      accountId: newest.accountId,
      dbPath: newest.dbPath,
      // Real last-activity, not adoption time: every turn writes the server's
      // DB shard, so its mtime is when the server last did work. Stamping
      // Date.now() here granted every survivor a fresh idle lease per restart —
      // with frequent restarts the shared fleet never aged out and grew to
      // 46 servers / 25GB RSS (2026-07-22). Fresh-DB fallback: now.
      lastUsed: dbLastActivityMs(newest.dbPath) ?? Date.now(),
      activeRuns: 0,
    };
    reserveDetachedRecovery(entry, recoverySessionIds, busySessionIds);
    managed.push(entry);
    if (!entry.draining) {
      servers.set(key, entry);
      ops.scheduleIdle(key);
      adopted++;
      console.log(
        `[opencode-runner] adopted detached server for ${key} (${newest.unit}, ${newest.url})`
      );
    } else {
      drainingServers.add(entry);
      console.warn(
        `[opencode-runner] kept detached server ${newest.unit} (${key}): ` +
          `${busySessionIds.length} live, ${uncertainSessionIds.length} uncertain turn(s), draining`,
      );
    }
  }
  ops.finish();
  return { adopted, managed };
}

/** Exercise the real adoption policy without touching systemd or the detached
 *  registry. Unit names and pool keys should be unique to the test. */
export function __adoptDetachedRecordsForTest(
  records: DetachedServerRecord[],
  probes: Map<string, DetachedRecordProbe>,
): {
  adopted: number;
  stopped: string[];
  removed: string[];
  managed: OpencodeServerEntry[];
  cleanup: () => void;
} {
  const stopped: string[] = [];
  const removed: string[] = [];
  const result = applyDetachedAdoption(records, probes, {
    procHandle: (unit, pid) => ({
      unit,
      pid,
      detached: true,
      exitCode: null,
      killed: false,
      exited: new Promise<number>(() => {}),
      kill: () => stopped.push(unit),
    }),
    stopUnit: (unit) => stopped.push(unit),
    removeRecord: (unit) => removed.push(unit),
    scheduleIdle: () => {},
    finish: () => {},
  });
  return {
    ...result,
    stopped,
    removed,
    cleanup: () => {
      for (const entry of result.managed) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        drainingServers.delete(entry);
        if (servers.get(entry.key) === entry) servers.delete(entry.key);
      }
    },
  };
}

/**
 * Stop alive `opensession-oc-*` scopes the registry doesn't know — they can
 * never be adopted or reached again (dominant leak: process death between
 * systemd-run and the registry write). Runs after boot adoption AND hourly
 * (ticker below): a leak can mint at any time, and an unreaped scope also
 * pins its worktree against the disk-cleanup cron ("live process" skip).
 */
function reapOrphanedDetachedScopes(): number {
  if (!opencodeDetachActive()) return 0;
  try {
    const known = new Set(readDetachedRegistry().map((r) => r.unit));
    const reaped = reapUnregisteredScopes(known);
    if (reaped > 0) {
      console.log(`[opencode-runner] reaped ${reaped} unregistered detached scope(s)`);
      audit({ msg: "opencode_scope_reap", reaped });
    }
    return reaped;
  } catch (e) {
    console.error("[opencode-runner] scope reap failed:", e);
    return 0;
  }
}

function ensureScopeReapTicker(): void {
  if (g.__ocScopeReapTicker) return;
  const t = setInterval(() => reapOrphanedDetachedScopes(), 60 * 60_000);
  (t as { unref?: () => void }).unref?.();
  g.__ocScopeReapTicker = t;
}

// Runs currently executing on a DETACHED server — these survive a restart
// (the shutdown drain skips them; boot reattaches via the journal).
const detachedRunKeys: Set<string> = (g.__opencodeDetachedRuns ??= new Set());

export function activeDetachedOpencodeRunCount(): number {
  // Same distinct-controller counting as activeOpencodeRunCount, so the
  // shutdown drain's subtraction compares like with like.
  const controllers = new Set<AbortController>();
  for (const key of detachedRunKeys) {
    const ac = activeOpencodeRuns.get(key);
    if (ac) controllers.add(ac);
  }
  return controllers.size;
}

// ── The run ──────────────────────────────────────────────────────────────────

function imageParts(images: ImageInput[] | undefined): Array<Record<string, unknown>> {
  return (images || []).map((im, i) => ({
    type: "file",
    mime: im.mediaType,
    filename: `image-${i + 1}`,
    url: `data:${im.mediaType};base64,${im.data}`,
  }));
}

/** Set by an attempt that hit a Claude usage limit on its meridian bridge
 *  account when another eligible account exists: the wrapper below reruns the
 *  turn once (the new account's env changes the server config hash, so a
 *  fresh opencode server binds to it). Mirrors claude-runner's
 *  rotate-after-limit. */
interface AccountRotation {
  rotate: boolean;
  note: string;
}

/** Per-turn transcript state carried ACROSS rotation attempts (the rotation
 *  box above is recreated per attempt). Tracks which engine session's file got
 *  this turn's user line — a rotation retry can either resume the same session
 *  (line already there; skip) or start a FRESH one when the turn had no
 *  session to resume (first turn of a session), where skipping left the user
 *  message out of the new file entirely (bks-019f52bd: bubble stuck on
 *  "Sending…", user turn missing after reload). Same contract as the remote
 *  mirror's promptWrittenTo (sandbox/adapters/bootstrap.ts). `notes` queues
 *  rotation notices for the next attempt to persist as system lines. */
interface TurnTranscriptState {
  promptWrittenTo: string;
  notes: string[];
  /** Distinct bridge-account wedge retries already spent this turn. Wedge
   * sidelining makes each retry shrink the usable pool, so walking a small
   * bounded number of accounts is safe and avoids requiring a manual
   * "continue" when the first replacement account is wedged too. */
  wedgeRetries: number;
  /** A successful engine stop with no final text is not a usable completion.
   * Keep its one-shot repair state across the runner's attempt loop so the
   * continuation cannot spin forever or get reset by an account rotation. */
  emptyCompletionRepairs: number;
  repairPrompt?: string;
  /** The turn's user transcript line, built ONCE (stable uuid) — the early
   *  intake persist and the per-engine-session write below both use it, so
   *  the store upserts one row instead of minting duplicate user bubbles
   *  (also dedupes across rotation retries that start a fresh session). */
  userLine?: Record<string, unknown>;
}

/** Runaway backstop only — NOT the real limit. Walk EVERY account before giving
 *  up: each usage-limit rotation marks the capped account
 *  exhausted (markExhausted) and pickMeridianAccount only returns a not-yet-
 *  exhausted account, so the pool strictly shrinks and the loop terminates on
 *  its own when the pool is dry (rotation stays false → terminal error ⇒
 *  agent-runner's model-fallback graph). This ceiling just stops a pathological
 *  bug (an account that never sticks as exhausted) from spinning forever; set
 *  well above any realistic personal-subs + shared-pool count. */
const MAX_ACCOUNT_ATTEMPTS = 64;
export const EMPTY_COMPLETION_RESULT = "Done! (no text output)";
const MAX_WEDGE_ACCOUNT_RETRIES = 2;

export function shouldRepairEmptyCompletion(
  text: string | undefined | null,
  repairs: number,
): boolean {
  return !text?.trim() && repairs < 1;
}

export function emptyCompletionRepairPrompt(originalPrompt?: string | null): string {
  const original = (originalPrompt || "").trim();
  const clamped = original.length > 2_000 ? `${original.slice(0, 2_000)}…` : original;
  return (
    "Your previous response stopped successfully but contained no final text. " +
    "Review the work and tool results already in this session, continue from the current state, " +
    "and finish the user's task now. Keep using tools until the task is complete or genuinely " +
    "blocked, then provide a concise final answer. Do not merely announce the next step." +
    (clamped
      ? `\n\nThe prompt that started this turn was:\n"""\n${clamped}\n"""`
      : "")
  );
}

export type OpencodeTurnFailure =
  | { kind: "usage_limit"; message: string }
  | { kind: "liveness_wedge"; message: string }
  | { kind: "provider_overloaded"; message: string }
  | { kind: "other"; message: string };

type BridgeAccountState =
  | { kind: "meridian"; account: ClaudeAccount; livenessGuard: true }
  | { kind: "openai"; account: CodexAccount; livenessGuard: boolean };

export function openaiBridgeAccountState(
  account: CodexAccount,
  mechanism: OpenaiAuthMechanism,
): Extract<BridgeAccountState, { kind: "openai" }> {
  return {
    kind: "openai",
    account,
    livenessGuard: mechanism !== "api-key",
  };
}

export function classifyOpencodeTurnFailure(
  providerID: string,
  message: string,
  kind?: Exclude<OpencodeTurnFailure["kind"], "other">,
): OpencodeTurnFailure {
  if (kind) return { kind, message };
  const usageLimit =
    providerID === "anthropic"
      ? isClaudeUsageLimitError(message, true)
      : isCodexUsageLimitError(message);
  return usageLimit ? { kind: "usage_limit", message } : { kind: "other", message };
}

export function shouldRetryTransientRun(input: {
  failure: OpencodeTurnFailure;
  hasAlternativeAccount: boolean;
  attemptIndex: number;
  wedgeRetries: number;
}): boolean {
  // A provider-declared overload is not fixed by restarting this OpenCode
  // server or repeating the same model request. Let agent-runner try its next
  // fallback model immediately instead of spending another 90-second window.
  if (
    input.failure.kind === "usage_limit" ||
    input.failure.kind === "provider_overloaded"
  ) {
    return false;
  }
  if (input.failure.kind !== "liveness_wedge") return input.attemptIndex === 0;
  // With an alternative account, markWedged/markCodexWedged has removed the
  // failed one from subsequent picks, so allow two bounded pool-walk retries.
  // With a dry pool, retain the old single same-account respawn retry.
  return input.hasAlternativeAccount
    ? input.wedgeRetries < MAX_WEDGE_ACCOUNT_RETRIES
    : input.attemptIndex === 0;
}

/**
 * The Dial's oracle subagents, STATIC per server: shared servers host many
 * sessions with different presets, so the agent SET can't vary per run — and
 * keeping it identical keeps config hashes (and thus server reuse) stable.
 * They're invisible in practice to non-dial runs: only dial runs get the
 * instructions block that tells the model they exist.
 * Read-only by construction (advisors, not executors).
 *
 * The MODELS are resolved against the server's bridge (`mainProviderID`): a
 * server carries ONE bridge's auth, so a cross-provider oracle body can't run
 * there — each agent NAME keeps existing (prompts and the task tool list stay
 * stable) but is backed by the same-bridge substitute's config. Without this,
 * any task call naming a cross-bridge oracle dies on "Model not found"
 * (2026-07-18: bks-ghpr-4997-review's Fable→Sol fallback server advertised
 * oracle-opus, whose anthropic/claude-opus-4-8 the openai bridge can't
 * serve). Per-server the bridge is fixed, so hashes stay stable.
 */
function dialOracleAgentConfigs(mainProviderID: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(DIAL_ORACLE_AGENTS)) {
    const o = DIAL_ORACLE_AGENTS[sameBridgeDialOracle(name, mainProviderID)];
    out[name] = {
      mode: "subagent",
      description: o.description,
      model: o.model,
      // Rides AgentConfig's open index signature — honored where the engine
      // supports per-agent variants, harmlessly ignored otherwise.
      variant: o.variant,
      tools: { write: false, edit: false, patch: false },
      permission: { edit: "deny" },
    };
  }
  return out;
}

/**
 * The Orchestrator's worker subagents — same static-per-server contract as the
 * oracles above (stable agent set ⇒ stable config hash), same per-bridge model
 * resolution (a server carries ONE bridge's auth), invisible in practice to
 * non-orchestrator runs. Unlike the oracles they carry NO tools/permission
 * overrides: workers are executors and must INHERIT the run's write policy
 * (code mode edits, ask mode's config-level edit-deny stays) — an explicit
 * allow here would punch a write hole through ask mode.
 */
function orchestratorWorkerAgentConfigs(
  mainProviderID: string
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, w] of Object.entries(ORCHESTRATOR_WORKER_AGENTS)) {
    const b = orchestratorWorkerForBridge(name, mainProviderID);
    if (!b) continue;
    out[name] = {
      mode: "subagent",
      description: w.description,
      model: b.model,
      // Rides AgentConfig's open index signature, like the oracles' variant.
      variant: b.variant,
    };
  }
  return out;
}

/**
 * Subagent stall guard. A task-tool subagent whose provider request hangs with
 * zero output blocks the parent turn until the wall-clock deadline: the 90s
 * liveness guard only watches for the turn's FIRST output, and a wedged
 * Meridian proxy keeps the parent's ESTABLISHED stream flowing while NEW
 * requests through it hang forever (2026-07-26/27: @oracle-fable reviews stuck
 * at 0 tokens held three sessions 90+ min each). Child sessions run in the
 * same directory instance, so their events arrive on the run's subscription —
 * the guard tracks the session family (parent + task children, transitively)
 * and fires when a task tool has been open with the WHOLE family silent for
 * SUBAGENT_STALL_MS. Family-wide silence is the tell: a healthy subagent
 * streams its own parts, which keep resetting the clock, so long oracle
 * reviews don't false-positive. Kill switch / tuning:
 * OPENSESSION_SUBAGENT_STALL_MS (0 disables; floor 2 min).
 */
const SUBAGENT_STALL_MS = (() => {
  const raw = process.env.OPENSESSION_SUBAGENT_STALL_MS;
  if (raw === "0") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(120_000, n) : 600_000;
})();

/**
 * Provider-retry stall guard. A turn whose provider requests keep failing makes
 * zero progress, but opencode retries internally with a backoff that grows to
 * ~35 minutes — so the run just sits there looking busy. Nothing else catches
 * it: the 90s liveness guard only watches for the turn's FIRST output, and the
 * subagent guard above needs an open task tool. Left alone it burns to the
 * wall-clock deadline and reports "Stopped after 3 hours", which reads as "your
 * work took too long" when in fact the last 2-3 hours were dead air (every
 * turn-timeout in the audit log between 2026-07-31 and 08-03 had this shape:
 * 12-13 consecutive retries, no output at all after the first few minutes).
 *
 * Firing needs BOTH a streak of retries with no output between them and enough
 * elapsed time, because ordinary turns are legitimately quiet for a while — a
 * 15-minute Bash call emits nothing either. Any real output resets the streak,
 * so a retry that recovers never accumulates. The stall routes into the wedge
 * lane: sideline the account, drain-respawn the server, retry once.
 *
 * The verdict is evaluated on every retry event AND on a 30s timer
 * (maybeFailProviderStall): opencode's backoff grows past the stall window, so
 * event-driven checking alone can sit one-retry-short of the threshold forever
 * (2026-08-03 bks-019fc819: 3rd retry at 13.5 min, 4th still pending when the
 * human cancelled at 25 min). A streak made entirely of Meridian upstream-idle
 * kills ("Upstream stalled: no data for …") fires at half the window and one
 * fewer retry — each of those already measured 90s+ of dead air on a fresh
 * request into the same wedged daemon.
 * Tuning / kill switch: OPENSESSION_PROVIDER_STALL_MS (0 disables; floor 5 min).
 */
const PROVIDER_STALL_MS = (() => {
  const raw = process.env.OPENSESSION_PROVIDER_STALL_MS;
  if (raw === "0") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(300_000, n) : 900_000;
})();
const PROVIDER_STALL_MIN_RETRIES = 3;

/**
 * Open-tool stall guard (rides the same silence clock). A plain tool call can
 * hang forever with no task child and no provider retries — os-019fd67b
 * (2026-08-06) sat 2h52m on a bash call that launched a detached Chrome:
 * opencode's own bash timeout killed the shell, but its output read waits for
 * pipe EOF and the detached child inherits the pipe, so the call never
 * resolved and nothing watched for it until the wall-clock deadline. Any open
 * NON-task tool part with the whole family silent for TOOL_STALL_MS ends the
 * turn cleanly (turn-abort lane — the account and server are healthy, so no
 * sideline/respawn). The threshold sits above opencode's 10-min bash timeout
 * ceiling: a healthy bash call cannot legitimately be older than that, and
 * streamed output resets the clock anyway. The clock pauses while a
 * permission ask waits on a human (that wait is not a hang).
 * Kill switch / tuning: OPENSESSION_TOOL_STALL_MS (0 disables; floor 5 min).
 */
const TOOL_STALL_MS = (() => {
  const raw = process.env.OPENSESSION_TOOL_STALL_MS;
  if (raw === "0") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(300_000, n) : 1_200_000;
})();

/**
 * Request-silence lane (rides the same family clock). A turn with NO open
 * tool, NO task child and no permission ask pending is by definition inside a
 * provider request — between one step's finish and the next, the model must
 * be streaming — so total silence that long means the request died without
 * ever surfacing an error. The other lanes can't see this shape: the tool and
 * task lanes need something open, and the provider-retry lane needs retry
 * events — but opencode's backoff grows past an hour, and a service restart
 * resets the runner-side streak, so a wedged turn can sit one-retry-short
 * forever (2026-08-07 os-019fdcbe: session limit hit mid-turn at 15:21,
 * retries 68 min apart, three restarts each reset the streak — the turn sat
 * "busy" for 2h19m until a human interrupted). Healthy generation always
 * streams parts (text and reasoning deltas both reset the clock), so the only
 * legitimately quiet state this long is a human-held permission ask, which
 * pauses the clock. Kill switch / tuning: OPENSESSION_REQUEST_STALL_MS
 * (0 disables; floor 5 min).
 */
const REQUEST_STALL_MS = (() => {
  const raw = process.env.OPENSESSION_REQUEST_STALL_MS;
  if (raw === "0") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(300_000, n) : 1_200_000;
})();

export type StallInfo = {
  kind: "task" | "tool" | "request";
  quietMs: number;
  openTaskIds: string[];
  /** Open non-task tool calls, e.g. `bash: setsid -f google-chrome …`. */
  openToolLabels: string[];
};

export function makeSubagentStallGuard(
  ocSessionId: string,
  onStall: (info: StallInfo) => void
) {
  const childSessions = new Set<string>();
  const openTasks = new Map<string, number>();
  const openTools = new Map<string, string>();
  let pendingAsks = 0;
  let lastFamilyEventAt = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    /** Restore task-family state from OpenCode's SQLite store after restart.
     *  The silence clock seeds from persisted activity even with no open
     *  tasks: a reattached turn that was already quiet for 40 minutes must
     *  not get a fresh clock, or every restart re-arms the wedge
     *  (2026-08-07 os-019fdcbe). */
    seed(
      tasks: Array<{ id: string; childSessionId?: string }>,
      persistedLastActivityAt: number | null
    ) {
      for (const task of tasks) {
        openTasks.set(task.id, persistedLastActivityAt ?? Date.now());
        if (task.childSessionId) childSessions.add(task.childSessionId);
      }
      if (persistedLastActivityAt !== null) {
        lastFamilyEventAt = persistedLastActivityAt;
      }
    },
    /** Call on every SSE event, before any per-handler session filtering. */
    noteEvent(ev: any) {
      const p = ev?.properties;
      if (ev?.type === "session.updated" || ev?.type === "session.created") {
        const info = p?.info;
        if (
          info?.id &&
          info.parentID &&
          (info.parentID === ocSessionId || childSessions.has(info.parentID))
        ) {
          childSessions.add(info.id);
        }
        // Session bookkeeping is not progress — fall through to the type
        // filter below (the envelope carries a top-level sessionID, so
        // without this these events would keep resetting the clock).
      }
      // Only genuine content flow counts as family activity. Housekeeping
      // events (session.updated/status ticks, permission traffic) and retry
      // parts must NOT reset the silence clock: a child whose provider
      // request is stuck in opencode's silent retry backoff emits exactly
      // those the whole time it hangs — 2026-08-03 bks-019fc798 sat 25 min
      // on a wedged @oracle-fable with the guard armed but never firing.
      if (
        ev?.type !== "message.part.updated" &&
        ev?.type !== "message.part.delta" &&
        ev?.type !== "message.updated"
      ) {
        return;
      }
      if (p?.part?.type === "retry") return;
      const sid = p?.part?.sessionID ?? p?.info?.sessionID ?? p?.sessionID;
      if (sid && (sid === ocSessionId || childSessions.has(sid))) {
        lastFamilyEventAt = Date.now();
      }
    },
    /** Parent or any (transitive) task-child session id. */
    isFamily(sid: unknown): boolean {
      return sid === ocSessionId || (typeof sid === "string" && childSessions.has(sid));
    },
    /** Ms since the last family CONTENT event (test/debug accessor). */
    quietFor(now = Date.now()): number {
      return now - lastFamilyEventAt;
    },
    /** Call for every parent tool part update (tracks open tool calls). */
    noteTool(part: any) {
      if (!part?.id) return;
      const status = part?.state?.status;
      const open = status === "pending" || status === "running";
      if (part?.tool === "task") {
        if (open) {
          if (!openTasks.has(part.id)) openTasks.set(part.id, Date.now());
        } else if (status === "completed" || status === "error") {
          openTasks.delete(part.id);
        }
        return;
      }
      if (open) {
        // Label = tool name + input excerpt, best-effort: enough for the
        // cutoff message to name what hung without dumping the whole input.
        const input = part?.state?.input;
        const excerpt = String(input?.command ?? input?.description ?? input?.filePath ?? "")
          .replace(/\s+/g, " ")
          .slice(0, 120);
        openTools.set(part.id, `${part?.tool || "tool"}${excerpt ? `: ${excerpt}` : ""}`);
      } else if (status === "completed" || status === "error") {
        openTools.delete(part.id);
      }
    },
    /** A permission ask awaiting a decision pauses the stall clock — a tool
     *  sitting open on a human's answer is patience, not a hang. On the last
     *  resolution the clock restarts from now so the wait never counts. */
    noteAskPending(delta: 1 | -1) {
      pendingAsks = Math.max(0, pendingAsks + delta);
      if (pendingAsks === 0) lastFamilyEventAt = Date.now();
    },
    /** The interval body, extracted for tests: the stall verdict at `now`. */
    evaluate(now = Date.now()): StallInfo | null {
      if (pendingAsks > 0) return null;
      const quietMs = now - lastFamilyEventAt;
      if (SUBAGENT_STALL_MS && openTasks.size && quietMs >= SUBAGENT_STALL_MS) {
        return {
          kind: "task",
          quietMs,
          openTaskIds: [...openTasks.keys()],
          openToolLabels: [],
        };
      }
      if (TOOL_STALL_MS && openTools.size && quietMs >= TOOL_STALL_MS) {
        return {
          kind: "tool",
          quietMs,
          openTaskIds: [],
          openToolLabels: [...openTools.values()],
        };
      }
      if (
        REQUEST_STALL_MS &&
        !openTasks.size &&
        !openTools.size &&
        quietMs >= REQUEST_STALL_MS
      ) {
        return { kind: "request", quietMs, openTaskIds: [], openToolLabels: [] };
      }
      return null;
    },
    start() {
      if ((!SUBAGENT_STALL_MS && !TOOL_STALL_MS && !REQUEST_STALL_MS) || timer) return;
      timer = setInterval(() => {
        const verdict = this.evaluate();
        if (!verdict) return;
        this.stop();
        onStall(verdict);
      }, 30_000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/**
 * Shared end-of-run registry teardown for the finally blocks of
 * runOpencodeAttempt and tryReattachOpencodeRun: releases the abort/steer
 * registrations, the detached-run marker, the shared-server ocSession
 * mapping, the run-rpc token, and the server entry's active-run hold.
 * Journal clearing stays at the call sites — the two paths gate it
 * differently (rotation retries keep the record).
 */
function teardownOpencodeRunRegistries(ctx: {
  registeredKeys: Set<string>;
  runKey: string;
  /** Non-empty = the oc session id registered in run-rpc's ocSession registry. */
  ocSessionRegistered: string;
  rpcTokenRegistered: boolean;
  entry: OpencodeServerEntry | undefined;
}): void {
  for (const key of ctx.registeredKeys) {
    activeOpencodeRuns.delete(key);
    activeOpencodeSteers.delete(key);
  }
  detachedRunKeys.delete(ctx.runKey);
  if (ctx.ocSessionRegistered) unregisterOcSessionContext(ctx.ocSessionRegistered);
  if (ctx.rpcTokenRegistered && ctx.entry) unregisterRunToken(ctx.entry.rpcToken);
  if (ctx.entry) {
    ctx.entry.activeRuns = Math.max(0, ctx.entry.activeRuns - 1);
    ctx.entry.lastUsed = Date.now();
    // Shared server whose config changed mid-flight: the last run out
    // turns off the lights.
    reapDrainedServer(ctx.entry);
  }
}

/**
 * Permission-ask bridge shared by both drain paths (see the block comment at
 * the primary call site in runOpencodeAttempt for the full policy rationale).
 * One bridge per run: dedupes ask ids across the SSE pump and the busy-poll
 * sweep, and serializes surfaced asks so a session shows one card at a time.
 * Returns the handlePermissionAsk entrypoint. noteAskPending is an accessor
 * (not the stall guard itself) because the reattach path constructs its stall
 * guard after this bridge — asks only ever arrive via events, never
 * synchronously, so the late binding is safe there.
 */
function makeOpencodePermissionBridge(ctx: {
  client: OpencodeClient;
  entry: OpencodeServerEntry;
  ocSessionId: string;
  q: { query?: { directory: string } };
  unattended: boolean;
  /** Command-policy gate for bash asks (bashGated / recomputed from the journaled kind). */
  gated: boolean;
  sessionId: string | undefined;
  runKind: string | undefined;
  onAskUser: RunAgentOpts["onAskUser"];
  turnEvent: (fields: Record<string, unknown>) => void;
  noteAskPending: (delta: 1 | -1) => void;
}): (ask: any, via: string) => void {
  const { client, entry, ocSessionId, q } = ctx;
  const repliedPermissionIds = new Set<string>();
  let permissionAskChain: Promise<void> = Promise.resolve();
  const replyPermissionAsk = async (permId: string, reply: "once" | "always" | "reject") => {
    // Legacy reply endpoint first (exists on every server version we run,
    // 1.17.15 included); fall back to the flat 1.17+ reply route in case a
    // future server drops the legacy path.
    const res = await client
      .postSessionIdPermissionsPermissionId({
        path: { id: ocSessionId, permissionID: permId },
        body: { response: reply },
        ...q,
      })
      .catch((e) => ({ error: e }));
    if ((res as { error?: unknown })?.error) {
      await fetch(`${entry.url}/permission/${encodeURIComponent(permId)}/reply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Basic ${btoa(`opencode:${entry.password}`)}`,
        },
        body: JSON.stringify({ reply }),
      }).catch((e) =>
        console.warn(`[opencode-runner] failed to answer permission ask ${permId}:`, e)
      );
    }
  };
  const decidePermissionAsk = async (ask: any): Promise<"once" | "always" | "reject"> => {
    const kind = String(ask?.permission ?? ask?.action ?? "unknown");
    // Bash asks go to the command policy first (command-policy.ts): a deny
    // match rejects in every mode; on gated runs an allowed command answers
    // its own ask. Null ⇒ not bash / interactive ⇒ the flow below decides.
    const policyReply = bashAskPolicyReply(ask, {
      unattended: ctx.unattended,
      gated: ctx.gated,
      sessionId: ctx.sessionId,
      runKind: ctx.runKind,
    });
    if (policyReply) return policyReply;
    if (ctx.unattended) return "reject";
    if (kind === "external_directory") return "once";
    if (!ctx.onAskUser) return "reject";
    // Surface on the session's question card and wait for the human.
    const what = ((ask?.patterns ?? ask?.resources ?? []) as unknown[])
      .map(String)
      .join(", ");
    const meta = ask?.metadata ? JSON.stringify(ask.metadata).slice(0, 300) : "";
    const answer = await ctx.onAskUser({
      questions: [
        {
          question:
            `The agent needs permission: **${kind}**` +
            (what ? ` on \`${what}\`` : "") +
            (meta && meta !== "{}" ? ` (${meta})` : "") +
            ". Allow it?",
          header: "Permission",
          options: [
            { label: "Allow", description: "Allow this call once" },
            { label: "Allow always", description: "Remember for matching future calls" },
            { label: "Reject", description: "Deny — the agent sees a permission error" },
          ],
          multiSelect: false,
        },
      ],
    });
    if (answer.behavior === "deny") return "reject"; // nobody answered
    const picked = String(
      Object.values(
        (answer.updatedInput as { answers?: Record<string, string> }).answers || {}
      )[0] || ""
    ).toLowerCase();
    if (picked.startsWith("allow always")) return "always";
    if (picked.startsWith("allow") || picked.startsWith("yes")) return "once";
    return "reject";
  };
  return (ask: any, via: string) => {
    const permId = String(ask?.id || "");
    if (!permId || repliedPermissionIds.has(permId)) return;
    repliedPermissionIds.add(permId);
    const kind = String(ask?.permission ?? ask?.action ?? "unknown");
    permissionAskChain = permissionAskChain.then(async () => {
      // Pause the stall clock: a tool part sits open while its ask waits on
      // a human, which can legitimately take longer than any stall window.
      ctx.noteAskPending(1);
      try {
        let reply: "once" | "always" | "reject" = "reject";
        try {
          reply = await decidePermissionAsk(ask);
        } catch (e) {
          console.warn(`[opencode-runner] permission ask ${permId} decision failed:`, e);
        }
        console.warn(
          `[opencode-runner] permission ask ${permId} (${kind}) on ${ocSessionId} via ${via} → ${reply}`
        );
        ctx.turnEvent({
          direction: "out",
          kind: "permission_decision",
          tool_name: kind,
          decision: reply === "reject" ? "deny" : "allow",
          reason: ctx.unattended
            ? "unattended_auto_reject"
            : kind === "external_directory"
              ? "interactive_auto_approve"
              : ctx.onAskUser
                ? "human_decision"
                : "no_ask_handler",
        });
        await replyPermissionAsk(permId, reply);
      } finally {
        ctx.noteAskPending(-1);
      }
    });
  };
}

/**
 * Per-run mirror for message.part.updated text/tool parts — the shared core
 * of both handleEvent ladders: transcript append + turn-event audit +
 * StreamEvent push, with dedup sets so re-delivered SSE parts (reconnects,
 * reattach backfill seeds) never double-append. The primary pump keeps its
 * extra cases (retry parts, reasoning parts) around these calls. The dedup
 * sets are caller-owned so the reattach path can seed them from the
 * transcript file and the final-message tail can keep using them.
 */
function makePartMirror(ctx: {
  ocSessionId: string;
  model: string;
  turnEvent: (fields: Record<string, unknown>) => void;
  push: (ev: StreamEvent) => void;
  steerFn: OpencodeSteerFn;
  emittedText: Set<string>;
  compactionMsgs: Set<string>;
  /**
   * Messages the engine has announced as role "assistant" (message.updated).
   * A delta names neither its part's type nor its message's role, so this is
   * what keeps a person's own prompt out of the reply. Caller-owned, like
   * compactionMsgs, because the ladder that sees message.updated owns it.
   */
  assistantMsgs: Set<string>;
  startedTools: Set<string>;
  finishedTools: Set<string>;
}): {
  mirrorTextPart: (part: any) => void;
  mirrorTextDelta: (props: any) => void;
  mirrorToolPart: (part: any) => void;
  textStream: TextPartStream;
} {
  const {
    ocSessionId,
    model,
    turnEvent,
    push,
    steerFn,
    emittedText,
    compactionMsgs,
    assistantMsgs,
    startedTools,
    finishedTools,
  } = ctx;
  let envelopeLeakSteers = 0;
  // Emits only what the stream has not carried yet for a part, so the deltas
  // plus the completion tail concatenate to exactly the finished text.
  const textStream = new TextPartStream();
  // Holds each part's deltas to the next boundary where the markdown written
  // so far renders as itself (see safeFlushLength).
  const blockFlusher = new BlockFlusher();
  /**
   * partID -> messageID, for every text part this run has seen announced.
   * Populated by mirrorTextPart from the creation snapshot, which the engine
   * publishes empty before any delta for that part arrives.
   */
  const textPartMsg = new Map<string, string>();
  const pushTextTail = (part: any) => {
    const tail = textStream.tail(part.id, part.text);
    if (tail) push({ type: "text_chunk", text: tail, blockId: part.id });
  };
  /**
   * The engine's token stream. `message.part.delta` carries the new characters
   * of one field of one part, and is the only place partial text exists:
   * `message.part.updated` publishes a text part exactly twice, empty at
   * creation and complete at the end, so mirroring snapshots can never type
   * anything out.
   *
   * The field name is NOT a sufficient filter, which is what sank the first
   * attempt at this (d9603d54): a reasoning part's body is also called `text`,
   * and so is a person's own prompt. So a delta is forwarded only for a part
   * that arrived here as a text part, on a message the engine called the
   * assistant's. Both lookups fail closed, the same way opencode's own client
   * does, and a dropped delta costs nothing: the completion snapshot then
   * delivers that part whole, which is what shipped before this existed.
   */
  const mirrorTextDelta = (props: any) => {
    if (!streamPartialTextEnabled()) return;
    if (props?.field !== "text") return;
    const id = props?.partID;
    if (typeof id !== "string" || emittedText.has(id)) return;
    const messageID = textPartMsg.get(id);
    if (!messageID || !assistantMsgs.has(messageID)) return;
    // Compaction summaries are bookkeeping, not the reply.
    if (compactionMsgs.has(messageID)) return;
    const delta = typeof props?.delta === "string" ? props.delta : "";
    const piece = textStream.advance(id, blockFlusher.push(id, delta));
    if (piece) push({ type: "text_chunk", text: piece, blockId: id });
  };
  const mirrorTextPart = (part: any) => {
    if (part.type !== "text" || part.synthetic) return;
    // Register from the creation snapshot, which is empty: this is what makes
    // the part's deltas eligible above.
    if (typeof part.id === "string" && typeof part.messageID === "string") {
      textPartMsg.set(part.id, part.messageID);
    }
    if (part.time?.end && !emittedText.has(part.id)) {
      emittedText.add(part.id);
      if (compactionMsgs.has(part.messageID)) {
        turnEvent({ direction: "out", kind: "compaction_summary", ...summarizeText(part.text) });
        appendOpencodeTranscript(ocSessionId, [
          transcriptLineCompactionSummary(part.text, part.id),
        ]);
      } else {
        turnEvent({ direction: "out", kind: "assistant_text", ...summarizeText(part.text) });
        appendOpencodeTranscript(ocSessionId, [
          transcriptLineAssistantText(part.text, part.id, undefined, model),
        ]);
        // The whole part when nothing streamed, otherwise just the tail —
        // including whatever the flusher was still holding back.
        blockFlusher.clear(part.id);
        pushTextTail(part);
        textStream.done(part.id);
        // Assistant text shaped like a tool transcript = the model
        // narrating tool calls/results it invented (see
        // looksLikeFabricatedToolTranscript). Correct it in-band before
        // the fabricated values reach a command.
        if (looksLikeFabricatedToolTranscript(part.text) && envelopeLeakSteers < 2) {
          envelopeLeakSteers++;
          turnEvent({
            direction: "out",
            kind: "envelope_leak_detected",
            ...summarizeText(part.text, 300),
          });
          steerFn(ENVELOPE_LEAK_STEER_PROMPT);
        }
      }
    }
  };
  const mirrorToolPart = (part: any) => {
    if (part.type !== "tool") return;
    const state = part.state;
    if ((state?.status === "running" || state?.status === "completed" || state?.status === "error") && !startedTools.has(part.id)) {
      startedTools.add(part.id);
      turnEvent({
        direction: "out",
        kind: "tool_use",
        tool_name: part.tool,
        tool_use_id: part.id,
        ...summarizeText(JSON.stringify(state?.input ?? {}), 500),
      });
      appendOpencodeTranscript(ocSessionId, [
        transcriptLineToolUse(part.id, part.tool || "tool", state?.input),
      ]);
      push({ type: "tool_use", toolName: part.tool, toolInput: state?.input, toolUseId: part.id });
    }
    if ((state?.status === "completed" || state?.status === "error") && !finishedTools.has(part.id)) {
      finishedTools.add(part.id);
      const result = state.status === "completed" ? state.output || "" : `Error: ${state.error}`;
      const images = opencodeToolResultImages(part);
      // The persisted line is re-parsed by jsonl-parser, which runs the same
      // derivation. Do it for the live event off the FULL output (`result`,
      // not the 500-char wire copy) or a marked screenshot would only appear —
      // and only open its row — after a reload.
      const liveMedia = toolResultMedia(result, images);
      turnEvent({
        direction: "in",
        kind: "tool_result",
        tool_use_id: part.id,
        is_error: state.status === "error",
        ...summarizeText(result),
      });
      appendOpencodeTranscript(ocSessionId, [
        transcriptLineToolResult(
          part.id,
          result,
          state.status === "error",
          undefined,
          images,
        ),
      ]);
      push({
        type: "tool_result",
        toolUseId: part.id,
        content: result.length > 500 ? result.slice(0, 500) + "..." : result,
        ...liveMedia,
      });
    }
  };
  return { mirrorTextPart, mirrorTextDelta, mirrorToolPart, textStream };
}

/**
 * SSE event pump with reconnect (Bun's fetch aborts responses idle >300s;
 * quiet stretches during long tool calls hit that), shared by both drain
 * paths. stopped/idle are accessors, not snapshots — they read the caller's
 * live drain state on every check, preserving the original closure reads.
 */
async function runSseEventPump(opts: {
  client: OpencodeClient;
  query: { query: { directory: string } } | undefined;
  handleEvent: (ev: any) => Promise<void>;
  stopped: () => boolean;
  idle: () => boolean;
}): Promise<void> {
  while (!opts.stopped() && !opts.idle()) {
    try {
      const sub = await opts.client.event.subscribe(opts.query as any);
      for await (const ev of sub.stream as AsyncGenerator<any>) {
        if (opts.stopped()) return;
        await opts.handleEvent(ev);
        if (opts.idle()) return;
      }
    } catch {
      // stream dropped — fall through to reconnect
    }
    if (!opts.stopped() && !opts.idle()) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Read the turn's final assistant message out of the messages list and mirror
 * any text parts the SSE pump missed into the transcript + the pending event
 * queue. Shared tail of runOpencodeAttempt and tryReattachOpencodeRun (the
 * emittedText dedup set keeps already-streamed parts from double-appending).
 */
function collectFinalAssistantText(
  list: Array<{ info: any; parts: any[] }>,
  ctx: {
    ocSessionId: string;
    model: string;
    emittedText: Set<string>;
    pending: StreamEvent[];
    /** The run's text ledger. A part can have gone out in pieces without ever
     * completing over SSE, and pushing its whole body here would say it all a
     * second time. */
    textStream?: TextPartStream;
  }
): { lastAssistant: { info: any; parts: any[] } | undefined; info: any; textOut: string } {
  const { ocSessionId, model, emittedText, pending, textStream } = ctx;
  const lastAssistant = latestTurnAssistant(list);
  const info = lastAssistant?.info;
  const parts = lastAssistant?.parts || [];
  // Edge: a turn can end right on the autocompact summary (the trigger is a
  // user-role message, so latestTurnAssistant lands on the summary). Its
  // text is the compaction handoff, not the model's reply.
  const finalIsCompaction = isCompactionMessageInfo(info);
  const textOut = parts
    .filter((pt) => pt.type === "text" && !pt.synthetic && pt.text)
    .map((pt) => {
      if (!emittedText.has(pt.id)) {
        emittedText.add(pt.id);
        appendOpencodeTranscript(ocSessionId, [
          finalIsCompaction
            ? transcriptLineCompactionSummary(pt.text, pt.id)
            : transcriptLineAssistantText(pt.text, pt.id, undefined, model),
        ]);
        if (!finalIsCompaction) {
          const tail = textStream ? textStream.tail(pt.id, pt.text) : pt.text;
          if (tail) pending.push({ type: "text_chunk", text: tail, blockId: pt.id });
        }
      }
      return finalIsCompaction ? "" : pt.text;
    })
    .filter(Boolean)
    .join("\n\n");
  return { lastAssistant, info, textOut };
}

/**
 * Terminal success emit, shared by both drain paths: compute usage from the
 * final assistant info, audit the `result` turn event, and build the
 * usage_snapshot + done events for the caller to yield (in that order).
 */
export function buildTurnResultEvents(ctx: {
  info: any;
  list: Array<{ info: any; parts: any[] }>;
  textOut: string;
  ocSessionId: string;
  model: string;
  providerID: string;
  turnEvent: (fields: Record<string, unknown>) => void;
}): StreamEvent[] {
  const { info, list, textOut } = ctx;
  const tokens = info?.tokens;
  // Flows (tokens moved, money spent) sum over every step of the turn; the
  // context LEVEL is the final step's prompt size, not a sum of prompt sizes.
  const steps = currentTurnAssistants(list);
  let stepsWithUsage = 0;
  const flow = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const step of steps) {
    const t = step.info?.tokens;
    if (!t) continue;
    stepsWithUsage++;
    flow.input += t.input || 0;
    flow.output += t.output || 0;
    flow.cacheRead += t.cache?.read || 0;
    flow.cacheWrite += t.cache?.write || 0;
    flow.cost += step.info?.cost || 0;
  }
  const contextTokens = tokens
    ? (tokens.input || 0) + (tokens.cache?.read || 0) + (tokens.cache?.write || 0)
    : 0;
  const usage: TurnUsage | undefined = stepsWithUsage
    ? {
        costUsd: flow.cost,
        inputTokens: flow.input,
        outputTokens: flow.output,
        cacheReadTokens: flow.cacheRead,
        cacheCreationTokens: flow.cacheWrite,
        contextTokens,
      }
    : undefined;
  // The cache-miss detector asks "did the FINAL step reuse a prefix", so it
  // reads that step alone: against summed reads it could never fire.
  const finalStepUsage: TurnUsage | undefined = tokens
    ? {
        costUsd: info?.cost,
        inputTokens: tokens.input || 0,
        outputTokens: tokens.output || 0,
        cacheReadTokens: tokens.cache?.read || 0,
        cacheCreationTokens: tokens.cache?.write || 0,
        contextTokens,
      }
    : undefined;
  const userTurns = list.filter((message) => message.info?.role === "user").length;
  ctx.turnEvent({
    direction: "out",
    kind: "result",
    result_subtype: "success",
    is_error: false,
    input_tokens: flow.input,
    output_tokens: flow.output,
    cache_read_input_tokens: flow.cacheRead,
    // Never emitted before, so every cache-write column read zero while the
    // most expensive tokens in the run went unrecorded.
    cache_creation_input_tokens: flow.cacheWrite,
    total_cost_usd: flow.cost,
    // Requests behind this turn: the multiplier that made the old
    // last-message-only numbers look plausible.
    steps: steps.length,
    ...summarizeText(textOut),
  });
  const events: StreamEvent[] = [];
  if (usage) events.push({ type: "usage_snapshot", usage });
  events.push({
    type: "done",
    sessionId: ctx.ocSessionId,
    result: textOut || EMPTY_COMPLETION_RESULT,
    provider: PROVIDER,
    model: ctx.model,
    usage,
    cacheMissWarning:
      (finalStepUsage && isLikelyPromptCacheMiss(finalStepUsage, userTurns, ctx.providerID)) ||
      undefined,
  });
  return events;
}

export async function* runOpencode(
  opts: RunAgentOpts & { allowOpencode?: boolean; forceSharedServer?: boolean },
  model: string
): AsyncGenerator<StreamEvent> {
  // Every attempt gets a rotation box. It requests a rotation on a usage limit
  // (another usable account exists — the capped one is marked exhausted so the
  // re-pick moves on) or a bounded transient retry. When the pool is dry the box
  // is left untouched and the attempt emits the terminal error itself.
  const turn: TurnTranscriptState = {
    promptWrittenTo: "",
    notes: [],
    wedgeRetries: 0,
    emptyCompletionRepairs: 0,
  };
  // One controller owns the WHOLE logical turn, including account rotations.
  // A per-attempt controller let Stop abort attempt N while N+1 immediately
  // registered a fresh controller and resurrected the cancelled turn.
  const abortController = new AbortController();
  for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
    if (abortController.signal.aborted || opts.shouldCancel?.()) return;
    const rotation: AccountRotation = { rotate: false, note: "" };
    yield* runOpencodeAttempt(
      opts,
      model,
      rotation,
      attempt,
      turn,
      abortController,
    );
    if (
      abortController.signal.aborted ||
      opts.shouldCancel?.() ||
      !rotation.rotate
    ) return;
    // Surface the rotation as a structured notice, not assistant text: a
    // text_chunk polluted the streaming bubble and vanished on reload (it was
    // never persisted). The next attempt writes it into the transcript as a
    // durable system line (see TurnTranscriptState); the event is for stream
    // consumers that mirror transcripts elsewhere (remote sandbox host).
    turn.notes.push(rotation.note);
    yield { type: "runner_notice", text: rotation.note };
  }
  console.warn(
    `[opencode-runner] account-rotation backstop (${MAX_ACCOUNT_ATTEMPTS}) hit for ${model} — giving up`
  );
  const message =
    `Account-rotation safety limit (${MAX_ACCOUNT_ATTEMPTS} attempts) reached for ${model}; ` +
    "the turn was stopped to avoid an infinite retry loop.";
  if (opts.journal?.osSessionId)
    journalClear(opts.sessionId || opts.journal.osSessionId);
  yield { type: "error", content: message, provider: PROVIDER, model };
}

async function* runOpencodeAttempt(
  opts: RunAgentOpts & { allowOpencode?: boolean; forceSharedServer?: boolean },
  model: string,
  rotation?: AccountRotation,
  attemptIndex = 0,
  turn: TurnTranscriptState = {
    promptWrittenTo: "",
    notes: [],
    wedgeRetries: 0,
    emptyCompletionRepairs: 0,
  },
  abortController = new AbortController(),
): AsyncGenerator<StreamEvent> {
  const { prompt, cwd, mode, mcpServers, confirmTools, journal, user, author } = opts;
  const isAsk = mode === "ask";
  // Scratch: repo-less sessions (feed-item workspaces — the feeds design).
  // Code-mode permissions (write/edit/bash allowed), but no repo/branch/PR
  // flow, so the PR-attribution instructions are withheld below.
  const isScratch = mode === "scratch";

  // The Dial / The Orchestrator: `model` arrived here already mapped to the
  // preset's concrete MAIN model (toOpencodeModel), but opts.model still
  // carries the stored preset id — that's the hook that overrides the
  // reasoning effort and switches on the oracle/worker instructions below.
  // Non-preset runs: all undefined.
  const workspacePreset = resolveWorkspaceModelPreset(opts.model);
  const dial = dialPreset(opts.model) ?? dialPreset(workspacePreset?.enginePresetId);
  const orch = orchestratorPreset(opts.model) ?? orchestratorPreset(workspacePreset?.enginePresetId);
  const effort = dial?.effort ?? orch?.effort ?? opts.effort;

  // Test hook: pretend usage limits are exhausted on every model, so the
  // fallback chain can be verified without burning real limits. Set
  // OPENSESSION_FORCE_LIMIT=1 on a dev process only — never the service env.
  if (process.env.OPENSESSION_FORCE_LIMIT === "1") {
    yield {
      type: "done",
      result: "Claude AI usage limit reached|forced-by-OPENSESSION_FORCE_LIMIT",
      provider: PROVIDER,
      model,
      usageLimitExhausted: true,
    };
    return;
  }

  // Command-policy gate (command-policy.ts): unattended code-mode runs get a
  // bash "*" ask rule so every command round-trips through the permission
  // bridge, where the org-floor policy answers it. Kind-based, NOT
  // policy.unattended — the slack/linear loops carry deniedTools (which flips
  // policy.unattended) but are driven by trusted humans and ride shared
  // servers; gating them would add a wedge surface to interactive work for no
  // containment gain. Ask mode needs no gate: its bash allowlist is read-only.
  const bashGated = isUnattendedKind(baseJournalKind(journal?.kind)) && !isAsk;

  const gateReason = opencodeGateReason(opts);
  if (gateReason) {
    audit({
      msg: "opencode_gate_denied",
      run_kind: journal?.kind,
      session_id: journal?.osSessionId,
      reason: gateReason,
    });
    yield { type: "error", content: gateReason, provider: PROVIDER, model };
    return;
  }

  const parsed = parseOpencodeModel(model);
  if (!parsed) {
    yield {
      type: "error",
      content: `Not an opencode model id: "${model}" (expected opencode/<provider>/<model>)`,
      provider: PROVIDER,
      model,
    };
    return;
  }
  const meridianModels = meridianRequiredModels(parsed.modelID, dial?.oracleAgent);

  const runKey = opts.sessionId || journal?.osSessionId || crypto.randomUUID();
  if (activeOpencodeRuns.has(runKey)) {
    yield { type: "error", content: "Session is busy" };
    return;
  }
  const registeredKeys = new Set<string>([runKey]);
  if (journal?.osSessionId) registeredKeys.add(journal.osSessionId);
  if (opts.transcriptSessionId) registeredKeys.add(opts.transcriptSessionId);
  for (const key of registeredKeys) activeOpencodeRuns.set(key, abortController);

  // Durability BEFORE the engine exists (2026-07-24, bks-019f93ea: a restart
  // killed a create-run during the ~16s server spawn — the opening prompt was
  // in no journal and no transcript, so the session came back permanently
  // empty). Two writes close that window: journal the run NOW with the
  // original prompt (no engine id yet ⇒ boot re-runs it from scratch via
  // resumeInterruptedRuns; the journalSet after session-create upgrades this
  // record with the engine id + server key), and persist the user line to the
  // transcript store under the unified id so the message survives any death.
  // First attempt only: a rotation retry's record (with engine id) must not
  // be downgraded back to this early shape. In-process failures still clear
  // the record via the catch/finally below (reachedTerminal) — only a real
  // process death leaves it for boot to pick up.
  if (journal?.osSessionId && attemptIndex === 0) {
    turn.userLine ??= transcriptLineUser(
      prompt,
      opts.promptEntryId,
      undefined,
      opts.images
    );
    journalSet(
      buildRunJournalRecord(opts, {
        runKey,
        osSessionId: journal.osSessionId,
        claudeSessionId: opts.sessionId || undefined,
        prompt,
        promptEntryId: String(turn.userLine.uuid),
        cwd,
        mode,
        mcpServers,
        user,
        confirmTools,
        model,
        effort: opts.effort,
        fastMode: opts.fastMode,
        accountId: opts.accountId,
        accountStrict: opts.accountStrict,
        usageCredits: opts.usageCredits,
        prReviewer: opts.prReviewer,
        kind: journal.kind,
      })
    );
    storeAppendUserLineEarly(
      journal.osSessionId,
      turn.userLine,
      opts.sessionId
    );
  }

  // Session identity (sticky-account key, legacy per-session server key,
  // instructions-file name). The SHARED-server pool key is computed later,
  // once the bridge account is known.
  const sessionKey = opts.accountAffinityKey || journal?.osSessionId || cwd;
  // Cerebras' self-serve tier allows only 30k input tokens/minute. A shared
  // interactive server carries the complete external + Open Session MCP catalog,
  // which exceeds that limit before generation starts. Keep Cerebras on a
  // compact per-session server; its core coding tools remain available.
  const compactCerebras = parsed.providerID === "cerebras";
  const shared = !compactCerebras && sharedOpencodeEligible(opts);
  const policy = opencodeRunPolicy({
    deniedTools: opts.deniedTools,
    confirmTools,
    journalKind: journal?.kind,
    disableLocalWorkspaceTools: opts.disableLocalWorkspaceTools,
  });
  // The GitHub credential is server-level state. Resolve its principal before
  // provider setup so shared-server reuse (including Meridian's stable proxy
  // key) addresses the correct service- or user-credential pool.
  const githubUserLogin =
    !policy.unattended && INTERACTIVE_KINDS.has(baseJournalKind(journal?.kind))
      ? githubUserLoginForRun(user || author?.name)
      : null;
  const turnId = crypto.randomUUID();
  let ocSessionId = opts.sessionId || "";
  // Set once a terminal path has run (turn finished, or a failure we've
  // already acted on). A generator torn down mid-turn by its CONSUMER (hot
  // reload chaos, shutdown) never reaches one — the finally then keeps the
  // journal record so the next boot can reattach the still-live engine turn
  // instead of orphaning it (2026-07-17 19:57: zero reattaches at boot #2).
  let reachedTerminal = false;
  const turnEvent = (fields: Record<string, unknown>) =>
    audit({
      msg: "claude_turn_event",
      provider: PROVIDER,
      turn_id: turnId,
      run_key: runKey,
      session_id: journal?.osSessionId,
      run_kind: journal?.kind,
      mode: mode || "code",
      claude_session_id: ocSessionId || undefined,
      model,
      ...fields,
    });

  let entry: OpencodeServerEntry | undefined;
  let rpcTokenRegistered = false;
  // Non-empty = the opencode session id registered in run-rpc's ocSession
  // registry (shared servers); unregistered in the finally.
  let ocSessionRegistered = "";
  // Set by the proc-exit watcher / turn deadline; checked after the drain loop
  // so every terminal decision reads one classified failure.
  let turnFailure: OpencodeTurnFailure | undefined;
  // True when the failure path already wrote its own transcript system line
  // (turn timeout) — rides the terminal error event so run-session doesn't
  // persist a second, redundant one.
  let failureNoticePersisted = false;
  let runEnded = false;
  let failRun: () => void = () => {};
  // Run-level bridge audit closer (see module doc: subscription bridges —
  // meridian for anthropic, ChatGPT-OAuth for openai — audit per run, not per
  // HTTP request). First call wins; the finally backstop covers
  // cancellation/crashes.
  let bridgeRunEnd: (status: string, detail?: string) => void = () => {};
  // Liveness guard: subscription-bridge runs (meridian / openai) that hang at
  // an auth wall never produce output; the 60-min turn deadline is uselessly
  // long for that. The account state also retains API-key bindings for usage-
  // limit rotation while leaving their OAuth-only liveness guard disabled.
  let bridgeAccount: BridgeAccountState | undefined;
  const bridgeAccountLabel = () => bridgeAccount?.account.name || "";
  // The provider's most recent in-turn retry error (opencode retries stream
  // errors internally with backoff and stays silent while doing so — the
  // RetryPart / session.status events are the only visibility we get).
  let lastProviderRetryError = "";

  try {
    // Bridge for Anthropic models — dispatched on bridge.mode in
    // ~/.opensession-opencode.json; throws a clear config error when off.
    let providerOverride: Record<string, unknown> | undefined;
    let serverExtraEnv: Record<string, string> | undefined;
    let meridianPlugin: string[] | undefined;
    // Which provider-auth tuple this run's server env is pinned to — the
    // provider-half of the shared pool key ("plain" = no per-run auth env,
    // e.g. API-key providers configured in opencode itself).
    let bridgeTag = "plain";
    if (parsed.providerID === "anthropic") {
      const cfg = readOpencodeBridgeConfig();
      const bridgeMode = cfg?.enabled ? cfg.bridgeMode : "off";
      if (bridgeMode === "meridian") {
        const stack = meridianStackInfo();
        const stickySeed = () =>
          stickyMeridianAccounts.get(sessionKey) ?? stickyAccountFromDbMap(ocSessionId);
        const repick = () => {
          const p = pickMeridianAccount(
            user,
            meridianModels,
            cfg!.bridgeAccountIds,
            opts.accountId,
            opts.accountStrict,
            stickySeed(),
            meridianPickOut,
            true,
            opts.usageCredits,
          );
          return "error" in p ? null : p;
        };
        const meridianPickOut: { reason?: string } = {};
        let picked = pickMeridianAccount(
          user,
          meridianModels,
          cfg!.bridgeAccountIds,
          opts.accountId,
          opts.accountStrict,
          stickySeed(),
          meridianPickOut,
          true,
          opts.usageCredits,
        );
        if ("error" in picked) {
          // Dry pool at pick time: unattended runs queue for an account to
          // free instead of cascading aborts (poolWaitMsFor is 0 for
          // interactive kinds, which fail fast into the fallback graph). This
          // is pre-init — no engine session, no partial work — so a delayed
          // start is safe and idempotent.
          const waitMs = poolWaitMsFor(journal?.kind);
          const cause = picked.error;
          if (waitMs > 0) {
            const waited = await waitForUsableAccount({
              pick: repick,
              user,
              model: meridianModels,
              maxWaitMs: waitMs,
              signal: abortController.signal,
              accountId: opts.accountStrict ? opts.accountId : undefined,
              allowExtraUsage: opts.usageCredits,
              allowedAccountIds: cfg!.bridgeAccountIds,
              onWaitStart: (earliestReset) => {
                audit({
                  msg: "account_pool_wait",
                  run_kind: journal?.kind,
                  session_id: journal?.osSessionId,
                  model,
                  reason: cause,
                  earliest_reset: new Date(earliestReset).toISOString(),
                  max_wait_ms: waitMs,
                });
                console.warn(
                  `[opencode-runner] account pool dry for ${model} (${cause}) — ` +
                    `waiting up to ${Math.round(waitMs / 60000)}m (earliest reset ${new Date(earliestReset).toISOString()})`
                );
              },
            });
            if (waited) {
              audit({
                msg: "account_pool_wait_resolved",
                run_kind: journal?.kind,
                session_id: journal?.osSessionId,
                model,
                account: waited.name,
              });
              picked = waited;
            }
          }
        }
        if ("error" in picked) {
          // A dry/pinned-out account pool at pick time is the same condition
          // as a mid-run usage limit with no account left to rotate to: flag
          // the error so the catch below emits usageLimitExhausted and
          // agent-runner's model-fallback graph takes over instead of
          // dead-ending the run (the message matches neither usage-limit
          // classifier nor isTransientRunError).
          const err = new Error(`meridian bridge: ${picked.error}`) as Error & {
            usageLimitExhausted?: boolean;
          };
          err.usageLimitExhausted = true;
          throw err;
        }
        // Near-limit steering: the usage cache refreshes only hourly, so a
        // turn can start on an account that's about to hit its 5h/scoped cap
        // and lose all its progress to the mid-turn limit error (full
        // re-prompt on the rotation account, cold cache). When the candidate's
        // cached usage is already near the cap, spend one targeted poll
        // (tier/cooldown-bounded in claude-accounts) and re-pick on fresh
        // data — the same account comes back unless it's genuinely at cap.
        if (
          await refreshUsageIfNearLimit(
            picked.id,
            meridianModels,
            abortController.signal,
          )
        ) {
          const fresh = repick();
          if (fresh && fresh.id !== picked.id) {
            audit({
              msg: "account_near_limit_steer",
              run_kind: journal?.kind,
              session_id: journal?.osSessionId,
              model,
              from_account: picked.name,
              to_account: fresh.name,
            });
            console.warn(
              `[opencode-runner] ${picked.name} near its usage limit on fresh check — steering turn to ${fresh.name}`
            );
            picked = fresh;
          }
        }
        if (abortController.signal.aborted || opts.shouldCancel?.()) return;
        stickyMeridianAccounts.set(sessionKey, picked.id);
        bridgeTag = `anthropic-${picked.id}`;
        // Stable per-server proxy key so the config hash — and the server —
        // survive across runs; a fresh key is minted only with a fresh server.
        const meridianServerKey = shared
          ? sharedServerKey(bridgeTag, user, githubUserLogin)
          : sessionKey;
        const meridianKey =
          servers.get(meridianServerKey)?.meridianKey || crypto.randomUUID();
        const meridianEnv = meridianAccountEnv(picked, meridianKey, meridianServerKey);
        // First run on this key+account inherits the legacy shared store, so the
        // cutover respawn costs no forced replays (see seedMeridianSessionDir).
        seedMeridianSessionDir(meridianEnv.MERIDIAN_SESSION_DIR);
        // Repointing XDG_DATA_HOME hides gh's installed extensions from the
        // run unless gh's data dir is linked in (see linkGhDataDir).
        serverExtraEnv = meridianEnv;
        // Ensure the server-side fingerprint scrub is present before this
        // server's proxy starts (engine-agnostic billing — see fn doc).
        ensureMeridianProxyScrub();
        meridianPlugin = [stack.pluginPath];
        // Point at the allocated proxy directly. The plugin also applies this
        // rewrite, but relying on that config hook made fresh/newer OpenCode
        // installs hit the old port-1 placeholder when plugin hook timing
        // changed. The first-run health gate below still proves the plugin
        // actually loaded and started Meridian before any model request.
        providerOverride = {
          anthropic: {
            options: {
              baseURL: meridianProxyBaseUrl(meridianEnv.CLAUDE_PROXY_PORT),
              apiKey: meridianKey,
            },
          },
        };
        const auditBase = {
          msg: "opencode_meridian_run",
          turn_id: turnId,
          run_key: runKey,
          session_id: journal?.osSessionId,
          run_kind: journal?.kind,
          model,
          account: picked.name,
          account_id: picked.id.slice(0, 8),
          pick_reason: meridianPickOut.reason,
          meridian_version: stack.meridianVersion,
          plugin_version: stack.pluginVersion,
        };
        const startedAt = Date.now();
        audit({ ...auditBase, phase: "start" });
        let ended = false;
        bridgeRunEnd = (status, detail) => {
          if (ended) return;
          ended = true;
          audit({
            ...auditBase,
            phase: "end",
            status,
            duration_ms: Date.now() - startedAt,
            ...(detail ? { error: detail } : {}),
          });
        };
        bridgeAccount = { kind: "meridian", account: picked, livenessGuard: true };
      } else if (bridgeMode === "native") {
        const bridge = ensureAnthropicBridge();
        bridgeTag = "anthropic-native";
        providerOverride = {
          anthropic: { options: { baseURL: `${bridge.url}/v1`, apiKey: bridge.key } },
        };
      } else {
        throw new Error(
          "opencode/anthropic/* models are disabled: ~/.opensession-opencode.json is missing, " +
            'has "enabled": false, or sets bridge.mode "off". Enable it with ' +
            '{"enabled": true} (bridge.mode defaults to "meridian") — or use an API-key ' +
            "provider configured via `opencode auth login` instead."
        );
      }
    } else if (parsed.providerID === "openai") {
      // opencode/openai/* on our EXISTING ChatGPT-subscription auth (the codex
      // accounts pool) — the OpenAI analog of the meridian bridge. Independent
      // of the anthropic bridge's `enabled` flag: it keys off codex-accounts,
      // not the bridge config (only the optional openaiAccounts restriction is
      // read there). With no codex accounts we fall through to opencode's own
      // host auth (`opencode auth login`) — unchanged behavior. See
      // opencode-openai-auth.ts for the seed-access-only rotation-hazard fix.
      const cfg = readOpencodeBridgeConfig();
      const openaiPickOut: { reason?: string } = {};
      const picked = pickOpenaiAccount(
        parsed.modelID,
        cfg?.openaiAccounts,
        sessionKey,
        openaiPickOut,
        user,
        opts.accountId,
        opts.accountStrict,
      );
      if (!("error" in picked)) {
        const bound = bindOpenaiAccount(picked);
        if ("error" in bound) {
          // An unusable codex account at bind time (expired ChatGPT access
          // token, unreadable auth.json) is the same condition as a dry pool:
          // this model has no account to run on right now. Flag it like the
          // meridian pick failure above so agent-runner's model-fallback graph
          // hops to the next destination instead of dead-ending the run
          // (2026-07-12: PR #4804 autofix died here after Fable→Sol, with
          // Opus still available).
          const err = new Error(`opencode/openai: ${bound.error}`) as Error & {
            usageLimitExhausted?: boolean;
          };
          err.usageLimitExhausted = true;
          throw err;
        }
        serverExtraEnv = { ...(serverExtraEnv || {}), ...bound.extraEnv };
        if (bound.providerOverride) providerOverride = bound.providerOverride;
        bridgeTag = `openai-${picked.id}`;
        // Shared servers live for hours, but a seeded ChatGPT access token
        // (placeholder refresh — opencode must never rotate the real one)
        // does not. Fold the seed's expiry into the env (and therefore the
        // config hash): when the host codex login refreshes the token,
        // bindOpenaiAccount reseeds and the next ensure drain-respawns onto
        // the fresh token instead of riding the stale one to an auth wall.
        if (shared && bound.extraEnv.XDG_DATA_HOME) {
          try {
            const seeded = JSON.parse(
              readFileSync(`${bound.extraEnv.XDG_DATA_HOME}/opencode/auth.json`, "utf-8")
            );
            const exp = seeded?.openai?.expires;
            if (typeof exp === "number") {
              serverExtraEnv.OPENSESSION_OPENAI_SEED_EXPIRES = String(exp);
            }
          } catch {}
        }
        const auditBase = {
          msg: "opencode_openai_run",
          turn_id: turnId,
          run_key: runKey,
          session_id: journal?.osSessionId,
          run_kind: journal?.kind,
          model,
          account: maskOpenaiAccount(picked),
          account_id: picked.id.slice(0, 8),
          mechanism: bound.mechanism,
          pick_reason: openaiPickOut.reason,
        };
        const startedAt = Date.now();
        audit({ ...auditBase, phase: "start" });
        let ended = false;
        bridgeRunEnd = (status, detail) => {
          if (ended) return;
          ended = true;
          audit({
            ...auditBase,
            phase: "end",
            status,
            duration_ms: Date.now() - startedAt,
            ...(detail ? { error: detail } : {}),
          });
        };
        // API-key runs authenticate synchronously (no OAuth wall to hang on),
        // but still retain their account for usage-limit rotation.
        bridgeAccount = openaiBridgeAccountState(picked, bound.mechanism);
      }
      // picked.error (no codex accounts) ⇒ fall through to opencode's own
      // host auth (`opencode auth login`) — but only when that credential
      // actually exists. Without it opencode simply omits the provider from
      // its generated config and the turn dies with a bare "model not found";
      // say what's actually wrong instead. This is the genuine fail-closed
      // wall: it fires only when the account store is empty/exhausted here —
      // docker mounts it ro, and remote launches (daytona/e2b) upload a
      // scoped store + rotation-proof seeds per launch (bootstrap.ts), so a
      // sandbox hitting this was created before those fixes (recreate it) or
      // the host truly has no usable codex account.
      if (
        "error" in picked &&
        ((opts.accountId && opts.accountStrict) ||
          !opencodeHasNativeOpenaiAuth())
      ) {
        // Also exhaustion-shaped (no account can serve this model here) —
        // flagged so the fallback graph can route to another family rather
        // than dead-ending, same as the bind failure above.
        const err = new Error(
          `opencode/openai: ${picked.error}; and no native \`opencode auth login\` openai ` +
            "credential exists in this environment. In a sandbox, the ChatGPT/codex account " +
            "material may be missing (mounted for docker, seed-uploaded per launch for " +
            "daytona/e2b — recreate the sandbox on current code); otherwise add a codex " +
            "account in Connections."
        ) as Error & { usageLimitExhausted?: boolean };
        err.usageLimitExhausted = true;
        throw err;
      }
      if ("error" in picked) bridgeTag = "openai-host";
    }

    // The server this run binds to: eligible interactive runs multiplex onto
    // the shared always-warm server for their (bridge account × user) tuple;
    // everything else keeps the per-session server. For shared servers the
    // git identity rides extraEnv so it participates in the config hash
    // (deterministic per user — a mismatch means the identity mapping
    // changed, which SHOULD drain-respawn).
    if (shared) {
      serverExtraEnv = { ...(serverExtraEnv || {}), ...gitIdentityEnv(author) };
    }
    // AWS read creds (aws-creds.ts): `aws: true` runs get a STATIC pointer
    // env to a credentials file the main process keeps fresh — raw keys in
    // the spawn env would expire under a long-lived server, and rotating
    // them would churn the config hash. Every shared-eligible kind passes
    // aws:true (run-session / slack / linear), so shared servers hash
    // identically; per-session unattended runs gate at their call site
    // (automations/github yes, plain no). In sandboxes the mint fails (IMDS
    // blocked) and the run proceeds without AWS — documented docker caveat.
    if (opts.aws) {
      const awsPointerEnv = await ensureAgentAwsCredsFile();
      if (Object.keys(awsPointerEnv).length) {
        serverExtraEnv = { ...(serverExtraEnv || {}), ...awsPointerEnv };
      }
    }
    // Deny/confirm enforcement (see module doc): every run gets its deny-set
    // (incl. the confirm-listed money-movers) STRIPPED from the model's tool
    // list — config-level `tools` on per-session servers, per-prompt on shared
    // ones. The servers themselves stay mounted, so reads keep working.
    // Per-user GitHub auth (opt-in — github-auth.ts): the session owner's own
    // token rides the server env so `gh` acts as them (PRs authored by the
    // human, not the bot). Trust gate: interactive kinds only, and never a
    // least-privilege run — automations and deniedTools carriers (interactive
    // resumes of automation sessions, the Slack/Linear loops with their Stripe
    // deny-set) keep the bot credential. Deterministic per user, so it's safe
    // in the shared-server config hash (a token change drain-respawns, same as
    // an identity change).
    if (githubUserLogin) {
      serverExtraEnv = { ...(serverExtraEnv || {}), ...githubAuthEnv(user || author?.name) };
    }
    // Pool Claude-CLI credential (opts.claudeCliEnv — deepsec security scans):
    // the scan tooling spawns its own `claude` Agent-SDK subprocess inside the
    // run, which must authenticate on the account pool EXPLICITLY — never on
    // the host CLI's login (logged out 2026-08-08 → every scan analyzed zero
    // batches while recording ok), and never only when the orchestrator model
    // happens to be meridian-backed. A meridian run's env already carries the
    // same-class token (see meridianAccountEnv's exposure note), so only fill
    // the gap; per-session servers only — flagged kinds never share, and a
    // shared server's env must not carry a run-specific credential.
    if (opts.claudeCliEnv && !shared && !serverExtraEnv?.CLAUDE_CODE_OAUTH_TOKEN) {
      const cliAccount = pickAccount(undefined, user, undefined, opts.usageCredits);
      if (cliAccount) {
        const cliCfgDir = `${MERIDIAN_CFG_ROOT}/${cliAccount.id}`;
        mkdirSync(cliCfgDir, { recursive: true, mode: 0o700 });
        serverExtraEnv = {
          ...(serverExtraEnv || {}),
          CLAUDE_CODE_OAUTH_TOKEN: cliAccount.token,
          CLAUDE_CONFIG_DIR: cliCfgDir,
        };
        audit({
          msg: "claude_cli_env_account",
          run_kind: journal?.kind,
          session_id: journal?.osSessionId,
          account: cliAccount.name,
          account_id: cliAccount.id.slice(0, 8),
        });
      } else {
        // Don't fail the run — the orchestrator can still report the dry pool
        // as a scan failure instead of silently half-running.
        console.warn(
          "[opencode-runner] claudeCliEnv requested but no usable Claude account in the pool — run proceeds without it"
        );
      }
    }
    // Codex sibling (opts.codexCliEnv — deepsec's `--agent codex`): the codex
    // CLI reads CODEX_HOME, and a home-kind account's value IS its live host
    // CODEX_HOME — the same dir native codex runs point at — so there is no
    // auth copy and no refresh-token rotation hazard (the opencode seeding
    // dance exists only because opencode keeps its OWN auth store). API-key
    // accounts ride OPENAI_API_KEY instead. Same containment as the claude
    // block above: per-session servers only, fill-the-gap only, fail-soft.
    if (
      opts.codexCliEnv &&
      !shared &&
      !serverExtraEnv?.CODEX_HOME &&
      !serverExtraEnv?.OPENAI_API_KEY
    ) {
      const codexCliCfg = readOpencodeBridgeConfig();
      const codexPick = pickOpenaiAccount("", codexCliCfg?.openaiAccounts, sessionKey, undefined, user);
      if ("error" in codexPick) {
        console.warn(
          `[opencode-runner] codexCliEnv requested but no usable codex account (${codexPick.error}) — run proceeds without it`
        );
      } else {
        serverExtraEnv = {
          ...(serverExtraEnv || {}),
          ...(codexPick.kind === "home"
            ? { CODEX_HOME: codexPick.value }
            : { OPENAI_API_KEY: codexPick.value }),
        };
        audit({
          msg: "codex_cli_env_account",
          run_kind: journal?.kind,
          session_id: journal?.osSessionId,
          account: codexPick.name,
          account_id: codexPick.id.slice(0, 8),
        });
      }
    }

    const serverKey = shared
      ? sharedServerKey(bridgeTag, user, githubUserLogin)
      : sessionKey;
    const dirQuery = shared ? { directory: cwd } : undefined;
    const q = dirQuery ? { query: dirQuery } : {};

    const { mcp: externalMcp } = buildOpencodeMcpConfig(
      shared ? "all" : mcpServers,
      user,
      [user],
    );

    // Session context (ask guardrails, repos note, managing-the-agent notes).
    // Per-session servers deliver it via an instructions FILE in the config;
    // shared servers can't (config is multi-session), so it rides the
    // per-prompt `system` param instead — verified live to APPEND to
    // opencode's own system prompt, not replace it.
    // The repo this run's cwd belongs to, or undefined when none owns it (a
    // scratch dir, a repo-less ask session, an unregistered path). Dynamic
    // import: a static "./worktree" edge here creates a module-init cycle
    // (worktree → preview → … → this file) that TDZ-crashes on load.
    const cwdRepo = await (async () => {
      try {
        return (await import("./worktree")).repoForPathOrNull(cwd);
      } catch {
        return undefined;
      }
    })();
    const instructions = buildRunInstructions({
      isAsk,
      isScratch,
      // No repo to read or write: the run is a conversation with its tools.
      isRepoLess: !cwdRepo,
      reposNote: opts.reposNote,
      prReviewer: opts.prReviewer,
      scratchDir: opts.scratchDir,
      // Host-aware PR-flow instructions: code.storage repos have no PRs, so
      // the agent is told to push its branch instead of `gh pr create`.
      // Repo-less cwds keep the GitHub default.
      repoHost: isScratch ? undefined : cwdRepo?.host,
      // Per-session servers boot in `cwd`, so their environment block is
      // already right; only the pool needs the correction.
      cwd: shared ? cwd : undefined,
      // Untracked AGENTS.local.md / CLAUDE.local.md at the session's cwd.
      // Rides the same channel as the rest (per-session instructions file /
      // shared per-prompt `system`), so it reaches every run either way.
      localInstructions: readLocalInstructions(cwd),
      inProcessMcp: opts.inProcessMcp,
      osSessionId: journal?.osSessionId,
      user,
      author,
      githubUserLogin,
      deniedToolNotes: policy.noteGroups,
      commandPolicyGated: bashGated,
      // The server carries ONE bridge's models, so a cross-provider oracle
      // (ultra's sol-on-anthropic, high's fable-on-openai) can't resolve
      // there — substitute the same-bridge alternate (Terra/Opus) so the
      // consult actually works (Dreaming 2026-07-17: 17 loud errors on
      // dial/high, silent no-ops on dial/ultra).
      dialOracle: dial
        ? (() => {
            const agent = sameBridgeDialOracle(dial.oracleAgent, parsed.providerID);
            return {
              agent,
              presetLabel: dial.label,
              mainLabel: opencodeModelLabel(dial.model),
              oracleLabel: DIAL_ORACLE_AGENTS[agent]?.label || agent,
            };
          })()
        : undefined,
      // Worker names are stable across bridges; only the backing model label
      // varies (orchestratorWorkerForBridge, same-bridge rule as the oracle).
      orchestrator: orch
        ? {
            presetLabel: orch.label,
            mainLabel: opencodeModelLabel(orch.model),
            workers: orch.workerAgents.map((name) => ({
              agent: name,
              label: ORCHESTRATOR_WORKER_AGENTS[name]?.label || name,
              modelLabel:
                orchestratorWorkerForBridge(name, parsed.providerID)?.label || name,
            })),
          }
        : undefined,
    });
    const instructionsPath = `${OPENCODE_STATE_DIR}/${serverKey.replace(/[^A-Za-z0-9._-]/g, "_")}-instructions.md`;
    if (!shared) {
      // Rewritten per run (repos can attach mid-session); the stable path
      // keeps the config hash — and therefore the server — unchanged.
      mkdirSync(OPENCODE_STATE_DIR, { recursive: true });
      writeFileSync(instructionsPath, instructions || "");
    }

    // Stable per-server rpc token: minted with the server entry, registered
    // for the duration of each run (the proxies only forward during runs).
    const preEntry = servers.get(serverKey);
    const rpcToken = preEntry?.rpcToken || crypto.randomUUID();
    const hasInProcess = !!(opts.inProcessMcp && Object.keys(opts.inProcessMcp).length);
    // Prebuilt stdio proxies (runner-host context) pass through as-is — their
    // rpc token is already registered in the opensession process. See
    // opencodeMcpFromPrebuiltProxies.
    const prebuiltProxies = opencodeMcpFromPrebuiltProxies(opts.inProcessMcp);

    // Third-party providers configured in Settings (xai, openrouter, …) merge
    // UNDER the bridge override so the anthropic/openai subscription bridges
    // always win. When both are empty the `provider` key is omitted entirely —
    // keeps the config hash (and thus server reuse) identical for setups with
    // no providers configured.
    const providerConfig = {
      ...opencodeProviderOptions(),
      ...(providerOverride || {}),
    };

    // Per-prompt policy for shared runs: everything a per-session server
    // bakes into its config rides the prompt body instead. Ask mode selects
    // the config-defined read-only `ask` agent AND strips the write tools
    // (belt + braces with the agent's own tools/permission config); the
    // deny/confirm-set (policy.disables) and the in-process servers this run
    // does NOT carry are all stripped from this prompt's tool list only —
    // other sessions on the server are untouched.
    const promptTools: Record<string, boolean> = {};
    let promptAgent: string | undefined;
    if (shared) {
      if (isAsk) {
        promptAgent = "ask";
        promptTools.write = false;
        promptTools.edit = false;
        promptTools.patch = false;
      }
      Object.assign(promptTools, policy.disables);
      const inprocNames = new Set(Object.keys(opts.inProcessMcp || {}));
      for (const name of SHARED_INPROCESS_SERVERS) {
        if (!inprocNames.has(name)) promptTools[`${name}_*`] = false;
      }
    }

    const ocConfig: Record<string, unknown> = shared
      ? {
          // Shared config = the union view: every external server the run
          // user may see (allowedUsers-gated via filterMcpServers), every
          // in-process proxy an interactive run can carry. Per-run narrowing
          // happens per prompt (promptTools above); per-call session routing
          // via the session-tag plugin + run-rpc ocSession registry.
          mcp: {
            ...externalMcp,
            ...inProcessOpencodeMcpConfigs(
              Object.fromEntries(SHARED_INPROCESS_SERVERS.map((n) => [n, true])),
              rpcToken
            ),
          },
          autoshare: false,
          // Shadow-git snapshots run `git add --all` over the entire worktree
          // (plus git-lfs re-hashing) at every step-start AND step-finish of
          // every turn. On multi-GB tella-fusion worktrees with a dozen
          // concurrent runs that saturated the NVMe (2026-07-27: load 50-85,
          // 86% iowait, the web UI unreachable). We never use opencode's
          // undo/revert — worktrees + PRs are the rollback mechanism.
          snapshot: false,
          plugin: [...(meridianPlugin || []), SESSION_TAG_PLUGIN_PATH, ARG_COERCE_PLUGIN_PATH],
          ...(Object.keys(providerConfig).length ? { provider: providerConfig } : {}),
          // Code mode reads files outside the worktree as a matter of course —
          // attachments land in ~/.opensession-sessions/uploads — and opencode's
          // default for external_directory is "ask", which blocks the tool on
          // a permission ask no one is there to answer (the 2026-07-10 wedge:
          // a session sat busy 40 min on a `read` of a staged PDF). Bash is
          // unrestricted in code mode, so gating the read tool adds no
          // security — allow it. Ask mode's agent below still denies.
          permission: { external_directory: "allow" },
          // Read-only ask mode as a selectable agent (mode "primary" so it
          // never doubles as a subagent): same bash allowlist + write denial
          // the per-session ask config enforces server-wide.
          agent: {
            ask: {
              mode: "primary",
              description: "Read-only ask mode (opensession)",
              permission: {
                edit: "deny",
                bash: ASK_BASH_PERMISSIONS,
                webfetch: "allow",
                external_directory: ASK_EXTERNAL_DIR_PERMISSIONS,
              },
              tools: { write: false, edit: false, patch: false },
            },
            ...dialOracleAgentConfigs(parsed.providerID),
            ...orchestratorWorkerAgentConfigs(parsed.providerID),
          },
        }
      : {
          mcp: compactCerebras
            ? {}
            : {
                ...externalMcp,
                ...(prebuiltProxies ??
                  (hasInProcess && journal?.osSessionId
                    ? inProcessOpencodeMcpConfigs(opts.inProcessMcp, rpcToken)
                    : {})),
              },
          instructions: [instructionsPath],
          autoshare: false,
          // Same as the shared config: snapshot tracking is an I/O storm on
          // big worktrees and we never use opencode's undo/revert.
          snapshot: false,
          // Same static oracle/worker set as the shared config — a per-run
          // agent section would churn this server's config hash when a
          // session moves on/off a dial or orchestrator preset.
          agent: {
            ...dialOracleAgentConfigs(parsed.providerID),
            ...orchestratorWorkerAgentConfigs(parsed.providerID),
          },
          // Arg-coerce must ride per-session servers too: automations (Plain
          // triage, github-review) run here, and their MCP calls hit the same
          // model-stringified-object failures the plugin repairs (2026-07-18:
          // 3× stripe_api_read "#/parameters of type string" in triage —
          // the plugin was shared-servers-only). Session-tag stays shared-only
          // by design (per-session servers host exactly one session).
          plugin: [...(meridianPlugin || []), ARG_COERCE_PLUGIN_PATH],
          ...(Object.keys(providerConfig).length ? { provider: providerConfig } : {}),
          ...(isAsk
            ? {
                permission: {
                  edit: "deny",
                  bash: ASK_BASH_PERMISSIONS,
                  webfetch: "allow",
                  external_directory: ASK_EXTERNAL_DIR_PERMISSIONS,
                },
              }
            : bashGated
              ? // Unattended code mode: every bash command generates a
                // permission ask, answered in-process by the command policy
                // (bashAskPolicyReply via the bridge below). "ask", never
                // "deny" — a "*" deny would make opencode hide the bash tool
                // entirely (Permission.disabled, the PR #4676 trap). The
                // bridge guarantees a reply; the busy-poll sweep re-catches
                // any ask the SSE pump misses.
                { permission: { external_directory: "allow", bash: { "*": "ask" } } }
              : // Same rationale as the shared config: attachments live outside
                // the worktree and code mode's unrestricted bash makes the read
                // gate pure friction (plus a turn-wedging ask by default).
                { permission: { external_directory: "allow" } }),
          // Ask-mode write tools + the unattended deny-set are both enforced by
          // stripping tools from the model's tool list. Key omitted when empty so
          // existing interactive servers keep their config hash (no respawn).
          ...(isAsk || Object.keys(policy.disables).length
            ? {
                tools: {
                  ...(isAsk ? { write: false, edit: false, patch: false } : {}),
                  ...policy.disables,
                },
              }
            : {}),
        };

    // Model-visible means logged (context-log.ts), standing half: the two
    // inputs the model sees on EVERY turn of this session, recorded here
    // because here is where they are final — and recorded once per session,
    // then again only when their content hash moves, so a session does not
    // carry a hundred copies of the same instructions file.
    //
    // `mcp-servers` is the resolution of the scope runOnModel already logged:
    // the servers this run's config actually mounts (allowlist + allowedUsers
    // gating applied), the strips that narrow them, and the subagents the
    // `task` tool can reach. It stops short of the tool SCHEMAS — OpenCode
    // fetches those from each server at startup and neither persists nor
    // exposes them (see context-log.ts).
    {
      const standingSessionId = journal?.osSessionId || opts.transcriptSessionId;
      const standingTurnId = opts.promptEntryId || opts.startToken;
      logStandingJson({
        sessionId: standingSessionId,
        turnId: standingTurnId,
        source: "mcp-servers",
        value: {
          shared,
          mounted: Object.keys(externalMcp).sort(),
          inProcess: Object.keys(opts.inProcessMcp || {}).sort(),
          // Per-session servers bake the strips into the config; shared ones
          // narrow per prompt so other sessions on the server are untouched.
          strip: shared
            ? promptTools
            : ((ocConfig.tools as Record<string, boolean> | undefined) ?? {}),
          agents: Object.keys((ocConfig.agent as Record<string, unknown>) || {}).sort(),
          ...(promptAgent ? { promptAgent } : {}),
        },
      });
      // The standing instruction text itself: run guidance, the repos/PR flow
      // notes, the denied-tool notes, and the checkout's own untracked
      // AGENTS.local.md / CLAUDE.local.md, which reach the model through the
      // instructions file (per-session) or the per-prompt `system` (shared).
      logStandingContext({
        sessionId: standingSessionId,
        turnId: standingTurnId,
        source: "instructions",
        content: instructions,
      });
    }

    // A fresh OpenCode server discovers MCP tools as part of startup. Make the
    // shared proxy token routable before spawning it; otherwise that first
    // tools/list fails and OpenCode caches every in-process server as failed.
    if (!prebuiltProxies && hasInProcess && journal?.osSessionId) {
      registerRunToken(rpcToken, { sessionId: journal.osSessionId, user });
      rpcTokenRegistered = true;
    }

    entry = await ensureOpencodeServer(
      serverKey,
      shared ? SHARED_CWD : cwd,
      ocConfig,
      author,
      serverExtraEnv,
      { shared }
    );
    entry.rpcToken = rpcToken;
    if (serverExtraEnv?.MERIDIAN_API_KEY) entry.meridianKey = serverExtraEnv.MERIDIAN_API_KEY;
    entry.activeRuns++;
    entry.lastUsed = Date.now();
    // Registry must carry the token the config actually baked in (fresh spawns
    // record the placeholder minted before this reassignment).
    syncDetachedRecord(entry);
    if (entry.proc.detached) detachedRunKeys.add(runKey);

    // Watch the server process for the duration of this run: a mid-turn death
    // would otherwise leave the SSE pump reconnecting forever and the drain
    // loop blocked on `wake` — holding the session busy indefinitely.
    {
      const watched = entry;
      void watched.proc.exited.then((code) => {
        drainingServers.delete(watched);
        if (runEnded) return;
        turnFailure ??= classifyOpencodeTurnFailure(
          parsed.providerID,
          `opencode serve exited mid-run (code ${code}) — the turn was lost; send the prompt again to restart on a fresh server`,
        );
        if (journal?.osSessionId) {
          transitionRunState(journal.osSessionId, "engine_died", {
            source: "proc_exit",
            code,
          });
        }
        if (servers.get(serverKey) === watched) killServer(serverKey, watched, "died mid-run");
        failRun();
      });
    }
    const client = clientFor(entry);

    // Existing shared servers may have cached a failed proxy connection from
    // an earlier process boot. Reconnect this run's servers while its token is
    // registered so existing Desk sessions gain newly-added MCPs too.
    if (shared && rpcTokenRegistered) {
      const failed = await reconnectSharedInProcessMcp(
        client,
        Object.keys(opts.inProcessMcp || {}),
        q
      );
      if (failed.length) {
        console.warn(
          `[opencode-runner] failed to reconnect in-process MCP servers: ${failed.join(", ")}`
        );
      }
    }

    // Resolve/create the opencode session. Shared servers scope every call to
    // the run's directory (opencode's per-directory app instances).
    let createdFresh = false;
    // Kept for seeding: a model/account switch lands on a server whose SQLite
    // doesn't have this id, so the run starts a fresh engine session — the
    // prior session's persisted transcript is the only history carrier.
    const priorOcSessionId = ocSessionId;
    if (ocSessionId) {
      const existing = await client.session.get({ path: { id: ocSessionId }, ...q });
      if (!existing.data) {
        console.warn(`[opencode-runner] Session ${ocSessionId} not found — starting fresh`);
        ocSessionId = "";
      }
    }
    if (!ocSessionId) {
      const created = await client.session.create({
        body: { title: journal?.osSessionId ? `opensession ${journal.osSessionId}` : "opensession run" },
        ...q,
      });
      if (!created.data) throw new Error(`Failed to create opencode session: ${JSON.stringify(created.error ?? "")}`);
      ocSessionId = created.data.id;
      createdFresh = true;
    }
    if (!registeredKeys.has(ocSessionId)) {
      registeredKeys.add(ocSessionId);
      activeOpencodeRuns.set(ocSessionId, abortController);
    }
    // Sharded storage: remember which DB file this engine session lives in so
    // transcript readers / gap backfill can find it after the server is gone.
    if (entry.dbPath) recordOpencodeDbFor(ocSessionId, entry.dbPath);
    // Transcript v2: remember which unified session this engine session's
    // lines belong to (covers run start AND rotation — a rotation re-enters
    // here with the freshly-minted oc id), so the flag-gated store writes in
    // opencode-transcript.ts can resolve it. transcriptSessionId is the
    // map-only carrier for kind-only-journal loop runs (Linear passes
    // `linear-<branch>`); journaled runs keep using their osSessionId.
    const transcriptUnifiedId = journal?.osSessionId || opts.transcriptSessionId;
    if (transcriptUnifiedId) recordBksSessionFor(ocSessionId, transcriptUnifiedId);
    // A resumed session may carry a transcript-mirror gap (e.g. a turn that
    // ran orphaned after a restart — 2026-07-17: an hour of work invisible
    // until a manual backfill). Reconcile on EVERY resume, not just reattach.
    if (!createdFresh) {
      try {
        backfillOpencodeTranscriptGap(ocSessionId);
      } catch {}
    }
    // In-band steer for this run (see steerOpencodeRun): noReply message →
    // engine history → picked up at the turn's next step boundary. The user
    // line is mirrored into the transcript jsonl here because the SSE pump
    // only writes assistant/tool parts; a POST failure is audited and the
    // caller's steer receipt stays visible as the recovery affordance.
    const steerFn: OpencodeSteerFn = (text, images) => {
      void client.session
        .prompt({
          path: { id: ocSessionId },
          ...q,
          body: {
            noReply: true,
            parts: [{ type: "text", text }, ...(imageParts(images) as any[])],
          },
        })
        .then((sent: any) => {
          if (sent?.error) throw new Error(JSON.stringify(sent.error));
          turnEvent({ direction: "in", kind: "steer_injected", ...summarizeText(text) });
          appendOpencodeTranscript(ocSessionId, [
            transcriptLineUser(text, undefined, undefined, images),
          ]);
        })
        .catch((e: any) => {
          turnEvent({
            direction: "in",
            kind: "steer_inject_failed",
            error: String(e?.message || e).slice(0, 300),
          });
        });
    };
    for (const key of registeredKeys) activeOpencodeSteers.set(key, steerFn);
    // Shared servers: map this opencode session to its opensession session for
    // the run's duration, so proxied in-process tool calls (tagged with the
    // opencode session id by the session-tag plugin) route to THIS session's
    // in-process tools rather than whichever run registered the token last.
    if (shared && rpcTokenRegistered && journal?.osSessionId) {
      registerOcSessionContext(ocSessionId, {
        sessionId: journal.osSessionId,
        user,
        token: rpcToken,
      });
      ocSessionRegistered = ocSessionId;
    }

    // Front-load this run's transcript-v2 import. A fresh cross-engine handoff
    // may carry seed entries from the caller; a fresh session REPLACING a prior
    // OpenCode one (model/account shard switch, mid-turn rotation restart)
    // recovers through the canonical merged transcript reader below.
    let seedEntries = createdFresh ? opts.seedTranscriptEntries : undefined;
    // Prior-session recovery entries, tracked separately from seedEntries: an
    // opts.seedTranscriptEntries seed (cross-engine switch) already had its
    // handoff note prepended by the caller — only this path must add its own.
    let restartRecovered: typeof seedEntries;
    if (createdFresh && !seedEntries?.length && priorOcSessionId) {
      try {
        restartRecovered = await recoverFreshEngineTranscript({
          unifiedSessionId: transcriptUnifiedId,
          priorEngineSessionId: priorOcSessionId,
          currentEntryId: turn.userLine
            ? String(turn.userLine.uuid)
            : undefined,
        });
        if (restartRecovered.length) {
          seedEntries = restartRecovered;
        }
      } catch (e) {
        console.warn(
          `[opencode-runner] Failed to recover transcript for fresh session replacing ${priorOcSessionId}:`,
          e,
        );
      }
    }
    ensureOpencodeTranscriptFile(ocSessionId, seedEntries);
    // The seed above restores only the UI transcript; the replacement engine
    // session's model context is empty. Hand the model the recovered history
    // too — fenced, so it renders invisibly — or the turn starts amnesiac
    // while the UI history looks continuous (bks-019f818d, 2026-07-20).
    // Most retries redeliver the original prompt. The one exception is a
    // provider-declared successful stop with no usable text: repeating an
    // imperative such as "make a PR" can duplicate side effects, so its
    // bounded repair uses an explicit continuation prompt instead.
    const attemptPrompt = turn.repairPrompt || prompt;
    const enginePrompt = restartRecovered?.length
      ? `${wrapContext(
          buildEngineSwitchHandoffNote({
            fromProvider: "opencode",
            toProvider: "opencode",
            sameEngineRestart: true,
            entries: restartRecovered,
          }),
          "handoff"
        )}\n\n${attemptPrompt}`
      : attemptPrompt;
    // Injected below runOnModel's choke point (context-log.ts), so this
    // attempt's own handoff is logged here. Re-logging the blocks the choke
    // point already recorded is free: entry ids are content-derived.
    if (enginePrompt !== attemptPrompt) {
      logInjectedContext({
        sessionId: transcriptUnifiedId,
        turnId: opts.promptEntryId || opts.startToken,
        prompt: enginePrompt,
        model,
      });
    }
    // Account-rotation retries rerun this whole attempt with the same prompt —
    // appending the user line again gave one send two or three identical
    // bubbles (3× "FINISH ITTT", doubled resume prompts, 2026-07-09). But a
    // retry with no session to resume starts a FRESH engine session, whose
    // file must get the line too (bks-019f52bd) — so dedup on which session
    // file already has it, not on the attempt number.
    if (turn.promptWrittenTo !== ocSessionId) {
      // Reuse the turn's single user line (stable uuid): the early intake
      // persist above — and a retry's write into a prior session — carry the
      // same uuid, so the store upserts one row instead of duplicating.
      turn.userLine ??= transcriptLineUser(
        prompt,
        opts.promptEntryId,
        undefined,
        opts.images
      );
      appendOpencodeTranscript(ocSessionId, [turn.userLine]);
      turn.promptWrittenTo = ocSessionId;
    }
    // Rotation notices queued by failed attempts ("usage limit hit on X;
    // switched to Y") persist as system lines here, in whichever file this
    // retry actually writes to — as stream-only text they vanished on reload.
    if (turn.notes.length) {
      appendOpencodeTranscript(
        ocSessionId,
        turn.notes.map((n) => transcriptLineRunnerNotice(n))
      );
      turn.notes.length = 0;
    }

    // Kind-only journals ({kind} with no osSessionId — the Plain/Linear/Slack
    // agent loops) are a gate/policy marker, not a crash journal: those loops
    // track their own engine session ids and redeliver on their own triggers,
    // and a generic headless resume could DUPLICATE side effects they never
    // had (e.g. re-creating a Linear issue). Only UI-owned runs journal.
    if (journal?.osSessionId) {
      journalSet(
        buildRunJournalRecord(opts, {
          runKey,
          osSessionId: journal.osSessionId,
          claudeSessionId: ocSessionId,
          // Reattach needs the hosting server: detached servers survive the
          // restart, and resume looks the adopted entry up by this key.
          serverKey,
          prompt,
          promptEntryId: turn.userLine ? String(turn.userLine.uuid) : undefined,
          cwd,
          mode,
          mcpServers,
          user,
          confirmTools,
          model,
          effort,
          fastMode: opts.fastMode,
          kind: journal.kind,
        })
      );
    }

    turnEvent({
      direction: "in",
      kind: "user_prompt",
      cwd,
      mcp_servers: mcpServers,
      // >0 = account-rotation redelivery of the same prompt, not a new send.
      ...(attemptIndex > 0 ? { retry_attempt: attemptIndex } : {}),
      // Shared always-warm pool visibility: which server this run multiplexed
      // onto (account × user tuple), for debugging cross-session issues.
      ...(shared ? { shared_server: serverKey } : {}),
      // Least-privilege visibility: the claude-style names whose opencode ids
      // were stripped from this run's tool list (unattended runs only).
      ...(policy.unattended
        ? { denied_tools: policy.noteGroups.flatMap((g) => g.tools) }
        : {}),
      ...summarizeText(attemptPrompt),
    });
    yield { type: "init", sessionId: ocSessionId, provider: PROVIDER, model };

    if (abortController.signal.aborted) return;

    // Abort → tell the server to stop the turn (best-effort), our loops exit
    // on the signal. Also wake the drain loop directly (failRun → signalDone):
    // waiting for the engine's abort to come back as an SSE/poll observation
    // left cancelled runs parked forever when both were wedged (zombie run,
    // 2026-07-09 bks-019f488c). Install this only after readiness: aborting an
    // idle OpenCode session latches the abort onto its next prompt.
    abortController.signal.addEventListener("abort", () => {
      void client.session.abort({ path: { id: ocSessionId }, ...q }).catch(() => {});
      failRun();
    });

    // ── Event pump: SSE → StreamEvents, with reconnect (Bun's fetch aborts
    // responses idle >300s; quiet stretches during long tool calls hit that).
    const pending: StreamEvent[] = [];
    let wake: (() => void) | null = null;
    let idle = false; // session went idle = turn finished
    let sessionError: string | undefined;
    // Last engine-session abort WE issued this attempt (liveness guard, usage-
    // limit fast-fail, turn deadline). A rotation/respawn retry re-prompts the
    // SAME engine session, so the retry must wait for this to land first — an
    // unawaited abort arriving after the retry's turn starts kills it ~100ms in
    // (MessageAbortedError) and the turn ends as an empty phantom success
    // (2026-07-16 bks-019f6c33).
    let engineAbortInFlight: Promise<unknown> | null = null;
    const emittedText = new Set<string>();
    // Assistant messages flagged as autocompact summaries (message.updated
    // fires on creation, before their text parts complete) — their text
    // becomes a "context compacted" system chip, not assistant output.
    const compactionMsgs = new Set<string>();
    // Messages the engine called the assistant's, which is what lets one of
    // their text deltas reach the bubble (see mirrorTextDelta).
    const assistantMsgs = new Set<string>();
    // Silent context rebuilds under the engine (Agent SDK autocompaction /
    // Meridian replay) — invisible to opencode, so we detect them from the
    // per-step prompt-cache numbers and leave a durable line in the transcript.
    const watchContextRebuild = makeContextRebuildWatcher({
      ocSessionId,
      model,
      turnEvent,
      onDetected: (notice) =>
        appendOpencodeTranscript(ocSessionId, [transcriptLineRunnerNotice(notice)]),
    });
    const startedTools = new Set<string>();
    const finishedTools = new Set<string>();
    let sawFirstOutput = false;
    const stallGuard = makeSubagentStallGuard(ocSessionId, (info) => {
      if (idle || turnFailure || abortController.signal.aborted) return;
      if (info.kind === "tool") {
        // A hung tool call, not a wedged bridge: the account and server are
        // healthy, so take the turn-deadline lane — clear error, durable
        // notice, abort — with no account sideline and no respawn-retry
        // (a retry would just re-run the same hang on a second account).
        const label = info.openToolLabels.join("; ") || "unknown tool";
        turnFailure = classifyOpencodeTurnFailure(
          parsed.providerID,
          toolStallError(label, info.quietMs),
        );
        appendOpencodeTranscript(ocSessionId, [
          transcriptLineRunnerNotice(toolStallNotice(label, info.quietMs)),
        ]);
        failureNoticePersisted = true;
        turnEvent({
          direction: "out",
          kind: "tool_stall",
          tool_name: label.slice(0, 200),
          quiet_ms: info.quietMs,
        });
        engineAbortInFlight = client.session
          .abort({ path: { id: ocSessionId }, ...q })
          .catch(() => {});
        signalDone();
        return;
      }
      // Same recovery lane as the 90s guard: the failure kind drives the shared
      // server drain-respawn + one automatic retry that re-prompts the session.
      const message =
        info.kind === "request"
          ? `opencode turn produced no output for ${Math.round(info.quietMs / 60_000)} min ` +
            `on account "${bridgeAccountLabel()}" with no tool running — the provider request ` +
            "died without surfacing an error (wedged bridge or silent retry backoff); aborting"
          : `opencode task subagent produced no output for ${Math.round(info.quietMs / 60_000)} min ` +
            `on account "${bridgeAccountLabel()}" — the engine bridge wedged mid-turn ` +
            "(new requests hang while established streams keep flowing); aborting";
      turnFailure = classifyOpencodeTurnFailure(
        parsed.providerID,
        message,
        "liveness_wedge",
      );
      turnEvent({
        direction: "out",
        kind: info.kind === "request" ? "request_stall" : "subagent_stall",
        tool_use_id: info.openTaskIds.join(","),
        quiet_ms: info.quietMs,
      });
      engineAbortInFlight = client.session
        .abort({ path: { id: ocSessionId }, ...q })
        .catch(() => {});
      signalDone();
    });
    // Consecutive provider retries with no output between them (PROVIDER_STALL_MS).
    let providerRetryStreak = 0;
    let providerRetryStreakAt = 0;
    // True while every retry in the current streak is a Meridian upstream-idle
    // kill — the wedged-daemon signature that fires the stall backstop early.
    let providerStreakUpstreamIdleOnly = true;
    // One transcript notice per turn, not per streak — retries are noisy.
    let providerStallNoticed = false;
    const push = (ev: StreamEvent) => {
      sawFirstOutput = true;
      providerRetryStreak = 0;
      pending.push(ev);
      wake?.();
    };
    const signalDone = () => {
      idle = true;
      wake?.();
    };
    failRun = signalDone;
    const { mirrorTextPart, mirrorTextDelta, mirrorToolPart, textStream } = makePartMirror({
      ocSessionId,
      model,
      turnEvent,
      push,
      steerFn,
      emittedText,
      compactionMsgs,
      assistantMsgs,
      startedTools,
      finishedTools,
    });

    // opencode retries provider stream errors internally (exponential backoff,
    // silent from the outside) — RetryPart / session.status "retry" events are
    // the only in-turn visibility. Record the error for the liveness guard's
    // message, and fail FAST on a Claude usage limit: retrying the same capped
    // account can never succeed, so waiting out the 90s guard (with a
    // misleading "authentication hang" message) just burns the user's time.
    const noteProviderRetry = (attempt: number, message: string) => {
      if (!message) return;
      lastProviderRetryError = message;
      turnEvent({
        direction: "out",
        kind: "provider_retry",
        retry_attempt: attempt,
        error: message.slice(0, 500),
      });
      const subIssue = isClaudeSubscriptionError(message);
      if (
        parsed.providerID === "anthropic" &&
        bridgeAccount?.kind === "meridian" &&
        !turnFailure &&
        (isClaudeUsageLimitError(message, true) || subIssue)
      ) {
        // Both faults are account-level and dead on retry: opencode would keep
        // retrying the same capped/subscription-broken account until the 90s
        // liveness guard, burning the turn. Sideline + rotate immediately via
        // the usage-limit machinery (the failure kind drives markExhausted and the
        // account rotation downstream). Landing elsewhere in the pool is the
        // only thing that recovers a subscription-broken account.
        turnFailure = classifyOpencodeTurnFailure(
          parsed.providerID,
          `${subIssue ? "Claude subscription issue" : "Claude usage limit"} on account ` +
            `"${bridgeAccountLabel()}": ${message.slice(0, 300)}`,
          "usage_limit",
        );
        engineAbortInFlight = client.session
          .abort({ path: { id: ocSessionId }, ...q })
          .catch(() => {});
        signalDone();
      }
      // The bridge couldn't spawn Claude Code for this run at all. Retrying the
      // same wedged proxy is what burns the turn (2026-08-01/03: 13 backoff
      // retries over ~2h16m, then three idle hours to the wall-clock cap), so
      // take the wedge lane on the FIRST one: brief sideline, drain-respawn,
      // one bounded retry — possibly on another account. Deliberately NOT the
      // usage-limit lane: the accounts this hit were healthy and in heavy use
      // elsewhere at the time, so an hours-long sideline would punish a good
      // account for what is a spawn-time failure on this box.
      if (
        bridgeAccount?.kind === "meridian" &&
        !turnFailure &&
        isClaudeBridgeLaunchError(message)
      ) {
        turnFailure = classifyOpencodeTurnFailure(
          parsed.providerID,
          `opencode could not launch Claude Code on account "${bridgeAccountLabel()}": ` +
            `${message.slice(0, 300)}`,
          "liveness_wedge",
        );
        engineAbortInFlight = client.session
          .abort({ path: { id: ocSessionId }, ...q })
          .catch(() => {});
        signalDone();
      }
      // Same fail-fast for the openai side (2026-07-17: six "usage limit
      // reached" retries burned the full 90s guard before dying mislabeled) —
      // the failure kind drives markCodexExhausted + codex-account rotation
      // downstream.
      if (
        parsed.providerID === "openai" &&
        bridgeAccount?.kind === "openai" &&
        !turnFailure &&
        isCodexUsageLimitError(message)
      ) {
        turnFailure = classifyOpencodeTurnFailure(
          parsed.providerID,
          `OpenAI usage limit on codex account "${bridgeAccountLabel()}": ${message.slice(0, 300)}`,
          "usage_limit",
        );
        engineAbortInFlight = client.session
          .abort({ path: { id: ocSessionId }, ...q })
          .catch(() => {});
        signalDone();
      }
      if (
        parsed.providerID === "openai" &&
        !turnFailure &&
        /(?:our )?servers? (?:are )?(?:currently )?overloaded|overloaded_error/i.test(message)
      ) {
        turnFailure = classifyOpencodeTurnFailure(
          parsed.providerID,
          `OpenAI provider overloaded on account "${bridgeAccountLabel()}": ${message.slice(0, 300)}`,
          "provider_overloaded",
        );
        engineAbortInFlight = client.session
          .abort({ path: { id: ocSessionId }, ...q })
          .catch(() => {});
        signalDone();
      }
      // Third-party providers have no account pool to rotate through. Abort a
      // Cerebras quota rejection immediately instead of leaving the UI silent
      // while OpenCode performs several minute-spaced retries. Marking this as
      // exhausted also lets the normal model fallback policy keep the session
      // responsive when a prompt still cannot fit its account tier.
      if (
        parsed.providerID === "cerebras" &&
        !turnFailure &&
        /(?:too many requests|tokens per minute|rate limit)/i.test(message)
      ) {
        turnFailure = classifyOpencodeTurnFailure(
          parsed.providerID,
          `Cerebras rate limit: ${message.slice(0, 300)}`,
          "usage_limit",
        );
        engineAbortInFlight = client.session
          .abort({ path: { id: ocSessionId }, ...q })
          .catch(() => {});
        signalDone();
      }
      // Generic stall backstop for every provider the branches above didn't
      // classify (PROVIDER_STALL_MS): retries piling up with nothing streamed
      // between them means the turn is going nowhere, so end it in the wedge
      // lane rather than letting it idle out the wall-clock deadline. Checked
      // last so a classified fault keeps its own, more specific message.
      if (providerRetryStreak === 0) {
        providerRetryStreakAt = Date.now();
        providerStreakUpstreamIdleOnly = true;
      }
      providerRetryStreak++;
      if (!isUpstreamIdleStallError(message)) providerStreakUpstreamIdleOnly = false;
      // Make the streak visible in the session transcript once it's clearly
      // not a one-off blip (attempt-1 retries are ~daily background noise;
      // second-in-a-row is rare). Without this the session shows nothing at
      // all while opencode's backoff grows — 25 min of dead air until the
      // human asked "are you still good?" (2026-08-03 bks-019fc819).
      if (providerRetryStreak === 2 && !providerStallNoticed && !turnFailure) {
        providerStallNoticed = true;
        appendOpencodeTranscript(ocSessionId, [
          transcriptLineRunnerNotice(
            `Provider stream is stalling on account "${bridgeAccountLabel()}" — the engine is retrying ` +
              `(${message.slice(0, 160)}). If it keeps making no progress the run auto-respawns the ` +
              `engine and retries.`
          ),
        ]);
      }
      maybeFailProviderStall(message);
    };
    // The stall verdict, callable from a retry event AND from the timer below.
    // Event-driven checking alone is outrunnable: opencode's retry backoff
    // grows past the stall window, so the streak can sit one-retry-short of
    // the threshold forever (2026-08-03 bks-019fc819: 3rd retry landed at
    // 13.5 min — 90s under the window — and the 4th was still pending when
    // the human gave up at 25 min; the guard never fired).
    const maybeFailProviderStall = (message: string) => {
      if (!PROVIDER_STALL_MS || turnFailure || idle || abortController.signal.aborted) return;
      if (providerRetryStreak === 0) return;
      const stalledMs = Date.now() - providerRetryStreakAt;
      // Upstream-idle streaks get a lower bar: each such retry is already 90s+
      // of measured silence on a fresh request into the same wedged daemon
      // (see isUpstreamIdleStallError) — waiting the full window just delays
      // the respawn that actually fixes it.
      const minRetries = providerStreakUpstreamIdleOnly
        ? Math.max(2, PROVIDER_STALL_MIN_RETRIES - 1)
        : PROVIDER_STALL_MIN_RETRIES;
      const windowMs = providerStreakUpstreamIdleOnly ? PROVIDER_STALL_MS / 2 : PROVIDER_STALL_MS;
      if (providerRetryStreak < minRetries || stalledMs < windowMs) return;
      turnFailure = classifyOpencodeTurnFailure(
        parsed.providerID,
        `opencode ${parsed.providerID} run made no progress for ${Math.round(stalledMs / 60_000)} min ` +
          `on account "${bridgeAccountLabel()}": ${providerRetryStreak} provider retries with no output ` +
          `in between (last: ${message.slice(0, 200)}); aborting`,
        "liveness_wedge",
      );
      turnEvent({
        direction: "out",
        kind: "provider_stall",
        retry_attempt: providerRetryStreak,
        quiet_ms: stalledMs,
        error: message.slice(0, 200),
      });
      engineAbortInFlight = client.session
        .abort({ path: { id: ocSessionId }, ...q })
        .catch(() => {});
      signalDone();
    };
    const providerStallPoll = PROVIDER_STALL_MS
      ? setInterval(() => maybeFailProviderStall(lastProviderRetryError || ""), 30_000)
      : undefined;

    // ── Permission-ask bridge ────────────────────────────────────────────────
    // An unanswered permission ask blocks its tool call forever while the
    // session stays engine-busy — the status poll (correctly) never ends the
    // turn, so every ask MUST get a reply (the 2026-07-10 staged-PDF wedge).
    // Policy: unattended runs auto-reject (no human present, untrusted input;
    // their real permissions are config-level). Interactive runs auto-approve
    // external_directory (reading files on our own box — code mode config-
    // allows it outright, this covers ask mode attachments and config drift)
    // and surface every other ask on the session's question card via
    // onAskUser (UI card + push + Slack escalation — the AskUserQuestion
    // pipeline); no answer ⇒ reject. Deduped because the SSE pump and the
    // poll sweep can both see the same ask; surfaced asks are serialized so a
    // session shows one card at a time (pendingAsks holds one per session).
    // Machinery lives in makeOpencodePermissionBridge (shared with reattach).
    const handlePermissionAsk = makeOpencodePermissionBridge({
      client,
      entry: entry!,
      ocSessionId,
      q,
      unattended: policy.unattended,
      gated: bashGated,
      sessionId: journal?.osSessionId,
      runKind: journal?.kind,
      onAskUser: opts.onAskUser,
      turnEvent,
      noteAskPending: (delta) => stallGuard.noteAskPending(delta),
    });

    const handleEvent = async (ev: any) => {
      const p = ev?.properties;
      stallGuard.noteEvent(ev);
      switch (ev?.type) {
        case "message.part.delta": {
          // The engine's token stream (see mirrorTextDelta).
          if (p?.sessionID !== ocSessionId) return;
          mirrorTextDelta(p);
          return;
        }
        case "message.part.updated": {
          const part = p?.part;
          if (!part) return;
          if (part.type === "retry") {
            // Family-wide, not parent-only: while a task tool is open the
            // parent is blocked on its child, so a child's provider retries
            // ARE the parent turn's stall — parent-only filtering left both
            // stall guards blind to 25 min of wedged @oracle-fable retries
            // (2026-08-03 bks-019fc798).
            if (stallGuard.isFamily(part.sessionID)) {
              noteProviderRetry(
                Number(part.attempt) || 0,
                String(part.error?.data?.message || part.error?.name || "")
              );
            }
            return;
          }
          if (part.sessionID !== ocSessionId) return;
          if (part.type === "tool") stallGuard.noteTool(part);
          mirrorTextPart(part);
          if (part.type === "reasoning" && part.time?.end && !emittedText.has(part.id)) {
            emittedText.add(part.id);
            turnEvent({ direction: "out", kind: "assistant_thinking", ...summarizeText(part.text) });
          }
          mirrorToolPart(part);
          return;
        }
        case "message.updated": {
          const info = p?.info;
          if (info?.sessionID !== ocSessionId) return;
          // What makes this message's text deltas eligible to reach the
          // bubble; the delta feed itself carries no role.
          if (info.role === "assistant") assistantMsgs.add(info.id);
          if (isCompactionMessageInfo(info)) compactionMsgs.add(info.id);
          else watchContextRebuild(info);
          return;
        }
        // opencode renamed this event: pre-1.17 servers emit
        // "permission.updated", 1.17+ emits "permission.asked" (the npm SDK's
        // types still say "updated" — trust the wire, not the types; the
        // mismatch is exactly how the reject backstop silently died and a
        // staged-PDF read wedged a session for 40 min on 2026-07-10).
        case "permission.updated":
        case "permission.asked":
        case "permission.v2.asked": {
          if (p?.sessionID !== ocSessionId) return;
          // Fire-and-forget: a surfaced ask waits minutes for a human —
          // awaiting here would stall the whole SSE pump.
          handlePermissionAsk(p, "sse");
          return;
        }
        case "session.error": {
          if (p?.sessionID && p.sessionID !== ocSessionId) return;
          const err = p?.error;
          sessionError = err?.data?.message || err?.name || "opencode session error";
          return;
        }
        case "session.status": {
          // Belt-and-braces sibling of the RetryPart handler (older/newer
          // servers may emit one or both shapes). Family-wide for the same
          // reason as the retry-part path: a task child's retries are the
          // parent turn's stall.
          if (!stallGuard.isFamily(p?.sessionID)) return;
          const st = p?.status;
          if (st?.type === "retry") {
            noteProviderRetry(Number(st.attempt) || 0, String(st.message || ""));
          }
          return;
        }
        case "session.idle": {
          if (p?.sessionID === ocSessionId) signalDone();
          return;
        }
      }
    };

    let pumpStopped = false;
    // Shared servers: the event stream is DIRECTORY-scoped (verified live
    // 2026-07-09 — a global subscribe sees only lifecycle events), so
    // subscribe to this run's directory instance.
    const pump = runSseEventPump({
      client,
      query: dirQuery ? { query: dirQuery } : undefined,
      handleEvent,
      stopped: () => pumpStopped || abortController.signal.aborted,
      idle: () => idle,
    });

    // Fire the prompt without holding an HTTP response open for the whole
    // turn (prompt_async returns 204 immediately; completion arrives as
    // session.idle — with a status poll as the SSE-gap fallback).
    const sent = await client.session.promptAsync({
      path: { id: ocSessionId },
      ...q,
      body: {
        model: parsed,
        variant: (() => {
          const normalizedEffort = normalizeModelEffort(model, effort);
          return openaiPromptVariant(
            normalizedEffort,
            !!opts.fastMode && bridgeAccount?.kind === "openai",
          );
        })(),
        // Shared servers: session context (`system` appends to opencode's own
        // system prompt), read-only agent selection, and this run's tool
        // strips all ride the prompt — per-session servers carry them in
        // their config instead.
        ...(shared && instructions ? { system: instructions } : {}),
        ...(promptAgent ? { agent: promptAgent } : {}),
        ...(Object.keys(promptTools).length ? { tools: promptTools } : {}),
        parts: [{ type: "text", text: enginePrompt }, ...(imageParts(opts.images) as any[])],
      } as any,
    });
    if (sent.error) {
      throw new Error(`opencode prompt failed: ${JSON.stringify(sent.error)}`);
    }
    const sentAt = Date.now();

    // Hard per-turn wall-clock deadline (default 60 min, turnTimeoutMinutes in
    // ~/.opensession-opencode.json): a turn that never goes idle — model loop,
    // server wedge the exit watcher can't see — ends with a clear error
    // instead of holding the session busy forever.
    const turnTimeout = opencodeTurnTimeoutMs();
    const turnDeadline = setTimeout(() => {
      if (!turnFailure) {
        turnFailure = classifyOpencodeTurnFailure(
          parsed.providerID,
          turnTimeoutError(turnTimeout),
        );
        // Persist the cutoff as a durable system line: without one the
        // transcript just ends mid-tool-call and the reader can't tell why
        // (bks-019f7911 died silently after a 60-min build-out, 2026-07-19).
        appendOpencodeTranscript(ocSessionId, [
          transcriptLineRunnerNotice(turnTimeoutNotice(turnTimeout)),
        ]);
        failureNoticePersisted = true;
      }
      engineAbortInFlight = client.session
        .abort({ path: { id: ocSessionId }, ...q })
        .catch(() => {});
      signalDone();
    }, turnTimeout);

    // Liveness guard (subscription-bridge runs only): an auth hang produces no
    // output at all, and the 60-min turn deadline is uselessly long for it. If
    // nothing has streamed within LIVENESS_MS, abort with a clear error naming
    // the account, rather than holding the session busy for an hour.
    const LIVENESS_MS = 90_000;
    const livenessTimer = bridgeAccount?.livenessGuard
      ? setTimeout(() => {
          if (sawFirstOutput || idle || abortController.signal.aborted) return;
          // Name the real cause when the provider told us (captured retry
          // errors) instead of guessing "authentication hang". Match with the
          // run's OWN provider's error shape — the Claude matcher missed
          // OpenAI's "The usage limit has been reached", so codex exhaustion
          // was mislabeled transient and never rotated accounts (2026-07-17).
          const limitMatcher =
            parsed.providerID === "openai" ? isCodexUsageLimitError : (m: string) => isClaudeUsageLimitError(m, true);
          const message = lastProviderRetryError
            ? `opencode ${parsed.providerID} run produced no output within ${LIVENESS_MS / 1000}s — ` +
              `the provider kept retrying on account "${bridgeAccountLabel()}": ` +
              `${lastProviderRetryError.slice(0, 300)}; aborting`
            : `opencode ${parsed.providerID} run produced no output within ${LIVENESS_MS / 1000}s — ` +
              `the engine bridge on account "${bridgeAccountLabel()}" went silent (wedged proxy or auth hang); aborting`;
          turnFailure ??= classifyOpencodeTurnFailure(
            parsed.providerID,
            message,
            lastProviderRetryError && limitMatcher(lastProviderRetryError)
              ? "usage_limit"
              : !lastProviderRetryError
                ? "liveness_wedge"
                : undefined,
          );
          engineAbortInFlight = client.session
            .abort({ path: { id: ocSessionId }, ...q })
            .catch(() => {});
          signalDone();
        }, LIVENESS_MS)
      : undefined;
    // Mid-turn sibling of the guard above: catches a task subagent whose
    // provider request wedged AFTER the parent stream came up (bridge runs
    // only, same as LIVENESS_MS — API-key runs don't ride a Meridian proxy).
    // Armed for every run, not just bridge runs: the tool-stall lane has
    // nothing to do with bridge auth (os-019fd67b hung on a bash pipe), and
    // the task lane's wedge recovery degrades gracefully without a picked
    // bridge account (no sideline, still drain-respawn + one retry).
    stallGuard.start();

    let statusPollFailures = 0;
    let statusPollStreakStart = 0;
    let zombieProbeInFlight = false;
    const statusPoll = setInterval(() => {
      void (async () => {
        try {
          if (!entry || idle) return;
          // Grace: right after send the status map may not list the session
          // as busy yet — only trust absent/idle once the turn is clearly on.
          if (Date.now() - sentAt < 15_000) return;
          const res = await clientFor(entry).session.status({ ...q });
          const statuses = res.data as Record<string, { type?: string }> | undefined;
          statusPollFailures = 0;
          const mine = statuses?.[ocSessionId];
          // Absent or idle ⇒ the turn ended (covers an SSE gap that ate the
          // idle event).
          if (!mine || mine.type === "idle") {
            signalDone();
            return;
          }
          // Busy ⇒ belt + braces on permission asks: one that slipped past the
          // SSE pump (reconnect gap, another event rename upstream) blocks its
          // tool forever with the session held busy — exactly the state this
          // poll can't otherwise distinguish from honest work. Sweep pending
          // asks into the same policy bridge (deduped, so an ask the pump
          // already surfaced isn't double-asked). Older servers 404 the
          // endpoint; any failure = "nothing pending".
          try {
            const pr = await fetch(`${entry.url}/permission`, {
              headers: { Authorization: `Basic ${btoa(`opencode:${entry.password}`)}` },
              signal: AbortSignal.timeout(5000),
            });
            if (pr.ok) {
              const asks = (await pr.json()) as Array<{ id?: string; sessionID?: string }>;
              for (const ask of Array.isArray(asks) ? asks : []) {
                if (ask?.sessionID === ocSessionId) handlePermissionAsk(ask, "poll");
              }
            }
          } catch {}
        } catch (e) {
          // A silently-failing poll is how a finished/aborted engine turn
          // becomes a forever-busy zombie run. Make it loud; after ~60s of
          // consecutive failures let zombiePollVerdict decide between a dead
          // server (end the turn) and one merely starved by host load (keep
          // watching — the turn is usually still running and completes once
          // the spike passes).
          statusPollFailures++;
          if (statusPollFailures === 1) statusPollStreakStart = Date.now();
          if (statusPollFailures === 1 || statusPollFailures % 6 === 0) {
            console.warn(
              `[opencode-runner] status poll failing for ${ocSessionId} (${statusPollFailures}x): ${e}`
            );
          }
          if (statusPollFailures >= 6 && entry && !zombieProbeInFlight) {
            zombieProbeInFlight = true;
            try {
              const verdict = await zombiePollVerdict(entry.url, entry.password, statusPollStreakStart);
              if (idle || abortController.signal.aborted) return;
              if (verdict === "starved") {
                console.warn(
                  `[opencode-runner] server for ${ocSessionId} is alive but starved ` +
                    `(${statusPollFailures} failed polls) — keeping the turn`
                );
                return;
              }
              turnFailure ??= classifyOpencodeTurnFailure(
                parsed.providerID,
                zombiePollFailureMessage(verdict),
              );
              if (journal?.osSessionId) {
                transitionRunState(journal.osSessionId, "engine_died", {
                  source: "status_poll_zombie",
                  failures: statusPollFailures,
                  verdict,
                });
              }
              signalDone();
            } finally {
              zombieProbeInFlight = false;
            }
          }
        }
      })();
    }, 10_000);

    try {
      // Drain mapped events until the session goes idle (or abort/error).
      for (;;) {
        while (pending.length) yield pending.shift()!;
        if (abortController.signal.aborted) return;
        if (idle) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      while (pending.length) yield pending.shift()!;
    } finally {
      clearInterval(statusPoll);
      clearTimeout(turnDeadline);
      if (livenessTimer) clearTimeout(livenessTimer);
      if (providerStallPoll) clearInterval(providerStallPoll);
      stallGuard.stop();
      pumpStopped = true;
      void pump.catch(() => {});
    }

    // Server died or the turn deadline hit — surface the clean error (the
    // final-message fetch below would just throw a raw fetch error on a dead
    // server) and let the finally cleanup release the session.
    if (turnFailure) {
      reachedTerminal = true;
      let failure = turnFailure;
      // Fence any abort we fired before a rotation/respawn retry re-prompts
      // the same engine session — a stale abort landing after the retry's turn
      // starts kills it instantly. Bounded so a hung server can't stall the
      // retry indefinitely.
      if (engineAbortInFlight) {
        await Promise.race([
          engineAbortInFlight,
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        engineAbortInFlight = null;
      }
      // Claude usage limit on the meridian account: sideline it (model-scoped
      // for credit-metered models like Fable — see markExhausted) and, when
      // another eligible account exists, ask the wrapper for one retry on it
      // instead of failing the turn. No account left ⇒ terminal error with
      // usageLimitExhausted so agent-runner's model fallback takes over.
      if (failure.kind === "usage_limit" && bridgeAccount?.kind === "meridian") {
        {
          const account = bridgeAccount.account;
          const failureDetail = (lastProviderRetryError || failure.message).toLowerCase();
          const exhaustedModel =
            meridianModels.find(
              (required) =>
                required !== parsed.modelID &&
                failureDetail.includes(
                  required.replace(/^claude-/, "").replace(/-\d+$/, "")
                )
            ) || parsed.modelID;
          markExhausted(account.id, exhaustedModel);
          if (rotation) {
            const repickNext = () => {
              const p = pickMeridianAccount(
                user,
                meridianModels,
                readOpencodeBridgeConfig()?.bridgeAccountIds,
                opts.accountId,
                opts.accountStrict,
                undefined,
                undefined,
                true,
                opts.usageCredits,
              );
              return "error" in p ? null : p;
            };
            let next: ClaudeAccount | null = repickNext();
            if (!next) {
              // Whole pool capped mid-run: unattended runs queue for the pool
              // to free (same backpressure as the pick-time branch) so the turn
              // retries on a fresh account instead of dying with the cascade.
              const waitMs = poolWaitMsFor(journal?.kind);
              if (waitMs > 0) {
                next = await waitForUsableAccount({
                  pick: repickNext,
                  user,
                  model: meridianModels,
                  maxWaitMs: waitMs,
                  signal: abortController.signal,
                  accountId: opts.accountStrict ? opts.accountId : undefined,
                  allowExtraUsage: opts.usageCredits,
                  allowedAccountIds: readOpencodeBridgeConfig()?.bridgeAccountIds,
                  onWaitStart: (earliestReset) => {
                    audit({
                      msg: "account_pool_wait",
                      run_kind: journal?.kind,
                      session_id: journal?.osSessionId,
                      model,
                      reason: "mid-run usage limit; pool dry",
                      earliest_reset: new Date(earliestReset).toISOString(),
                      max_wait_ms: waitMs,
                    });
                    console.warn(
                      `[opencode-runner] mid-run usage limit and pool dry for ${model} — ` +
                        `waiting up to ${Math.round(waitMs / 60000)}m before retrying`,
                    );
                  },
                });
              }
            }
            if (abortController.signal.aborted || opts.shouldCancel?.()) return;
            if (next && !abortController.signal.aborted && !opts.shouldCancel?.()) {
              turnEvent({ direction: "out", kind: "account_switch", account: next.name });
              bridgeRunEnd("error", failure.message);
              rotation.rotate = true;
              rotation.note =
                `Usage limit on "${account.name}" ` +
                `(${parsed.modelID}); switched to "${next.name}".`;
              return;
            }
          }
          failure = {
            ...failure,
            message:
              failure.message +
              " — no other account is currently usable for this model; use /model to switch models.",
          };
          turnFailure = failure;
        }
      }
      // OpenAI usage limit on the codex account: same treatment as the
      // meridian branch above — sideline it (markCodexExhausted was previously
      // never called by ANYTHING, so the picker kept handing out exhausted
      // accounts, 2026-07-17) and rotate to another codex account when one
      // exists; the rotation rerun re-picks at bind time, which now skips the
      // sidelined account. No account left ⇒ terminal with usageLimitExhausted
      // so agent-runner's model fallback takes over.
      if (failure.kind === "usage_limit" && bridgeAccount?.kind === "openai") {
        {
          const account = bridgeAccount.account;
          markCodexExhausted(account.id, parsed.modelID);
          const next = pickOpenaiAccount(
            parsed.modelID,
            readOpencodeBridgeConfig()?.openaiAccounts,
            sessionKey,
            undefined,
            user,
            opts.accountId,
            opts.accountStrict,
          );
          if (rotation && !("error" in next) && next.id !== account.id) {
            turnEvent({ direction: "out", kind: "account_switch", account: next.name });
            bridgeRunEnd("error", failure.message);
            rotation.rotate = true;
            rotation.note =
              `Usage limit on "${account.name}" ` +
              `(${parsed.modelID}); switched to "${next.name}".`;
            return;
          }
          failure = {
            ...failure,
            message:
              failure.message +
              " — no other codex account is currently usable; use /model to switch models.",
          };
          turnFailure = failure;
        }
      }
      // A liveness wedge is account-scoped — the bridge proxy hangs every NEW
      // provider request while established streams keep flowing — so a retry
      // of ANY model through the same account burns another full 90s timeout
      // (2026-07-27: one review ate five consecutive wedged attempts, sol AND
      // the terra fallback, all on one wedged account). Sideline the account
      // briefly so this run's retry, the fallback tiers after it, and every
      // OTHER session's pick land elsewhere; rolled back when no alternative
      // exists for this run — a same-account respawn retry beats a dry pool,
      // and wedges often clear with a fresh proxy. Deliberately NOT bounded to
      // attemptIndex 0: a second wedge still marks the account for the rest of
      // the pool even though this run won't retry again.
      let wedgeSwitchTo: string | undefined;
      if (failure.kind === "liveness_wedge") {
        if (bridgeAccount?.kind === "openai") {
          const account = bridgeAccount.account;
          const marked = markCodexWedged(account.id);
          const next = pickOpenaiAccount(
            parsed.modelID,
            readOpencodeBridgeConfig()?.openaiAccounts,
            sessionKey,
            undefined,
            user,
            opts.accountId,
            opts.accountStrict,
          );
          if ("error" in next || next.id === account.id) {
            if (marked) clearCodexWedge(account.id);
          } else {
            wedgeSwitchTo = next.name;
          }
        } else if (bridgeAccount?.kind === "meridian") {
          const account = bridgeAccount.account;
          const marked = markWedged(account.id);
          const next = pickMeridianAccount(
            user,
            meridianModels,
            readOpencodeBridgeConfig()?.bridgeAccountIds,
            opts.accountId,
            opts.accountStrict,
            undefined,
            undefined,
            true,
            opts.usageCredits,
          );
          if ("error" in next || next.id === account.id) {
            if (marked) clearWedge(account.id);
          } else {
            wedgeSwitchTo = next.name;
          }
        }
        if (wedgeSwitchTo) {
          turnEvent({ direction: "out", kind: "account_switch", account: wedgeSwitchTo });
        }
      }
      // Transient infra failure — recover instead of failing the turn. Covers
      // the silent liveness wedge (the Meridian proxy's first post-boot request
      // works, later ones hang forever) plus server death, network blips, 5xx
      // and SQLite write contention (isTransientRunError). Ordinary transient
      // errors retain one retry. Account wedges may walk two replacement
      // accounts because each failed account was sidelined above, while a dry
      // pool retains one same-account respawn. All paths stay bounded.
      const transientFailure =
        failure.kind !== "usage_limit" &&
        (failure.kind === "liveness_wedge" || isTransientRunError(failure.message));
      const retryTransient =
        transientFailure &&
        rotation &&
        shouldRetryTransientRun({
          failure,
          hasAlternativeAccount: !!wedgeSwitchTo,
          attemptIndex,
          wedgeRetries: turn.wedgeRetries,
        });
      if (retryTransient) {
        // A wedged per-session server is unrecoverable for this session — kill
        // it so the retry cold-boots a fresh proxy instead of hanging again. A
        // wedged SHARED server used to be left alone entirely (other sessions
        // depend on it), which made the respawn a no-op for every session on it
        // (2026-07-17: four consecutive wedged attempts on one shared codex
        // server). Now it DRAINS instead: in-flight runs finish on the old
        // process, and this retry — plus every subsequent ensure — cold-boots
        // a fresh server under the same key.
        if (failure.kind === "liveness_wedge" && entry && servers.get(entry.key) === entry) {
          if (!entry.shared && entry.activeRuns <= 1) {
            killServer(entry.key, entry, "liveness wedge — respawn on next run");
          } else if (entry.shared) {
            drainServer(entry.key, entry, "liveness wedge — drain-respawn");
          }
        }
        turnEvent({ direction: "out", kind: "server_respawn_retry", error: failure.message });
        bridgeRunEnd("error", failure.message);
        if (failure.kind === "liveness_wedge") turn.wedgeRetries++;
        rotation.rotate = true;
        rotation.note = failure.kind === "liveness_wedge"
          ? `Engine went silent on "${bridgeAccountLabel()}"; restarted and retrying` +
            (wedgeSwitchTo ? ` on "${wedgeSwitchTo}".` : ".")
          : `Engine error on "${bridgeAccountLabel()}"; retrying.`;
        return;
      }
      turnEvent({ direction: "out", kind: "error", error: failure.message });
      bridgeRunEnd("error", failure.message);
      reachedTerminal = true;
      yield {
        type: "error",
        content: failure.message,
        provider: PROVIDER,
        model,
        usageLimitExhausted: failure.kind === "usage_limit" || undefined,
        noticePersisted: failureNoticePersisted || undefined,
      };
      return;
    }

    // Turn finished — read the authoritative final assistant message.
    reachedTerminal = true;
    const msgs = await client.session.messages({ path: { id: ocSessionId }, ...q });
    const list = (msgs.data || []) as Array<{ info: any; parts: any[] }>;
    const { lastAssistant, info, textOut } = collectFinalAssistantText(list, {
      ocSessionId,
      model,
      emittedText,
      pending,
      textStream,
    });
    while (pending.length) yield pending.shift()!;

    const errMessage =
      sessionError ||
      (info?.error ? info.error?.data?.message || info.error?.name : undefined);
    if (errMessage && info?.error?.name !== "MessageAbortedError") {
      const failure = classifyOpencodeTurnFailure(parsed.providerID, errMessage);
      // Mid-turn transient failures (SQLite "Failed to execute statement"
      // under write contention, provider 5xx) surface HERE as a session-level
      // error after the turn ends — a path that used to bypass the transient
      // retry entirely and kill the turn (every statement-failure death on
      // 2026-07-17 was terminal). Re-run via the rotation loop: the engine
      // session holds the partial work, so the retry continues from it the
      // same way a manual re-prompt would.
      if (
        failure.kind !== "usage_limit" &&
        isTransientRunError(failure.message) &&
        rotation &&
        attemptIndex < 2
      ) {
        turnEvent({ direction: "out", kind: "server_respawn_retry", error: errMessage });
        bridgeRunEnd("error", errMessage);
        rotation.rotate = true;
        rotation.note = `Engine error mid-turn; retrying (attempt ${attemptIndex + 1}).`;
        return;
      }
      turnEvent({ direction: "out", kind: "error", error: failure.message });
      bridgeRunEnd("error", failure.message);
      yield {
        type: "error",
        content: failure.message,
        provider: PROVIDER,
        model,
        usageLimitExhausted: failure.kind === "usage_limit" || undefined,
      };
      return;
    }
    if (abortController.signal.aborted) return;

    // MessageAbortedError is exempted from the error path above so user
    // cancels end quietly — but reaching here NOT via our abortController with
    // zero output means the engine turn was killed externally (e.g. a stale
    // abort from a previous attempt). Reporting success would show the user a
    // silently-dead turn ("Done! (no text output)"); retry once instead, then
    // surface an honest error.
    if (info?.error?.name === "MessageAbortedError" && !textOut) {
      const abortedMsg =
        `opencode engine turn was aborted externally before producing output ` +
        `on account "${bridgeAccountLabel()}"`;
      // Not gated on attemptIndex: opencode latches an abort issued while no
      // message is running and applies it to the NEXT prompt, so a wedge
      // retry (attempt 1) is a common victim (seen 19:06 2026-07-16, fence
      // live). The kill consumes the latch, so one more rerun succeeds;
      // MAX_ACCOUNT_ATTEMPTS bounds the loop.
      if (rotation && attemptIndex < 3) {
        turnEvent({ direction: "out", kind: "server_respawn_retry", error: abortedMsg });
        bridgeRunEnd("error", abortedMsg);
        rotation.rotate = true;
        rotation.note =
          "Engine turn was aborted externally before producing output — retrying once.";
        return;
      }
      turnEvent({ direction: "out", kind: "error", error: abortedMsg });
      bridgeRunEnd("error", abortedMsg);
      yield { type: "error", content: abortedMsg, provider: PROVIDER, model };
      return;
    }

    if (!lastAssistant) {
      // A turn that ends with NO assistant message at all is the signature of
      // a poisoned session tail: an earlier empty completion left a
      // reasoning-only assistant message that the provider now rejects on
      // every request. Prune the tail; if anything was removed, the poison is
      // gone — retry once instead of surfacing the death-loop error.
      const message = missingAssistantTurnError(parsed.providerID);
      const pruned = entry
        ? await pruneOrphanedAssistantTail(entry, ocSessionId, list, dirQuery?.directory)
        : 0;
      if (pruned > 0 && rotation && attemptIndex < 2) {
        turnEvent({ direction: "out", kind: "orphaned_tail_pruned", pruned, error: message });
        bridgeRunEnd("error", message);
        turn.repairPrompt = emptyCompletionRepairPrompt(prompt);
        rotation.rotate = true;
        rotation.note =
          "The engine session ended on a broken half-finished message — removed it and retrying once.";
        return;
      }
      turnEvent({ direction: "out", kind: "error", error: message });
      bridgeRunEnd("error", message);
      yield { type: "error", content: message, provider: PROVIDER, model };
      return;
    }

    // Providers can occasionally emit only hidden reasoning / empty text
    // blocks and still declare `finish: stop` (bks-019fa8a2, 2026-07-28).
    // Treat that as an incomplete turn, not success. Continue once in the
    // SAME engine session so the model sees its edits/tool results; if the
    // repair is also empty, stop with an honest error instead of looping.
    if (!textOut.trim()) {
      const emptyMessage =
        `opencode ${parsed.providerID} returned a successful stop with no final text ` +
        `on account "${bridgeAccountLabel()}"`;
      // Strip the empty message when it carries no tool work either: a
      // reasoning-only assistant tail poisons every later request on the
      // OpenAI Responses backend, so leave it in place and the continuation —
      // and every send after it — dies with "turn ended without an assistant
      // message". Substantive (tool-carrying) empty stops are kept: the tool
      // results are real work the continuation should see.
      if (entry) {
        await pruneOrphanedAssistantTail(entry, ocSessionId, list, dirQuery?.directory);
      }
      if (
        rotation &&
        shouldRepairEmptyCompletion(textOut, turn.emptyCompletionRepairs)
      ) {
        turn.emptyCompletionRepairs++;
        turn.repairPrompt = emptyCompletionRepairPrompt(prompt);
        turnEvent({
          direction: "out",
          kind: "empty_completion_retry",
          error: emptyMessage,
        });
        bridgeRunEnd("error", emptyMessage);
        rotation.rotate = true;
        rotation.note =
          "No final answer; continuing from its saved work.";
        return;
      }
      const terminalMessage =
        `${emptyMessage}; the one automatic continuation also produced no final text`;
      turnEvent({ direction: "out", kind: "error", error: terminalMessage });
      bridgeRunEnd("error", terminalMessage);
      yield {
        type: "error",
        content: `${terminalMessage}. Work up to this point is saved; send a message to continue.`,
        provider: PROVIDER,
        model,
      };
      return;
    }

    const resultEvents = buildTurnResultEvents({
      info,
      list,
      textOut,
      ocSessionId,
      model,
      providerID: parsed.providerID,
      turnEvent,
    });
    bridgeRunEnd("success");
    for (const ev of resultEvents) yield ev;
  } catch (e: any) {
    if (!abortController.signal.aborted) {
      reachedTerminal = true;
      const message = e?.message || String(e);
      const failure = classifyOpencodeTurnFailure(
        parsed.providerID,
        message,
        e?.usageLimitExhausted === true ? "usage_limit" : undefined,
      );
      turnEvent({ direction: "out", kind: "error", error: failure.message });
      bridgeRunEnd("error", failure.message);
      yield {
        type: "error",
        content: failure.message,
        provider: PROVIDER,
        model,
        usageLimitExhausted: failure.kind === "usage_limit" || undefined,
      };
    }
  } finally {
    runEnded = true;
    if (abortController.signal.aborted) {
      turnEvent({ direction: "out", kind: "cancelled" });
    }
    // Backstop for paths that never reached an explicit close (cancel, early
    // return, generator torn down mid-drain) — no-op if already ended.
    bridgeRunEnd(abortController.signal.aborted ? "cancelled" : "abandoned");
    teardownOpencodeRunRegistries({
      registeredKeys,
      runKey,
      ocSessionRegistered,
      rpcTokenRegistered,
      entry,
    });
    // Keep the journal across an account-rotation retry (the wrapper reruns
    // the same runKey immediately); cleared for real on the final attempt —
    // and ONLY when a terminal path actually ran (or the user cancelled,
    // which aborts the engine turn). Consumer teardown mid-turn keeps the
    // record so the next boot reattaches the still-live engine turn.
    if (
      journal?.osSessionId &&
      !rotation?.rotate &&
      (reachedTerminal || abortController.signal.aborted)
    ) {
      journalClear(runKey);
    }
  }
}

// ── Reattach: resume a run whose detached server survived the restart ────────

/**
 * Try to REATTACH a journaled run to its still-running (or just-finished)
 * turn on a detached server that survived the restart, instead of re-prompting
 * the session (agent-runner's RESUME_CONTINUATION_PROMPT fallback — which
 * loses the in-flight turn). Preconditions checked here, before any events:
 * the journaled serverKey resolves to a live ADOPTED pool entry and the
 * opencode session exists on it. Returns null when they don't hold — the
 * caller falls back to the classic re-prompt resume.
 *
 * The generator is a condensed copy of runOpencodeAttempt's drain machinery
 * (SSE pump → mirror → permission bridge → status poll → final-message tail);
 * that function is the master copy — keep event/mirroring semantics in sync
 * with it. What reattach deliberately skips: account picking + bridge audit
 * (the surviving server IS the account choice), config building/ensure (the
 * server already runs the config the turn started under), prompt send and the
 * user transcript line (the turn is already running), and account rotation
 * (an engine failure here surfaces as a plain error — the next human send
 * goes through the full path).
 *
 * "Busy" is verified against the store before adopting: a turn whose last
 * persisted write is older than the request-stall window with no tool part
 * open is a dead provider request wearing a busy status — reattach aborts it
 * and returns null so the continuation re-prompt (with rotation) recovers it.
 * Once attached, the pump carries a condensed provider-retry lane: a
 * mid-turn Claude usage-limit/subscription fault sidelines the account and
 * ends the turn with a clear error (no rotation machinery here), and a retry
 * streak with no output between fires the same stall backstop as the master
 * copy.
 *
 * Mirror continuity: dedup sets are seeded from the transcript file's uuids
 * and the restart gap is backfilled from opencode's SQLite store
 * (backfillOpencodeTranscriptGap) before the pump starts, so pre-restart
 * lines never double-append and gap activity isn't lost.
 */
export async function tryReattachOpencodeRun(
  run: ActiveRunRecord,
  handlers: { onAskUser?: RunAgentOpts["onAskUser"] }
): Promise<
  | (AsyncGenerator<StreamEvent> & { cancelDetachedTurn: () => Promise<void> })
  | null
> {
  const ocSessionId = run.claudeSessionId;
  const serverKey = run.serverKey;
  if (!ocSessionId || !serverKey) return null;
  const runKey = run.runKey;
  if (activeOpencodeRuns.has(runKey)) return null;
  if (run.osSessionId && activeOpencodeRuns.has(run.osSessionId)) return null;
  // The pool holds one entry per key, but a drain-respawn (or the boot
  // adoption of one) can leave the run's live turn on a SUPERSEDED server
  // that no longer owns the key — shared shard DBs make the successor answer
  // session.get for a turn it never ran (bks-019facef, 2026-07-29). Scan the
  // pool entry AND same-key draining servers; attach to whichever instance
  // reports the session busy (its in-memory status is the ground truth),
  // falling back to the first instance that at least knows the session.
  const candidates: OpencodeServerEntry[] = [];
  const pooled = servers.get(serverKey);
  if (pooled && pooled.proc.detached && pooled.proc.exitCode === null) candidates.push(pooled);
  for (const d of drainingServers) {
    if (d.key === serverKey && d.proc.detached && d.proc.exitCode === null) candidates.push(d);
  }
  if (!candidates.length) return null;
  let entry: OpencodeServerEntry | undefined;
  let busy = false;
  let confirmedBusy = false;
  let uncertainEntry: OpencodeServerEntry | undefined;
  for (const cand of candidates) {
    const candQ = cand.shared ? { query: { directory: run.cwd } } : {};
    try {
      const sess = await clientFor(cand).session.get({
        path: { id: ocSessionId },
        ...candQ,
        signal: AbortSignal.timeout(5_000),
      });
      if (sess.error) throw new Error(JSON.stringify(sess.error));
      if (!sess.data) continue;
      const st = await clientFor(cand).session.status({
        ...candQ,
        signal: AbortSignal.timeout(5_000),
      });
      if (st.error) throw new Error(JSON.stringify(st.error));
      const statuses = st.data as Record<string, { type?: string }> | undefined;
      const mine = statuses?.[ocSessionId];
      if (mine && mine.type !== "idle") {
        entry = cand;
        busy = true;
        confirmedBusy = true;
        break;
      }
      entry ??= cand;
    } catch {
      // Adoption already observed a busy journaled turn on this exact server.
      // If the restart-time probe is now inconclusive, attach conservatively
      // instead of falling through to a continuation that could double-drive
      // the still-live original turn.
      if (cand.recoveringSessionIds?.has(ocSessionId)) {
        uncertainEntry ??= cand;
      }
      continue;
    }
  }
  if (!confirmedBusy && uncertainEntry) {
    entry = uncertainEntry;
    busy = true;
  }
  if (!entry) {
    // No candidate even knows the session: the reservation adoption took for
    // it can never be claimed, and the caller falls back to a continuation.
    releaseRecoveryReservation(serverKey, ocSessionId);
    return null;
  }
  const shared = !!entry.shared;
  const q = shared ? { query: { directory: run.cwd } } : {};
  const client = clientFor(entry);
  if (busy && REQUEST_STALL_MS) {
    // "Busy" is the engine's turn state machine, not proof of life: a provider
    // request stuck in opencode's silent retry backoff reports busy for hours
    // while persisting nothing (2026-08-07 os-019fdcbe: account hit its Claude
    // session limit mid-turn; retries 68 min apart kept the turn "busy" 2h19m,
    // and every restart reattached to it). A turn with no tool part open whose
    // last persisted write is older than the request-stall window is dead —
    // abort it and decline the reattach, so the caller's continuation
    // re-prompt drives a fresh turn through the full path (account rotation
    // included, which is exactly what a limit-capped account needs).
    const activity = opencodeTurnActivitySnapshot(ocSessionId);
    const quietMs =
      activity?.lastActivityAt != null ? Date.now() - activity.lastActivityAt : 0;
    if (
      activity &&
      activity.lastActivityAt != null &&
      activity.openToolCount === 0 &&
      quietMs >= REQUEST_STALL_MS
    ) {
      audit({
        msg: "claude_turn_event",
        provider: PROVIDER,
        run_key: runKey,
        session_id: run.osSessionId,
        run_kind: `${run.kind || "run"}-reattach`,
        claude_session_id: ocSessionId,
        direction: "in",
        kind: "reattach_dead_turn",
        quiet_ms: quietMs,
        summary:
          `declined reattach: engine reports busy but the turn persisted nothing for ` +
          `${Math.round(quietMs / 60_000)} min with no tool running — aborting the dead turn ` +
          "and falling back to the continuation re-prompt",
      });
      appendOpencodeTranscript(ocSessionId, [
        transcriptLineRunnerNotice(
          `The engine turn made no progress for ${Math.round(quietMs / 60_000)} minutes ` +
            "(stuck provider request) — restarting it fresh.",
        ),
      ]);
      try {
        await client.session.abort({ path: { id: ocSessionId }, ...q });
      } catch {}
      releaseRecoveryReservation(serverKey, ocSessionId);
      return null;
    }
  }
  if (!busy && opencodeTurnLooksCompleted(ocSessionId) === false) {
    // The server reports idle but the store's trailing message never
    // completed. Shared serverKeys survive drain-respawns, so this probe can
    // land on a NEW server instance that never ran the turn — "finalizing
    // from the engine store" would then fabricate a clean result for a turn
    // that died with the old instance (bks-019f8530, 2026-07-21). A
    // confirmed-incomplete turn falls back to the continuation re-prompt
    // (caller handles null); no signal keeps the finalize path.
    releaseRecoveryReservation(serverKey, ocSessionId);
    return null;
  }
  const model = run.model || "";

  async function* attach(): AsyncGenerator<StreamEvent> {
    const abortController = new AbortController();
    // Same contract as the normal path: consumer teardown mid-turn must NOT
    // clear the journal (the engine turn lives on the detached server).
    let reachedTerminal = false;
    const registeredKeys = new Set<string>([runKey, ocSessionId!]);
    if (run.osSessionId) registeredKeys.add(run.osSessionId);
    for (const key of registeredKeys) activeOpencodeRuns.set(key, abortController);
    detachedRunKeys.add(runKey);
    const server = entry!;
    // Both paths claim the reservation: a busy turn is followed live, while
    // an idle turn is finalized from the engine store. Leaving the latter
    // reserved pins an uncertain draining adoptee until the expiry sweep.
    claimDetachedRecovery(server, ocSessionId!);
    // Claim only once iteration starts, so a caller failing between receiving
    // this generator and its first next() cannot leak an active-run hold. The
    // recovery reservation protects the server until this synchronous step.
    server.activeRuns++;
    server.lastUsed = Date.now();
    // Replace the boot sweep's claimed record with a live one (same runKey)
    // so a second restart mid-reattach can reattach again.
    journalSet({ ...run });
    let rpcTokenRegistered = false;
    let ocSessionRegistered = "";
    if (run.osSessionId) {
      // Revive the in-process MCP path: the proxies baked into the server's
      // config reconnect to the run-rpc socket on their next call and
      // authenticate with this token (interactive-builder authz still applies
      // per session — automation-owned sessions stay fail-closed there).
      registerRunToken(server.rpcToken, { sessionId: run.osSessionId, user: run.user });
      rpcTokenRegistered = true;
      if (shared) {
        registerOcSessionContext(ocSessionId!, {
          sessionId: run.osSessionId,
          user: run.user,
          token: server.rpcToken,
        });
        ocSessionRegistered = ocSessionId!;
      }
    }
    const turnId = crypto.randomUUID();
    const turnEvent = (fields: Record<string, unknown>) =>
      audit({
        msg: "claude_turn_event",
        provider: PROVIDER,
        turn_id: turnId,
        run_key: runKey,
        session_id: run.osSessionId,
        run_kind: `${run.kind || "run"}-reattach`,
        mode: run.mode || "code",
        claude_session_id: ocSessionId,
        model,
        ...fields,
      });
    // Same in-band steer as a fresh run — a restart must not cost steering.
    const steerFn: OpencodeSteerFn = (text, images) => {
      void client.session
        .prompt({
          path: { id: ocSessionId! },
          ...q,
          body: {
            noReply: true,
            parts: [{ type: "text", text }, ...(imageParts(images) as any[])],
          },
        })
        .then((sent: any) => {
          if (sent?.error) throw new Error(JSON.stringify(sent.error));
          turnEvent({ direction: "in", kind: "steer_injected", ...summarizeText(text) });
          appendOpencodeTranscript(ocSessionId!, [
            transcriptLineUser(text, undefined, undefined, images),
          ]);
        })
        .catch((e: any) => {
          turnEvent({
            direction: "in",
            kind: "steer_inject_failed",
            error: String(e?.message || e).slice(0, 300),
          });
        });
    };
    for (const key of registeredKeys) activeOpencodeSteers.set(key, steerFn);
    let runFailure: string | undefined;
    // Same contract as the primary path's flag: the reattach timeout writes
    // its own transcript line, and the terminal error event carries the fact.
    let failureNoticePersisted = false;
    let runEnded = false;
    try {
      yield { type: "init", sessionId: ocSessionId!, provider: PROVIDER, model };
      turnEvent({
        direction: "in",
        kind: "reattach",
        summary: busy
          ? "reattached to live engine turn after restart"
          : "turn finished during restart — finalizing from the engine store",
      });

      // Transcript v2: re-record the oc→unified mapping before the gap
      // backfill below runs the store's import-first gate — the reattach path
      // is the first writer for every in-flight run at activation.
      if (run.osSessionId) recordBksSessionFor(ocSessionId!, run.osSessionId);
      // Seed mirror dedup from what the file already has + backfill the gap.
      const seenUuids = backfillOpencodeTranscriptGap(ocSessionId!);
      const emittedText = new Set<string>();
      // Autocompact-summary messages seen via message.updated (fires on
      // creation, before text parts complete). A restart landing exactly
      // mid-compaction can miss the flag — worst case that one summary
      // renders as a plain assistant bubble, the pre-fix behavior.
      const compactionMsgs = new Set<string>();
      // Messages the engine called the assistant's, which is what lets one of
      // their text deltas reach the bubble (see mirrorTextDelta).
      const assistantMsgs = new Set<string>();
      // Same rebuild watch as the primary pump — a reattached turn is served by
      // the same bridge and can have its context rewritten mid-flight too.
      const watchContextRebuild = makeContextRebuildWatcher({
        ocSessionId: ocSessionId!,
        model,
        turnEvent,
        onDetected: (notice) =>
          appendOpencodeTranscript(ocSessionId!, [transcriptLineRunnerNotice(notice)]),
      });
      const startedTools = new Set<string>();
      const finishedTools = new Set<string>();
      for (const uuid of seenUuids) {
        if (uuid.endsWith("-use")) startedTools.add(uuid.slice(0, -4));
        else if (uuid.endsWith("-result")) finishedTools.add(uuid.slice(0, -7));
        else emittedText.add(uuid);
      }

      const pending: StreamEvent[] = [];
      let wake: (() => void) | null = null;
      let idle = !busy;
      let sessionError: string | undefined;
      const push = (ev: StreamEvent) => {
        pending.push(ev);
        wake?.();
      };
      const signalDone = () => {
        idle = true;
        wake?.();
      };
      const { mirrorTextPart, mirrorTextDelta, mirrorToolPart, textStream } = makePartMirror({
        ocSessionId: ocSessionId!,
        model,
        turnEvent,
        push,
        steerFn,
        emittedText,
        compactionMsgs,
        assistantMsgs,
        startedTools,
        finishedTools,
      });
      abortController.signal.addEventListener("abort", () => {
        void client.session.abort({ path: { id: ocSessionId! }, ...q }).catch(() => {});
        signalDone();
      });
      // A mid-reattach server death must end the turn cleanly (master copy:
      // the proc-exit watcher in runOpencodeAttempt).
      void server.proc.exited.then(() => {
        if (runEnded) return;
        runFailure ??=
          "opencode serve exited mid-run (detached server died) — the turn was lost; send the prompt again to restart on a fresh server";
        if (run.osSessionId) {
          transitionRunState(run.osSessionId, "engine_died", {
            source: "reattach_proc_exit",
          });
        }
        if (servers.get(serverKey!) === server) killServer(serverKey!, server, "died mid-run");
        signalDone();
      });

      // Permission bridge (same policy as the master copy).
      const policy = opencodeRunPolicy({
        deniedTools: run.deniedTools,
        confirmTools: run.confirmTools,
        journalKind: run.kind,
      });
      // Shared bridge machinery (makeOpencodePermissionBridge). The gated
      // flag is recomputed from the journaled kind/mode because a reattach
      // adopts a server whose config (bash "*" ask included) it did not
      // write — the two must agree or an adopted run's asks all reject.
      // noteAskPending resolves stallGuard lazily: it's declared below, and
      // asks arrive via events only, never synchronously.
      const handlePermissionAsk = makeOpencodePermissionBridge({
        client,
        entry: server,
        ocSessionId: ocSessionId!,
        q,
        unattended: policy.unattended,
        gated: isUnattendedKind(baseJournalKind(run.kind)) && run.mode !== "ask",
        sessionId: run.osSessionId,
        runKind: run.kind,
        onAskUser: handlers.onAskUser,
        turnEvent,
        noteAskPending: (delta) => stallGuard.noteAskPending(delta),
      });

      // Same mid-turn task-subagent stall guard as the primary path: a
      // reattached turn can hang on a wedged subagent request identically. No
      // rotation machinery here, so a stall ends the turn cleanly (engine
      // state preserved) instead of retrying.
      const stallGuard = makeSubagentStallGuard(ocSessionId!, (info) => {
        if (idle || runFailure) return;
        if (info.kind === "tool") {
          const label = info.openToolLabels.join("; ") || "unknown tool";
          runFailure = toolStallError(label, info.quietMs);
          appendOpencodeTranscript(ocSessionId!, [
            transcriptLineRunnerNotice(toolStallNotice(label, info.quietMs)),
          ]);
          failureNoticePersisted = true;
          turnEvent({
            direction: "out",
            kind: "tool_stall",
            tool_name: label.slice(0, 200),
            quiet_ms: info.quietMs,
          });
          void client.session.abort({ path: { id: ocSessionId! }, ...q }).catch(() => {});
          signalDone();
          return;
        }
        runFailure =
          info.kind === "request"
            ? `opencode turn produced no output for ${Math.round(info.quietMs / 60_000)} min ` +
              "with no tool running — the provider request died without surfacing an error; " +
              "ending the reattached turn (engine state preserved; send again to continue)"
            : `opencode task subagent produced no output for ${Math.round(info.quietMs / 60_000)} min ` +
              "— the engine bridge wedged mid-turn; ending the reattached turn " +
              "(engine state preserved; send again to continue)";
        turnEvent({
          direction: "out",
          kind: info.kind === "request" ? "request_stall" : "subagent_stall",
          tool_use_id: info.openTaskIds.join(","),
          quiet_ms: info.quietMs,
        });
        void client.session.abort({ path: { id: ocSessionId! }, ...q }).catch(() => {});
        signalDone();
      });
      const persistedTasks = opencodeOpenTaskSnapshot(ocSessionId!);
      if (persistedTasks?.tasks.length) {
        stallGuard.seed(persistedTasks.tasks, persistedTasks.lastActivityAt);
        turnEvent({
          direction: "in",
          kind: "subagent_stall_guard_restored",
          tool_use_id: persistedTasks.tasks.map((task) => task.id).join(","),
          last_activity_at: persistedTasks.lastActivityAt,
        });
      } else if (busy) {
        // No open tasks, but the silence clock must still carry across the
        // restart: a turn already quiet for 40 minutes getting a fresh clock
        // on every reattach is how the request-stall lane stays permanently
        // one-window-short (2026-08-07 os-019fdcbe, three restarts).
        const activity = opencodeTurnActivitySnapshot(ocSessionId!);
        if (activity?.lastActivityAt != null) {
          stallGuard.seed([], activity.lastActivityAt);
        }
      }

      // Provider-retry visibility (condensed noteProviderRetry — the master
      // copy carries the full rotation machinery; this path cannot rotate, so
      // a classified account-level fault ends the turn with the account
      // sidelined and a clear error instead of silently retrying forever).
      // Before this lane the reattach pump had NO retry handling at all: a
      // limit-capped account just kept the turn "busy" through opencode's
      // hour-long backoff (the 2026-08-07 wedge).
      let retryStreak = 0;
      let retryStreakAt = 0;
      let retryStreakUpstreamIdleOnly = true;
      const accountLabel =
        (server.accountId && getAccountById(server.accountId)?.name) ||
        server.accountId ||
        serverKey!;
      const modelId = model.split("/").pop() || model;
      const failTurn = (message: string) => {
        if (runFailure || idle) return;
        runFailure = message;
        void client.session.abort({ path: { id: ocSessionId! }, ...q }).catch(() => {});
        signalDone();
      };
      const noteProviderRetry = (attempt: number, message: string) => {
        if (!message) return;
        turnEvent({
          direction: "out",
          kind: "provider_retry",
          retry_attempt: attempt,
          error: message.slice(0, 500),
        });
        const subIssue = isClaudeSubscriptionError(message);
        if (
          server.accountId &&
          (isClaudeUsageLimitError(message, true) || subIssue)
        ) {
          // Account-level and dead on retry — sideline it so new picks skip
          // it, and end the turn now: the next send rotates onto a healthy
          // account through the full path.
          markExhausted(server.accountId, modelId);
          failTurn(
            `${subIssue ? "Claude subscription issue" : "Claude usage limit"} on account ` +
              `"${accountLabel}" hit mid-turn: ${message.slice(0, 300)} — the account is ` +
              "sidelined; send again to continue on another account",
          );
          return;
        }
        if (retryStreak === 0) {
          retryStreakAt = Date.now();
          retryStreakUpstreamIdleOnly = true;
        }
        retryStreak++;
        if (!isUpstreamIdleStallError(message)) retryStreakUpstreamIdleOnly = false;
        if (!PROVIDER_STALL_MS) return;
        const minRetries = retryStreakUpstreamIdleOnly
          ? Math.max(2, PROVIDER_STALL_MIN_RETRIES - 1)
          : PROVIDER_STALL_MIN_RETRIES;
        const windowMs = retryStreakUpstreamIdleOnly
          ? PROVIDER_STALL_MS / 2
          : PROVIDER_STALL_MS;
        const stalledMs = Date.now() - retryStreakAt;
        if (retryStreak < minRetries || stalledMs < windowMs) return;
        turnEvent({
          direction: "out",
          kind: "provider_stall",
          retry_attempt: retryStreak,
          quiet_ms: stalledMs,
          error: message.slice(0, 200),
        });
        failTurn(
          `opencode run made no progress for ${Math.round(stalledMs / 60_000)} min on account ` +
            `"${accountLabel}": ${retryStreak} provider retries with no output in between ` +
            `(last: ${message.slice(0, 200)}); ending the reattached turn — send again to continue`,
        );
      };

      const handleEvent = async (ev: any) => {
        const p = ev?.properties;
        stallGuard.noteEvent(ev);
        switch (ev?.type) {
          case "message.part.delta": {
            // The engine's token stream (see mirrorTextDelta).
            if (p?.sessionID !== ocSessionId) return;
            mirrorTextDelta(p);
            return;
          }
          case "message.part.updated": {
            const part = p?.part;
            if (!part) return;
            if (part.type === "retry") {
              // Family-wide, like the master copy: a task child's provider
              // retries are the parent turn's stall.
              if (stallGuard.isFamily(part.sessionID)) {
                noteProviderRetry(
                  Number(part.attempt) || 0,
                  String(part.error?.data?.message || part.error?.name || "")
                );
              }
              return;
            }
            if (part.sessionID !== ocSessionId) return;
            if (part.type === "tool") stallGuard.noteTool(part);
            mirrorTextPart(part);
            mirrorToolPart(part);
            return;
          }
          case "session.status": {
            if (!stallGuard.isFamily(p?.sessionID)) return;
            const st = p?.status;
            if (st?.type === "retry") {
              noteProviderRetry(Number(st.attempt) || 0, String(st.message || ""));
            }
            return;
          }
          case "message.updated": {
            const info = p?.info;
            if (info?.sessionID !== ocSessionId) return;
            // What makes this message's text deltas eligible to reach the
            // bubble; the delta feed itself carries no role.
            if (info.role === "assistant") assistantMsgs.add(info.id);
            if (isCompactionMessageInfo(info)) compactionMsgs.add(info.id);
            else watchContextRebuild(info);
            return;
          }
          case "permission.updated":
          case "permission.asked":
          case "permission.v2.asked": {
            if (p?.sessionID !== ocSessionId) return;
            handlePermissionAsk(p, "sse");
            return;
          }
          case "session.error": {
            if (p?.sessionID && p.sessionID !== ocSessionId) return;
            const err = p?.error;
            sessionError = err?.data?.message || err?.name || "opencode session error";
            return;
          }
          case "session.idle": {
            if (p?.sessionID === ocSessionId) signalDone();
            return;
          }
        }
      };

      let pumpStopped = false;
      const pump = busy
        ? runSseEventPump({
            client,
            query: shared ? { query: { directory: run.cwd } } : undefined,
            handleEvent,
            stopped: () => pumpStopped || abortController.signal.aborted,
            idle: () => idle,
          })
        : Promise.resolve();

      // Wall-clock deadline: what's LEFT of the original turn budget (floor 5
      // minutes so a turn reattached near its limit isn't killed instantly).
      const startedAtMs = Date.parse(run.startedAt || "") || Date.now();
      const remainingMs = Math.max(
        5 * 60_000,
        opencodeTurnTimeoutMs() - (Date.now() - startedAtMs)
      );
      const turnDeadline = busy
        ? setTimeout(() => {
            if (!runFailure) {
              runFailure = turnTimeoutError();
              // Same durable cutoff notice as the primary turn path above.
              appendOpencodeTranscript(ocSessionId!, [
                transcriptLineRunnerNotice(turnTimeoutNotice()),
              ]);
              failureNoticePersisted = true;
            }
            void client.session.abort({ path: { id: ocSessionId! }, ...q }).catch(() => {});
            signalDone();
          }, remainingMs)
        : undefined;

      let statusPollFailures = 0;
      let statusPollStreakStart = 0;
      let zombieProbeInFlight = false;
      const statusPoll = busy
        ? setInterval(() => {
            void (async () => {
              try {
                if (idle) return;
                const res = await client.session.status({
                  ...q,
                  signal: AbortSignal.timeout(5_000),
                });
                const statuses = res.data as Record<string, { type?: string }> | undefined;
                statusPollFailures = 0;
                const mine = statuses?.[ocSessionId!];
                if (!mine || mine.type === "idle") {
                  signalDone();
                  return;
                }
                try {
                  const pr = await fetch(`${server.url}/permission`, {
                    headers: { Authorization: `Basic ${btoa(`opencode:${server.password}`)}` },
                    signal: AbortSignal.timeout(5000),
                  });
                  if (pr.ok) {
                    const asks = (await pr.json()) as Array<{ id?: string; sessionID?: string }>;
                    for (const ask of Array.isArray(asks) ? asks : []) {
                      if (ask?.sessionID === ocSessionId) handlePermissionAsk(ask, "poll");
                    }
                  }
                } catch {}
              } catch (e) {
                // Same starved-vs-dead verdict as the primary turn watcher.
                statusPollFailures++;
                if (statusPollFailures === 1) statusPollStreakStart = Date.now();
                if (statusPollFailures === 1 || statusPollFailures % 6 === 0) {
                  console.warn(
                    `[opencode-runner] status poll failing for ${ocSessionId} (${statusPollFailures}x): ${e}`
                  );
                }
                if (statusPollFailures >= 6 && !zombieProbeInFlight) {
                  zombieProbeInFlight = true;
                  try {
                    const verdict = await zombiePollVerdict(
                      server.url,
                      server.password,
                      statusPollStreakStart
                    );
                    if (idle) return;
                    if (verdict === "starved") {
                      console.warn(
                        `[opencode-runner] server for ${ocSessionId} is alive but starved ` +
                          `(${statusPollFailures} failed polls) — keeping the turn`
                      );
                      return;
                    }
                    runFailure ??= zombiePollFailureMessage(verdict);
                    signalDone();
                  } finally {
                    zombieProbeInFlight = false;
                  }
                }
              }
            })();
          }, 10_000)
        : undefined;
      if (busy) stallGuard.start();

      try {
        for (;;) {
          while (pending.length) yield pending.shift()!;
          if (abortController.signal.aborted) return;
          if (idle) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
        while (pending.length) yield pending.shift()!;
      } finally {
        if (statusPoll) clearInterval(statusPoll);
        if (turnDeadline) clearTimeout(turnDeadline);
        stallGuard.stop();
        pumpStopped = true;
        void pump.catch(() => {});
      }

      reachedTerminal = true;
      if (runFailure) {
        turnEvent({ direction: "out", kind: "error", error: runFailure });
        yield {
          type: "error",
          content: runFailure,
          provider: PROVIDER,
          model,
          noticePersisted: failureNoticePersisted || undefined,
        };
        return;
      }

      // Turn over — read the authoritative final assistant message (mirrors
      // the master copy's tail; the seeded dedup keeps pre-restart text from
      // double-appending).
      const msgs = await client.session.messages({
        path: { id: ocSessionId! },
        ...q,
        signal: AbortSignal.timeout(10_000),
      });
      const list = (msgs.data || []) as Array<{ info: any; parts: any[] }>;
      const { lastAssistant, info, textOut } = collectFinalAssistantText(list, {
        ocSessionId: ocSessionId!,
        model,
        emittedText,
        pending,
        textStream,
      });
      while (pending.length) yield pending.shift()!;

      const errMessage =
        sessionError ||
        (info?.error ? info.error?.data?.message || info.error?.name : undefined);
      if (errMessage && info?.error?.name !== "MessageAbortedError") {
        turnEvent({ direction: "out", kind: "error", error: errMessage });
        yield { type: "error", content: errMessage, provider: PROVIDER, model };
        return;
      }
      if (abortController.signal.aborted) return;
      if (info?.error?.name === "MessageAbortedError" && !textOut) {
        const message = "opencode engine turn was aborted externally before producing output";
        turnEvent({ direction: "out", kind: "error", error: message });
        yield { type: "error", content: message, provider: PROVIDER, model };
        return;
      }
      if (!lastAssistant) {
        // Same poisoned-tail cleanup as the primary path (no rotation loop
        // here, so no retry — but the prune means the user's next send works
        // instead of death-looping on the orphaned reasoning-only message).
        const pruned = entry
          ? await pruneOrphanedAssistantTail(
              entry,
              ocSessionId!,
              list,
              shared ? run.cwd : undefined,
            )
          : 0;
        if (pruned > 0) {
          turnEvent({ direction: "out", kind: "orphaned_tail_pruned", pruned });
        }
        const message = missingAssistantTurnError(parseOpencodeModel(model)?.providerID || "provider");
        turnEvent({ direction: "out", kind: "error", error: message });
        yield { type: "error", content: message, provider: PROVIDER, model };
        return;
      }

      const resultEvents = buildTurnResultEvents({
        info,
        list,
        textOut,
        ocSessionId: ocSessionId!,
        model,
        providerID: parseOpencodeModel(model)?.providerID || "",
        turnEvent,
      });
      for (const ev of resultEvents) yield ev;
    } catch (e: any) {
      if (!abortController.signal.aborted) {
        const message = e?.message || String(e);
        turnEvent({ direction: "out", kind: "error", error: message });
        yield { type: "error", content: message, provider: PROVIDER, model };
      }
    } finally {
      runEnded = true;
      if (abortController.signal.aborted) {
        turnEvent({ direction: "out", kind: "cancelled" });
      }
      teardownOpencodeRunRegistries({
        registeredKeys,
        runKey,
        ocSessionRegistered,
        rpcTokenRegistered,
        entry: server,
      });
      if (reachedTerminal || abortController.signal.aborted) journalClear(runKey);
    }
  }

  const attached = attach() as AsyncGenerator<StreamEvent> & {
    cancelDetachedTurn: () => Promise<void>;
  };
  // The generator registers its normal cancellation aliases on first next().
  // Recovery can be stopped in the narrow gap after this function returns but
  // before iteration starts, so expose the server-side abort independently.
  attached.cancelDetachedTurn = async () => {
    try {
      await client.session.abort({ path: { id: ocSessionId! }, ...q });
    } catch {}
  };
  return attached;
}
