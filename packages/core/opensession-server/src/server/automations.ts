/**
 * Automations: cron-scheduled agent sessions, Devin-style.
 * Records live in ~/.opensession-automations/<id>.json; each run creates a
 * normal opensession session so it shows up in the sessions list and UI.
 */
import { randomUUIDv7 } from "bun";
import { OPENSESSION_SESSIONS_DIR , newSessionId} from "./paths";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "./shared/bounded-body";
import { labelIdentity } from "./shared/user-mappings";
import { parseCron, cronMatches, nextRun } from "./cron";
import {
  STRIPE_CONFIRM_TOOLS,
  declaredRunFailure,
  filterMcpServers,
} from "./runner-shared";
import { getAccountById } from "./claude-accounts";
import { getCodexAccountById } from "./codex-accounts";
import { runAgent } from "./agent-runner";
import { mcpOauthProxyServers } from "./mcp-oauth-proxy";
import { runAgentHosted } from "./host-client";
import {
  providerFor,
  resolveModel,
  DEFAULT_FALLBACK_MODEL,
  modelLabel,
  toPiModel,
} from "./models";
import { createWorktree, ensureAskCheckout, getRepo, listWorktrees, REPOS, worktreeHeadBranch } from "./worktree";
import { engineSessionPatch } from "./sessions";
import { updateSessionFile } from "./session-cache";
import { resolvePlainWorkspace } from "./workspace-resolve";
import { getWorkspace } from "./workspaces";
import type { NativeSessionFile } from "./types";
import { stateDir } from "./paths";
import { linkThreadInIndex, createSlackPostScanner } from "./slack-links";
import { createPapercutsMcpServer } from "../agents/slack/papercuts-tools";
import { createReportMcpServer } from "../agents/slack/report-tools";
import { createWorkflowsMcpServer } from "../agents/slack/workflow-tools";
import { createTurnMcpServer } from "../agents/slack/turn-tools";
import { papercutsEnabledForRepo } from "./papercuts";
import {
  registerRunToken,
  registerSessionMcpServers,
  unregisterRunToken,
  unregisterSessionMcpServers,
} from "./run-rpc";
import { createSessionsMcpServer } from "../agents/slack/sessions-tools";
import { createSelfImproveMcpServer } from "../agents/slack/self-improve-tools";
import { AUTOMATION_DENIED_TOOLS } from "./automation-denied-tools";
import { audit } from "./audit";
import { getSandboxProvider, type Sandbox } from "./sandbox";
import {
  sandboxAutomationConfig,
  sandboxProviderConfigured,
} from "./sandbox/config";
import type { RunHostSpec } from "../runner-host/protocol";
import { configuredIntegration, personaName } from "./config";
import { shouldPersistModelSwitch, type StreamEvent } from "./run-events";
import {
  deleteAutomationInputState,
  prepareAutomationInputs,
  sanitizeAutomationInputs,
  type AutomationInput,
} from "./automation-inputs";
import {
  automationOutputInstructions,
  deleteAutomationOutputState,
  deliverAutomationOutputs,
  sanitizeAutomationOutputs,
  type AutomationOutput,
} from "./automation-outputs";

const AUTOMATIONS_DIR = stateDir("automations");
const SESSIONS_DIR = OPENSESSION_SESSIONS_DIR;

/**
 * Config for an automation that is driven by polling a Grafana Loki failure
 * signal: a generic poller (src/agents/grafana-poller) re-runs `lokiQuery` on a
 * timer, collapses the result series to one row per distinct `dedupLabel` value,
 * and fires one run of this automation per fresh failure (deduped over
 * `dedupDays`). The matched Loki labels are handed to the run as the triggering
 * event. Adding a new failure-signal investigator is therefore data — create an
 * automation with this config; no code change or restart.
 */
export interface GrafanaPollConfig {
  /** LogQL instant query. The literal token `$LOOKBACK` is replaced with `lookback`. */
  lokiQuery: string;
  /** Label whose distinct values define one failure (e.g. "story_id", "streaming_upload_id"). */
  dedupLabel: string;
  /** Slack channel id for the control card + investigation thread. */
  slackChannel: string;
  /** Human label for the card, e.g. "export failure" / "upload processing failure". */
  cardTitle: string;
  /** Range vector for the query, default "20m". */
  lookback?: string;
  /** Poll cadence in minutes, default 15. */
  pollMinutes?: number;
  /** Dedup window in days, default 7. */
  dedupDays?: number;
  /** Only fire for this namespace label, default "prod". Empty string disables the filter. */
  namespace?: string;
}

/**
 * Config for a channel-watch automation: the Slack agent fires one run per
 * top-level message posted in `channel` (thread replies don't re-trigger).
 * The bot must be a member of the channel to receive its messages — invite
 * the bot first. Runs get the channel's memory (read-only) appended to the
 * prompt, so "remember ..." facts taught interactively steer the triage.
 */
export interface SlackWatchConfig {
  /** Slack channel id (C…/G…). */
  channel: string;
}

/** One entry in an automation's run ledger (newest first, capped). */
export interface AutomationRun {
  at: string; // start time, ISO
  sessionId: string;
  trigger: "cron" | "webhook" | "manual" | "event";
  status: "running" | "ok" | "error";
  error?: string;
  durationMs?: number;
}

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  schedule: string; // 5-field cron, UTC; "" = webhook/manual only
  /**
   * One-off scheduled run: ISO8601 instant. When set, the scheduler fires this
   * automation once at/after this time and then deletes it (auto-cleanup).
   * Mutually exclusive with `schedule` (recurring cron) — setting it forces
   * `schedule` to "". Used for reminders, "run this again later", and any
   * one-time scheduled prompt (see schedule_once in admin-tools.ts).
   */
  runOnceAt?: string;
  mode: "ask" | "code";
  /**
   * Registered repo id (see worktree.ts REPOS) this automation works against.
   * Omitted = tella-fusion (the historical default). Ask mode reads the repo's
   * main checkout; code mode gets an isolated worktree — for shared-checkout
   * repos (opensession) explicitly isolated, never the live checkout.
   */
  repo?: string;
  /**
   * Reviewer to request on PRs this automation opens — a GitHub login
   * (`kentdebruin`), an `org/team` slug (`tellahq/super-developers`), or a
   * comma-separated list of either. Unattended PRs are otherwise opened with
   * no reviewer, so nothing surfaces them: the review-requested push
   * (pr-review-notifications.ts) is edge-triggered off GitHub's own
   * `reviewRequested`, and a team slug is expanded to its members there.
   * The target must be a collaborator on the repo or GitHub rejects the
   * request (422), so a team needs repo access before it works here.
   */
  prReviewer?: string;
  /**
   * The person accountable for this automation. A person key in the same
   * space as a session's `startedBy` (a display name or a verified login), so
   * the sidebar's person lens can ask "is this one mine?" the same way it asks
   * it of a session.
   *
   * An automation edits the codebase on a schedule nobody is watching, so
   * someone has to be the one who reviews what it did. Absent means nobody
   * has taken it: a house routine that stays in everyone's band until a
   * person claims it. Read it through {@link automationOwner}.
   */
  owner?: string;
  /**
   * Workspace this automation files under. The automation belongs to the
   * workspace; its RUNS stay in the Automations band rather than becoming
   * workspace rows, because a daily cron would otherwise add a row a day to a
   * folder meant for work you are doing (see the band's note in Sidebar.tsx).
   * Promoting one run into the workspace lanes is already a per-user action
   * (claiming it).
   */
  workspaceId?: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  webhookSecret: string;
  /** False removes the public trigger route while retaining the rotatable secret. */
  webhookEnabled?: boolean;
  eventKey?: string; // internal event subscription, e.g. "plain:thread_created"
  /**
   * MCP server allowlist for this automation's runs (least privilege).
   * Omitted = all configured servers, for automations created before this
   * existed. Prefer naming just what the automation actually uses.
   */
  mcpServers?: string[];
  /**
   * Human-set only: give this automation's runs the opensession-workflows
   * tools (run_workflow fan-outs — model-authored scripts in a contained
   * Worker, agents in ask mode). Safe for cron/introspective automations
   * whose prompt is our own text (morning support digest); NEVER set it on
   * automations triggered by untrusted event/ticket text (Plain triage,
   * channel watches) — model-authored code execution must not be steerable
   * from a ticket. See workflow-tools.ts's module doc.
   */
  workflows?: boolean;
  /**
   * Provision the run's env with a Claude-CLI credential from the
   * claude-accounts pool (CLAUDE_CODE_OAUTH_TOKEN, via the opencode runner —
   * see RunAgentOpts.claudeCliEnv). For automations whose tooling spawns its
   * own `claude` CLI (the deepsec scans): the scan must run on Open Session's
   * account pool, never on the host CLI's own login (which logged out
   * 2026-08-08 and left every scan analyzing zero batches while recording
   * ok). Same env-exposure class as a meridian-backed run.
   */
  claudeCliEnv?: boolean;
  /**
   * Codex sibling of claudeCliEnv: CODEX_HOME (ChatGPT-subscription account)
   * or OPENAI_API_KEY (api-key account) from the codex-accounts pool, for
   * run-spawned tooling using `--agent codex`. Independent flags — grant an
   * automation only the pools its tooling actually uses.
   */
  codexCliEnv?: boolean;
  /**
   * Self-improving automation (human-set only — e.g. the nightly Dreaming
   * reflection). Runs (and thread-reply resumes) additionally get two scoped
   * in-process servers: opensession-sessions in `automationSelf` shape (the
   * spawn_task/task_status/cancel_task suite ONLY — no answer/send/cancel/
   * create on other sessions) and opensession-self (read own record + update
   * OWN prompt, with timestamped backup + audit event). Children it spawns
   * stay PR-gated and depth-guarded; schedule/model/mode/repo changes remain
   * human-only. See selfImproveMcpServers below.
   */
  selfImprove?: boolean;
  /**
   * If set, this automation is poll-triggered off a Grafana Loki signal by the
   * generic grafana-poller agent (one run per fresh failure). See GrafanaPollConfig.
   */
  grafanaPoll?: GrafanaPollConfig;
  /**
   * If set, this automation watches a Slack channel: one run per top-level
   * message (see SlackWatchConfig). Fired from the Slack agent's event intake.
   */
  slackWatch?: SlackWatchConfig;
  /** Scheduled/pulled source material collected and reduced before the run. */
  inputs?: AutomationInput[];
  /** Durable report plus optional downstream sinks fed from that report. */
  outputs?: AutomationOutput[];
  /**
   * Model for new runs (claude-* / gpt-* / pi/…; see models.ts).
   * Omitted = the Pi automation default. Dispatch maps engine-neutral and
   * legacy OpenCode ids onto Pi while preserving the model tier.
   */
  model?: string;
  /**
   * Model to switch to when the primary's whole account pool is exhausted.
   * Unset = no fallback; "none" also disables fallback.
   */
  fallbackModel?: string;
  /**
   * Pinned account in the model provider's Claude or Codex pool. By default a HARD pin:
   * runs use only that account, and when it's exhausted they fall to
   * `fallbackModel` instead of the shared pool — that makes the account's
   * limits (and its usage-credits monthly cap) this automation's cost
   * ceiling. Set `accountStrict: false` to soften it: the pinned account is
   * preferred, but an exhausted pin rotates into the shared pool like a
   * session pin does. Unset = shared-pool rotation as before.
   */
  accountId?: string;
  /** false = soft pin (pool fallback); unset/true = hard pin (cost cap). */
  accountStrict?: boolean;
  /**
   * Run this automation's sessions in the credential-minimal MicroVM profile.
   * Creation requires a hard-pinned model account, an explicit MCP allowlist,
   * no cross-model fallback, and a provider-enforced egress policy.
   */
  sandbox?: boolean;
  /**
   * Allow runs to keep going on usage-credits once the account's subscription
   * limits are spent (only works on accounts with extra usage enabled at
   * claude.ai and credit headroom left). Off/unset = never intentionally
   * spend paid credits; the run rotates/falls back instead.
   */
  usageCredits?: boolean;
  lastRunAt?: string;
  lastRunSessionId?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  lastTrigger?: "cron" | "webhook" | "manual" | "event";
  /** Run history ledger, newest first, capped at RUNS_CAP entries. */
  runs?: AutomationRun[];
}

export interface AutomationWithNext extends Automation {
  nextRunAt: string | null;
}

mkdirSync(AUTOMATIONS_DIR, { recursive: true });

// ── Store ────────────────────────────────────────────────────

export function listAutomations(): AutomationWithNext[] {
  const out: AutomationWithNext[] = [];
  for (const file of readdirSync(AUTOMATIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const a = JSON.parse(readFileSync(`${AUTOMATIONS_DIR}/${file}`, "utf-8")) as Automation;
      out.push({
        ...a,
        nextRunAt: !a.enabled
          ? null
          : a.runOnceAt
            ? a.runOnceAt
            : a.schedule
              ? nextRun(a.schedule)?.toISOString() || null
              : null,
      });
    } catch {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function getAutomation(id: string): Automation | null {
  const path = `${AUTOMATIONS_DIR}/${id}.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function saveAutomation(a: Automation): void {
  writeJsonAtomic(`${AUTOMATIONS_DIR}/${a.id}.json`, a);
}

function sanitizeMcpList(list?: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const names = list.filter((s): s is string => typeof s === "string" && !!s.trim());
  // [] is meaningful: no MCP servers at all
  return names.map((s) => s.trim());
}

function sanitizeGrafanaPoll(cfg?: unknown): GrafanaPollConfig | { error: string } | undefined {
  if (cfg === undefined || cfg === null) return undefined;
  if (typeof cfg !== "object") return { error: "grafanaPoll must be an object" };
  const c = cfg as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const lokiQuery = str(c.lokiQuery);
  const dedupLabel = str(c.dedupLabel);
  const slackChannel = str(c.slackChannel);
  const cardTitle = str(c.cardTitle);
  if (!lokiQuery || !dedupLabel || !slackChannel || !cardTitle) {
    return { error: "grafanaPoll requires lokiQuery, dedupLabel, slackChannel, and cardTitle" };
  }
  const out: GrafanaPollConfig = { lokiQuery, dedupLabel, slackChannel, cardTitle };
  if (str(c.lookback)) out.lookback = str(c.lookback);
  if (typeof c.namespace === "string") out.namespace = c.namespace.trim(); // "" = no filter
  if (typeof c.pollMinutes === "number" && c.pollMinutes > 0) out.pollMinutes = c.pollMinutes;
  if (typeof c.dedupDays === "number" && c.dedupDays > 0) out.dedupDays = c.dedupDays;
  return out;
}

function sanitizeSlackWatch(cfg?: unknown): SlackWatchConfig | { error: string } | undefined {
  if (cfg === undefined || cfg === null) return undefined;
  if (typeof cfg !== "object") return { error: "slackWatch must be an object" };
  const channel = typeof (cfg as any).channel === "string" ? (cfg as any).channel.trim() : "";
  if (!channel) return undefined; // {channel: ""} = clear the watch
  if (!/^[CG][A-Z0-9]{6,}$/i.test(channel)) {
    return { error: `slackWatch.channel must be a Slack channel id (C…), got "${channel}"` };
  }
  return { channel: channel.toUpperCase() };
}

/** Validate + normalize a one-off ISO8601 instant. "" / nullish → undefined
 *  (no one-off). Past times are allowed (they fire on the next tick). */
function sanitizeRunOnceAt(v?: unknown): string | { error: string } | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return { error: "runOnceAt must be an ISO8601 string" };
  const t = Date.parse(v.trim());
  if (Number.isNaN(t)) return { error: `Invalid date/time: "${v}"` };
  return new Date(t).toISOString();
}

function generateSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/** Validate a pinned model-account id; ""/nullish clears the pin. */
function sanitizeAccountId(v?: unknown): string | { error: string } | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return { error: "accountId must be a string" };
  const id = v.trim();
  if (!id) return undefined;
  if (!getAccountById(id) && !getCodexAccountById(id))
    return { error: `Unknown model account id "${id}"` };
  return id;
}

function validateSandboxAutomation(
  automation: Pick<
    Automation,
    | "sandbox"
    | "model"
    | "accountId"
    | "accountStrict"
    | "fallbackModel"
    | "mcpServers"
    | "claudeCliEnv"
    | "codexCliEnv"
  >,
): { error: string } | null {
  if (!automation.sandbox) return null;
  if (!sandboxProviderConfigured("microvm")) {
    return {
      error:
        "sandbox automations require the credential-free Firecracker MicroVM provider",
    };
  }
  if (!automation.accountId) {
    return { error: "sandbox automations require a pinned model account" };
  }
  const runModel = automationModel(automation.model) || "";
  if (
    /^(?:claude-|opencode\/anthropic\/|pi\/anthropic\/)/.test(runModel) &&
    !getAccountById(automation.accountId)
  ) {
    return { error: "the pinned account does not belong to the selected Claude model" };
  }
  if (
    /^(?:opencode\/openai\/|pi\/openai\/)/.test(runModel) &&
    !getCodexAccountById(automation.accountId)
  ) {
    return { error: "the pinned account does not belong to the selected OpenAI model" };
  }
  if (automation.accountStrict === false) {
    return { error: "sandbox automation account pins must be strict" };
  }
  if (automation.fallbackModel && automation.fallbackModel !== "none") {
    return {
      error:
        "sandbox automations cannot widen credentials through a fallback model; set fallbackModel to none",
    };
  }
  if (!Array.isArray(automation.mcpServers)) {
    return {
      error:
        "sandbox automations require an explicit mcpServers allowlist (use [] for none)",
    };
  }
  if (automation.claudeCliEnv || automation.codexCliEnv) {
    return {
      error:
        "sandbox automations cannot provision nested Claude/Codex CLI credentials",
    };
  }
  return null;
}

function sanitizeModel(model?: unknown, allowNone = false): string | { error: string } | undefined {
  if (typeof model !== "string" || !model.trim()) return undefined;
  if (allowNone && model.trim().toLowerCase() === "none") return "none";
  const resolved = resolveModel(model);
  if (!resolved) return { error: `Unknown model "${model}"` };
  return resolved.id;
}

function sanitizeRepo(repo?: unknown): string | { error: string } | undefined {
  if (typeof repo !== "string" || !repo.trim()) return undefined;
  const id = repo.trim();
  if (!(id in REPOS)) {
    return { error: `Unknown repo "${id}" — registered: ${Object.keys(REPOS).join(", ")}` };
  }
  return id;
}

/**
 * Normalize a PR reviewer spec into the comma-separated form `gh pr create
 * --reviewer` takes: individual logins and/or `org/team` slugs. Rejects
 * anything that isn't shaped like one, so a typo fails at config time rather
 * than as a silent 422 on every run.
 */
function sanitizePrReviewer(
  reviewer?: unknown,
): string | { error: string } | undefined {
  if (typeof reviewer !== "string" || !reviewer.trim()) return undefined;
  const entries: string[] = [];
  for (const raw of reviewer.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)?$/.test(entry)) {
      return {
        error: `Invalid PR reviewer "${entry}" — use a GitHub login or an org/team slug`,
      };
    }
    if (!entries.some((e) => e.toLowerCase() === entry.toLowerCase())) entries.push(entry);
  }
  return entries.length ? entries.join(",") : undefined;
}

/**
 * Who owns an automation. Unset means nobody has taken it, rather than its
 * creator: `createdBy` records who typed it, which for most of these is a
 * previous agent run ("Michael (loops)", "Michael (plain agent)"), so reading
 * it as ownership would assign thirty automations to people who don't exist
 * and hide them from every real one.
 *
 * Taking ownership is therefore a deliberate act, and until someone performs
 * it the band reads exactly as it did before owners existed.
 */
export function automationOwner(a: Automation): string {
  return a.owner || "";
}

/** Normalize an owner; ""/nullish leaves the automation unowned. */
function sanitizeOwner(v?: unknown): string | { error: string } | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return { error: "owner must be a name" };
  const name = v.trim();
  if (!name) return undefined;
  if (name.length > 64) return { error: `Owner "${name}" is too long` };
  return name;
}

/** Validate the workspace an automation files under; ""/nullish clears it. */
function sanitizeAutomationWorkspace(
  v?: unknown,
): string | { error: string } | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") return { error: "workspaceId must be a string" };
  const id = v.trim();
  if (!getWorkspace(id)) return { error: `Unknown workspace "${id}"` };
  return id;
}

/** A validator either returns the value to store or the reason it can't. */
type AutomationFieldValidator = (v: unknown) => unknown;

function isFieldError(v: unknown): v is { error: string } {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as { error?: unknown }).error === "string"
  );
}

/**
 * Every caller-writable automation field and the validator that owns it.
 * Create and update both apply this one table, so a field can't be sanitized
 * on one write path and stored raw on the other — the drift that let a blank
 * name or an empty prompt in through PUT /api/automations/:id and the
 * update_automation MCP tool, both of which hand over unvalidated input.
 *
 * Order matters: it's the order errors are reported in, and name/prompt come
 * first the way they always did on create.
 *
 * Fields NOT listed here are not caller-writable: id, createdAt, createdBy,
 * webhookSecret and the run ledger stay whatever the record (or the create
 * defaults) already say.
 */
const AUTOMATION_FIELDS: Record<string, AutomationFieldValidator> = {
  name: (v) => {
    const name = typeof v === "string" ? v.trim() : "";
    return name || { error: "Name is required" };
  },
  prompt: (v) => {
    const prompt = typeof v === "string" ? v.trim() : "";
    return prompt || { error: "Prompt is required" };
  },
  runOnceAt: (v) => sanitizeRunOnceAt(v),
  schedule: (v) => {
    const schedule = typeof v === "string" ? v.trim() : "";
    if (schedule && !parseCron(schedule)) {
      return { error: `Invalid cron expression: "${schedule}"` };
    }
    return schedule;
  },
  mode: (v) => (v === "code" ? "code" : "ask"),
  // Only an explicit false opts out; every existing caller omits this and
  // keeps the old always-enabled behaviour.
  enabled: (v) => v !== false,
  eventKey: (v) => (typeof v === "string" ? v.trim() : "") || undefined,
  mcpServers: (v) => sanitizeMcpList(v),
  repo: (v) => sanitizeRepo(v),
  prReviewer: (v) => sanitizePrReviewer(v),
  owner: (v) => sanitizeOwner(v),
  workspaceId: (v) => sanitizeAutomationWorkspace(v),
  selfImprove: (v) => v === true || undefined,
  workflows: (v) => v === true || undefined,
  claudeCliEnv: (v) => v === true || undefined,
  codexCliEnv: (v) => v === true || undefined,
  model: (v) => sanitizeModel(v),
  fallbackModel: (v) => sanitizeModel(v, true),
  accountId: (v) => sanitizeAccountId(v),
  // Only false is worth storing — unset/true both mean the hard-pin default.
  accountStrict: (v) => (v === false ? false : undefined),
  usageCredits: (v) => v === true || undefined,
  sandbox: (v) => v === true || undefined,
  grafanaPoll: (v) => sanitizeGrafanaPoll(v),
  slackWatch: (v) => sanitizeSlackWatch(v),
  inputs: (v) => sanitizeAutomationInputs(v),
  outputs: (v) => sanitizeAutomationOutputs(v),
  webhookEnabled: (v) => (v === false ? false : undefined),
};

/** Cross-field rules, run once at the end of every write. */
function normalizeAutomation(
  next: Automation,
  touched: ReadonlySet<string>,
): Automation | { error: string } {
  if (!(next.name || "").trim()) return { error: "Name is required" };
  if (!(next.prompt || "").trim()) return { error: "Prompt is required" };
  // A one-off and a recurring cron are mutually exclusive, and the scheduler
  // takes the one-off branch: leaving both set means the cron never fires and
  // then disappears with the record the one-off deletes after it runs.
  // Whichever the caller just set wins — a fresh cron clears a stale one-off,
  // otherwise the one-off wins as it does on create.
  if (next.runOnceAt && next.schedule) {
    if (touched.has("schedule") && !touched.has("runOnceAt")) {
      next.runOnceAt = undefined;
    } else {
      next.schedule = "";
    }
  }
  const sandboxValidation = validateSandboxAutomation(next);
  if (sandboxValidation) return sandboxValidation;
  return next;
}

/**
 * Apply caller input onto a base record: create passes a defaults record,
 * update passes the stored one. A field is only touched when the caller named
 * it, so an update leaves everything it didn't mention alone.
 */
function applyAutomationConfig(
  base: Automation,
  input: Record<string, unknown>,
): Automation | { error: string } {
  const next = { ...base };
  const touched = new Set<string>();
  for (const [field, validate] of Object.entries(AUTOMATION_FIELDS)) {
    if (!(field in input)) continue;
    const value = validate(input[field]);
    if (isFieldError(value)) return value;
    (next as Record<string, unknown>)[field] = value;
    touched.add(field);
  }
  return normalizeAutomation(next, touched);
}

export function createAutomation(input: {
  name: string;
  prompt: string;
  schedule: string;
  /** One-off ISO8601 instant; when set, `schedule` is ignored (forced to ""). */
  runOnceAt?: string;
  mode: "ask" | "code";
  createdBy: string;
  /** Defaults to true. Seeded automations pass false so an operator reads the
   * prompt before it runs — see recipes/README.md. */
  enabled?: boolean;
  eventKey?: string;
  mcpServers?: string[];
  repo?: string;
  prReviewer?: string;
  owner?: string;
  workspaceId?: string;
  selfImprove?: boolean;
  workflows?: boolean;
  claudeCliEnv?: boolean;
  codexCliEnv?: boolean;
  model?: string;
  fallbackModel?: string;
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  sandbox?: boolean;
  grafanaPoll?: GrafanaPollConfig;
  slackWatch?: SlackWatchConfig;
  inputs?: AutomationInput[];
  outputs?: AutomationOutput[];
  webhookEnabled?: boolean;
}): Automation | { error: string } {
  const base: Automation = {
    id: `auto-${randomUUIDv7()}`,
    name: "",
    prompt: "",
    schedule: "",
    mode: "ask",
    enabled: true,
    createdBy: input.createdBy || "Anonymous",
    createdAt: new Date().toISOString(),
    webhookSecret: generateSecret(),
  };
  const a = applyAutomationConfig(base, input as Record<string, unknown>);
  if ("error" in a) return a;
  saveAutomation(a);
  return a;
}

/** Create deployment-provided automations once. Source ships no company-
 * specific routines; instances opt in with `integrations.seeds.automations`. */
export function ensureConfiguredAutomations(): void {
  const raw = configuredIntegration("seeds").automations;
  if (!Array.isArray(raw)) return;
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as Record<string, unknown>;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
    const eventKey = typeof value.eventKey === "string" ? value.eventKey.trim() : "";
    if (!name || !prompt) continue;
    if (
      listAutomations().some(
        (automation) =>
          (eventKey && automation.eventKey === eventKey) ||
          (!eventKey && automation.name === name),
      )
    ) continue;
    const result = createAutomation({
      ...(value as any),
      name,
      prompt,
      eventKey: eventKey || undefined,
      schedule: typeof value.schedule === "string" ? value.schedule : "",
      mode: value.mode === "code" ? "code" : "ask",
      enabled: value.enabled !== false,
      createdBy:
        typeof value.createdBy === "string"
          ? value.createdBy
          : `${personaName()} (config seed)`,
    });
    if ("error" in result) {
      console.warn(`[automations] Config seed "${name}" skipped: ${result.error}`);
    } else {
      console.log(`[automations] Seeded configured automation "${name}"`);
    }
  }
}

export function updateAutomation(
  id: string,
  patch: Partial<Pick<Automation, "name" | "prompt" | "schedule" | "runOnceAt" | "mode" | "enabled" | "eventKey" | "mcpServers" | "repo" | "prReviewer" | "owner" | "workspaceId" | "selfImprove" | "workflows" | "claudeCliEnv" | "codexCliEnv" | "model" | "fallbackModel" | "accountId" | "accountStrict" | "usageCredits" | "sandbox" | "grafanaPoll" | "slackWatch" | "inputs" | "outputs" | "webhookEnabled">>
): Automation | { error: string } {
  const a = getAutomation(id);
  if (!a) return { error: "Automation not found" };
  const next = applyAutomationConfig(a, patch as Record<string, unknown>);
  if ("error" in next) return next;
  // Backfill secrets for automations created before webhook support
  if (!next.webhookSecret) next.webhookSecret = generateSecret();
  saveAutomation(next);
  return next;
}

/**
 * Prompt self-update for selfImprove automations (the opensession-self MCP's
 * write path). Own record only; a timestamped backup lands next to the record
 * and an audit event records the reason, so a bad self-edit is one `cp` from
 * undone. Length floor guards against self-lobotomy (a degenerate rewrite
 * that drops the prompt's structure and guardrails).
 */
function updateAutomationPromptSelf(
  id: string,
  newPrompt: string,
  reason: string
): { ok: true; backupPath: string } | { ok: false; error: string } {
  const a = getAutomation(id);
  if (!a) return { ok: false, error: "Automation not found." };
  const prompt = (newPrompt || "").trim();
  if (prompt.length < 500) {
    return {
      ok: false,
      error: `Refused: new prompt is ${prompt.length} chars — a full replacement this short would drop the prompt's structure/guardrails. Pass the COMPLETE prompt.`,
    };
  }
  if (!reason?.trim()) return { ok: false, error: "A one-line reason is required (audited)." };
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, "");
  const backupPath = `${AUTOMATIONS_DIR}/${id}.json.bak.self-${stamp}`;
  writeJsonAtomic(backupPath, a);
  const res = updateAutomation(id, { prompt });
  if ("error" in res) return { ok: false, error: res.error };
  audit({
    msg: "automation_self_update",
    automation_id: id,
    automation_name: a.name,
    reason: reason.trim().slice(0, 500),
    prompt_bytes_before: Buffer.byteLength(a.prompt, "utf8"),
    prompt_bytes_after: Buffer.byteLength(prompt, "utf8"),
    backup: backupPath,
  });
  return { ok: true, backupPath };
}

/**
 * The two scoped in-process servers a selfImprove automation run gets (see
 * the Automation.selfImprove doc). Used by runAutomation for scheduled/manual
 * runs AND — via selfImproveMcpForSession — by the interactive-resume paths
 * (run-session.ts, interactive-mcp.ts's run-rpc fallback builder), so a Slack
 * thread reply reaches a session with the same tools the nightly run had.
 */
export function selfImproveMcpServers(
  a: Automation,
  sessionId: string
): Record<string, unknown> {
  return {
    "opensession-sessions": createSessionsMcpServer({
      createdBy: `${a.name} (automation)`,
      isAdmin: false,
      automationSelf: true,
      currentSessionId: sessionId,
    }),
    "opensession-self": createSelfImproveMcpServer({
      automationName: a.name,
      getOwn: () => {
        const cur = getAutomation(a.id);
        if (!cur) return null;
        const { name, prompt, schedule, mode, repo, model, mcpServers } = cur;
        return { name, prompt, schedule, mode, repo, model, mcpServers };
      },
      updateOwnPrompt: (p, reason) => updateAutomationPromptSelf(a.id, p, reason),
    }),
  };
}

/** selfImproveMcpServers for a session file (automation resolved by the name
 *  stamped on the session) — undefined unless that automation has the flag. */
export function selfImproveMcpForSession(
  session: { automation?: string },
  sessionId: string
): Record<string, unknown> | undefined {
  if (!session.automation) return undefined;
  const a = listAutomations().find((x) => x.name === session.automation);
  if (!a?.selfImprove) return undefined;
  return selfImproveMcpServers(a, sessionId);
}

/** The automation-bar servers rebuilt for run-rpc's FALLBACK path. A real
 *  restart mid-run wipes the per-run registration (globalThis parking only
 *  survives hot reloads) while the reattached engine turn keeps calling its
 *  stdio proxies — so rebuild opensession-report (every run) and
 *  opensession-workflows (human-set `workflows` flag only) from the automation
 *  record, exactly the set runAutomation registers at dispatch. Never the
 *  admin/sessions siblings. */
export function automationRunMcpForSession(
  session: { automation?: string; worktreeDir?: string | null },
  sessionId: string
): Record<string, unknown> | undefined {
  if (!session.automation) return undefined;
  const a = listAutomations().find((x) => x.name === session.automation);
  if (!a) return undefined;
  const servers: Record<string, unknown> = {
    "opensession-report": createReportMcpServer({
      automationId: a.id,
      automationName: a.name,
      sessionId,
    }),
  };
  if (a.workflows) {
    const cwd = session.worktreeDir || getRepo(a.repo).repo;
    servers["opensession-workflows"] = createWorkflowsMcpServer({
      sessionId,
      user: `${a.name} (automation)`,
      workspace: (requestedRepo) =>
        !requestedRepo || requestedRepo === a.repo
          ? { cwd, repo: a.repo }
          : undefined,
      // A script's mcp.* surface is the automation's own least-privilege one —
      // it must never be a way around the allowlist or the denied writes.
      mcpAllowlist: a.mcpServers,
      deniedTools: AUTOMATION_DENIED_TOOLS,
    });
  }
  return servers;
}

/**
 * The COMPLETE in-process server set an automation run carries — report (every
 * run) + papercuts (per-repo toggle) + workflows / self-improve pair (human-set
 * flags) + turn. One builder, two callers: runAutomation at dispatch, and the
 * boot-resume rebuild (automationResumeMcpForSession below). Everything here
 * is held to the automation bar. The only non-append-only entries are
 * coordinator-side proxies for shared OAuth grants already named in the
 * automation's explicit MCP allowlist; provider credentials stay hidden.
 * The admin/sessions siblings must never join this set.
 */
function automationRunInProcessMcp(
  a: Automation,
  sessionId: string,
  ctx: {
    /** Resolved repo id (getRepo(a.repo).id) — papercuts toggle + workflow scope. */
    repoId: string;
    /** Working directory for workflow fan-outs (run worktree or ask checkout). */
    cwd: string;
    /** Live view of the run's model — a mid-run fallback swaps it (papercuts defaults). */
    model: () => string | undefined;
  }
): Record<string, unknown> {
  return {
    ...mcpOauthProxyServers(a.mcpServers ?? [], undefined, []),
    "opensession-report": createReportMcpServer({
      automationId: a.id,
      automationName: a.name,
      sessionId,
    }),
    ...(papercutsEnabledForRepo(ctx.repoId)
      ? {
          "opensession-papercuts": createPapercutsMcpServer({
            sessionId,
            runKind: "automation",
            by: `${a.name} (automation)`,
            defaults: () => ({ repo: ctx.repoId, model: ctx.model() }),
          }),
        }
      : {}),
    ...(a.workflows
      ? {
          "opensession-workflows": createWorkflowsMcpServer({
            sessionId,
            user: `${a.name} (automation)`,
            workspace: (requestedRepo) =>
              !requestedRepo || requestedRepo === ctx.repoId
                ? { cwd: ctx.cwd, repo: ctx.repoId }
                : undefined,
            // A script's mcp.* surface is the automation's own least-privilege
            // one — never a way around the allowlist or the denied writes.
            mcpAllowlist: a.mcpServers,
            deniedTools: AUTOMATION_DENIED_TOOLS,
          }),
        }
      : {}),
    ...(a.selfImprove ? selfImproveMcpServers(a, sessionId) : {}),
    // Held to the same bar as opensession-papercuts: append-only, reads
    // nothing, controls nothing. It only lets an unattended run say "I
    // looked and there was nothing to report" instead of ending on silence
    // that reads exactly like an early stop (src/server/turn-outcome.ts).
    "opensession-turn": createTurnMcpServer({ turnKey: sessionId }),
  };
}

/**
 * automationRunInProcessMcp for a session file — the boot/resume rebuild
 * (opensession.ts's inProcessMcpFor callback). A restart wipes the per-run
 * registration, and a re-prompted run on an in-process engine (pi) has no
 * surviving stdio proxies at all — so rebuild the run's full server set from
 * the automation record; for opencode the same set is harmless (its proxies
 * resolve through run-rpc's fail-closed automation fallback). Undefined when
 * the session isn't automation-owned or the automation record is gone (the
 * resumed run then proceeds without in-process tools, as before).
 */
export function automationResumeMcpForSession(
  session: { automation?: string; worktreeDir?: string | null; model?: string },
  sessionId: string
): Record<string, unknown> | undefined {
  if (!session.automation) return undefined;
  const a = listAutomations().find((x) => x.name === session.automation);
  if (!a) return undefined;
  const repo = getRepo(a.repo);
  return automationRunInProcessMcp(a, sessionId, {
    repoId: repo.id,
    cwd: session.worktreeDir || repo.repo,
    model: () => session.model,
  });
}

export function deleteAutomation(id: string): boolean {
  const path = `${AUTOMATIONS_DIR}/${id}.json`;
  if (!existsSync(path)) return false;
  unlinkSync(path);
  deleteAutomationInputState(id);
  deleteAutomationOutputState(id);
  return true;
}

// ── Runner ───────────────────────────────────────────────────

const runningCounts = new Map<string, number>();

const RUNS_CAP = 50;

/** Prepend a run-ledger entry (plus the legacy lastRun* mirror fields) on a
 *  fresh read of the automation — event/webhook runs can overlap, so never
 *  write ledger updates from a stale copy. */
function recordRunStart(id: string, run: AutomationRun): void {
  const fresh = getAutomation(id);
  if (!fresh) return;
  saveAutomation({
    ...fresh,
    lastRunAt: run.at,
    lastRunSessionId: run.sessionId,
    lastRunStatus: "running",
    lastRunError: undefined,
    lastTrigger: run.trigger,
    runs: [run, ...(fresh.runs || [])].slice(0, RUNS_CAP),
  });
}

/** Settle the ledger entry for `sessionId` (matched by id, not position, so
 *  overlapping runs settle independently). */
function settleRun(id: string, sessionId: string, patch: Pick<AutomationRun, "status" | "error" | "durationMs">): void {
  const fresh = getAutomation(id);
  if (!fresh) return;
  saveAutomation({
    ...fresh,
    ...(fresh.lastRunSessionId === sessionId
      ? { lastRunStatus: patch.status, lastRunError: patch.error }
      : {}),
    runs: (fresh.runs || []).map((r) => (r.sessionId === sessionId ? { ...r, ...patch } : r)),
  });
}

/**
 * Settle the ledger entry for a session whose run finished OUTSIDE
 * runAutomation — the boot-resume path (resumeInterruptedRuns) drives runs
 * that were live at a restart, and settleRun only fires in-process, so every
 * such run used to stay "running" in the ledger forever (97 stranded entries
 * counted 2026-08-10). Called from the resume sweep's terminal callback;
 * returns true when a running entry was settled. Old corpses from before
 * this hook stay as they are — this settles runs the sweep actually drove
 * to an end, it does not rewrite history.
 */
export function settleResumedAutomationRun(sessionId: string, error: string | null): boolean {
  for (const automation of listAutomations()) {
    const run = (automation.runs || []).find((r) => r.sessionId === sessionId);
    if (!run || run.status !== "running") continue;
    settleRun(automation.id, sessionId, {
      status: error ? "error" : "ok",
      error: error || undefined,
      durationMs: Math.max(0, Date.now() - new Date(run.at).getTime()),
    });
    console.log(
      `[automations] Settled resumed run ${sessionId} for "${automation.name}" (${error ? "error" : "ok"})`
    );
    return true;
  }
  return false;
}


/** Tool-permission denials applied to every automation run (and to interactive
 *  resumes of automation-owned sessions). Read-only toward customers/identity. */
export function automationDeniedTools(): Record<string, string> {
  return AUTOMATION_DENIED_TOOLS;
}

/** MCP allowlist for an automation, resolved by its display name (as stored on
 *  a session's `automation` field). Returns undefined if not found. */
export function automationMcpServersByName(name: string): string[] | undefined {
  return listAutomations().find((a) => a.name === name)?.mcpServers;
}

/** Default engine+model for automations. Model-less routines use the same Sol
 * tier as before, now on Pi's ChatGPT-subscription path. */
export const DEFAULT_PI_AUTOMATION_MODEL = "pi/openai/gpt-5.6-sol";

/** Map an automation's stored model, a router override, or a fallback onto Pi
 * while preserving the concrete provider/model tier. Legacy OpenCode-prefixed
 * ids migrate in place, so old records cannot silently keep the old engine. */
export function automationModel(model?: string): string | undefined {
  const requested = (model || "").trim();
  if (!requested) return DEFAULT_PI_AUTOMATION_MODEL;
  return toPiModel(requested) || requested;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "automation";
}

function sandboxAutomationMcpEgress(mcpServers: string[]): string[] {
  const destinations = new Set<string>();
  const projected = filterMcpServers(mcpServers, undefined, []);
  for (const config of Object.values(projected)) {
    if (!config || typeof config !== "object") continue;
    const entry = config as Record<string, unknown>;
    if (typeof entry.url === "string") destinations.add(entry.url);
    if (entry.env && typeof entry.env === "object") {
      for (const value of Object.values(entry.env as Record<string, unknown>)) {
        if (typeof value === "string" && /^(?:https?|wss?):\/\//i.test(value))
          destinations.add(value);
      }
    }
  }
  return [...destinations];
}

export function isAutomationRunning(id: string): boolean {
  return (runningCounts.get(id) || 0) > 0;
}

export async function runAutomation(
  automation: Automation,
  onSessionCreated?: (sessionId: string) => void,
  options?: {
    trigger?: "cron" | "webhook" | "manual" | "event";
    eventContext?: string;
    /**
     * Pre-generated opensession session id. Lets a caller post UI/Slack controls
     * that reference the session (e.g. an "Open in Open Session" link and a Stop
     * button) before the run starts, instead of waiting for onSessionCreated.
     */
    osSessionId?: string;
    /**
     * Model for THIS run only, beating the automation's configured model —
     * e.g. the Plain ticket router downgrading a basic ticket to a cheaper
     * model. Callers pass an already-resolved model id.
     */
    modelOverride?: string;
  }
): Promise<void> {
  const trigger = options?.trigger || "manual";
  // Cron/manual runs don't stack; event/webhook runs are per-event, so they may overlap
  const concurrent = trigger === "event" || trigger === "webhook";
  if (!concurrent && isAutomationRunning(automation.id)) {
    console.log(`[automations] "${automation.name}" still running, skipping`);
    return;
  }
  runningCounts.set(automation.id, (runningCounts.get(automation.id) || 0) + 1);

  const startedAt = new Date();
  const stamp = startedAt.toISOString().slice(0, 16).replace("T", " ");
  const bksId = options?.osSessionId || newSessionId();
  let sandboxRpcToken: string | undefined;

  try {
    const runtimeSandboxValidation = validateSandboxAutomation(automation);
    if (runtimeSandboxValidation) throw new Error(runtimeSandboxValidation.error);
    // The automation's repo (instance default when omitted). Ask mode reads the repo's
    // pinned ask checkout (default branch — never the mutable main checkout);
    // code mode gets an isolated worktree — `isolated` matters for
    // shared-checkout repos (opensession), where an unattended run must never
    // work in the live checkout: it ships a PR and a human merges.
    const repo = getRepo(automation.repo);
    let cwd = "";
    let branch = "";
    let sandbox: Sandbox | undefined;
    if (automation.mode === "code") {
      branch = `auto-${slugify(automation.name)}-${startedAt
        .toISOString()
        .slice(0, 16)
        .replace(/[-T:]/g, "")}`;
      if (!automation.sandbox) {
        const worktrees = await listWorktrees(repo.id);
        cwd =
          worktrees.find((w) => w.branch === branch)?.path ||
          (await createWorktree(branch, repo.id, { isolated: true }));
      }
    } else {
      branch = repo.defaultBranch;
      if (!automation.sandbox) cwd = await ensureAskCheckout(repo.id);
    }
    if (automation.sandbox) {
      const automationSandbox = sandboxAutomationConfig();
      const provider = getSandboxProvider(automationSandbox.provider);
      sandbox = await provider.ensure({
        sessionId: bksId,
        repo: repo.id,
        branch,
        mode: automation.mode,
        trustProfile: "automation",
        egressAllowlist: [
          ...(automationSandbox.egressAllowlist || []),
          ...sandboxAutomationMcpEgress(automation.mcpServers || []),
        ],
      });
      cwd = sandbox.cwd;
    }

    recordRunStart(automation.id, {
      at: startedAt.toISOString(),
      sessionId: bksId,
      trigger,
      status: "running",
    });

    const preparedInputs = await prepareAutomationInputs({
      automationId: automation.id,
      inputs: automation.inputs,
      startedAt,
    });
    let prompt = automation.prompt;
    // Tell the run which model it's executing as, so a prompt that wants to
    // record it (e.g. Plain triage stamps the model on its note) can quote an
    // accurate name instead of guessing. This is the model the run STARTS on;
    // a mid-run usage-limit fallback can swap it (tracked in modelHistory), so
    // word it as "started on".
    {
      const runModelForPrompt = automationModel(
        options?.modelOverride || automation.model,
      );
      const displayModel = (runModelForPrompt || "").replace(
        /^(?:opencode|pi)\/[^/]+\//,
        "",
      );
      if (displayModel)
        prompt += `\n\n## Model\n\nThis run started on the \`${displayModel}\` model.`;
    }
    if (preparedInputs.note) prompt += `\n\n${preparedInputs.note}`;
    const outputInstructions = automationOutputInstructions(automation.outputs);
    if (outputInstructions) prompt += `\n\n${outputInstructions}`;
    if (options?.eventContext) {
      const source =
        trigger !== "event"
          ? "a webhook"
          : automation.slackWatch
            ? `a new message in the Slack channel this automation watches (<#${automation.slackWatch.channel}>)`
            : `an internal event (${automation.eventKey})`;
      prompt += `\n\n## Triggering event\n\nThis run was triggered by ${source}. Event payload:\n\n\`\`\`\n${options.eventContext.slice(0, 10_000)}\n\`\`\``;
    }

    // Channel-watch runs get the channel's memory (facts taught via
    // remember/forget in interactive Slack sessions) as standing context.
    // Read-only here — automation runs don't get the memory tools.
    if (automation.slackWatch) {
      try {
        const { renderMemoryForPrompt } = await import("../agents/slack/memory");
        prompt += await renderMemoryForPrompt({
          channel: automation.slackWatch.channel,
          userId: "",
          isDM: false,
          isPrivate: true, // per-channel scope + read-only workspace view
        });
      } catch {}
    }

    // Repo + team memory (taught via opensession-memory in interactive
    // sessions) as standing context. Read-only — automation runs never get
    // the memory write tools (untrusted event text must not be able to plant
    // standing context). Channel-watch runs already carry the workspace store
    // via the channel memory above, so skip the team scope for them.
    try {
      const { renderSessionMemoryNote, sessionMemoryScopes } = await import(
        "./session-memory"
      );
      const note = await renderSessionMemoryNote(
        sessionMemoryScopes({
          repos: [getRepo(automation.repo).id],
          includeTeam: !automation.slackWatch,
        })
      );
      if (note) prompt += `\n\n${note}`;
    } catch {}

    // Tie the session to its Plain thread (if the event carries one) so it
    // can be archived when the ticket is done, and use the ticket's
    // title as the session title
    let plainThreadId: string | undefined;
    let eventTitle: string | undefined;
    if (options?.eventContext) {
      try {
        const parsed = JSON.parse(options.eventContext);
        if (typeof parsed.threadId === "string") plainThreadId = parsed.threadId;
        if (typeof parsed.title === "string" && parsed.title.trim()) {
          eventTitle = parsed.title.trim().slice(0, 100);
        }
      } catch {}
    }
    // File ticket-triggered sessions under the ticket's ONE workspace so they
    // show up as session tabs there (adopt-don't-duplicate; workspace-resolve.ts).
    let ticketWorkspaceId: string | undefined;
    if (plainThreadId) {
      try {
        ticketWorkspaceId = resolvePlainWorkspace({
          threadId: plainThreadId,
          title: eventTitle,
          createdBy: `${automation.name} (automation)`,
        }).workspace.id;
      } catch {}
    }

    // Automations dispatch on Pi (tier-preserving mapping; see
    // automationModel). The effective model/provider can change mid-run on a
    // usage-limit fallback, so track it from runner events for persistence.
    const runModel = automationModel(options?.modelOverride || automation.model);
    let effectiveModel = runModel;
    let selectedModel = runModel;
    let effectiveProvider = providerFor(effectiveModel);
    const modelHistory: NonNullable<NativeSessionFile["modelHistory"]> = [];
    // Slack messages this run posts (via the slack MCP, or via bash+curl
    // announcing a SLACK_MSG_POSTED marker) — captured from the tool stream so
    // a human reply in one of those threads routes back to THIS session
    // (thread index in slack-links.ts) instead of starting a new one. The same
    // scanner runs in recordRecoveredRunEvent (run-session.ts) so posts made
    // after a restart-reattach are captured too.
    const slackThreads: Array<{ channel: string; threadTs: string }> = [];
    const slackPostScan = createSlackPostScanner();
    const linkSlackThread = (
      engineSessionId: string,
      channel?: string,
      threadTs?: string,
    ) => {
      if (!channel || !threadTs) return;
      if (slackThreads.some((t) => t.channel === channel && t.threadTs === threadTs))
        return;
      slackThreads.push({ channel, threadTs });
      // Live-link + persist immediately so a fast reply routes even while
      // the run is still going (fire-and-forget: the per-session write chain
      // orders it against the init/final persists).
      linkThreadInIndex(bksId, channel, threadTs);
      persistSession(engineSessionId).catch((e) =>
        console.error(`[automations] session persist failed for ${bksId}:`, e)
      );
    };
    // Field-scoped write: creation fields are create-if-absent defaults (an
    // existing file — e.g. one an interactive thread-reply resume already
    // wrote to — wins); this run only owns the engine-id/model fields, the
    // HEAD-synced branch, and the Slack threads it posted. Serialized via
    // updateSessionFile.
    const persistSession = (engineSessionId: string) =>
      updateSessionFile(bksId, (data) => {
        // Widen to Partial: the file may not exist yet (create-if-absent).
        const existing: Partial<NativeSessionFile> = data;
        return {
          id: bksId,
          claudeSessionId: "",
          worktreeDir: cwd,
          createdBy: `${automation.name} (automation)`,
          createdAt: startedAt.toISOString(),
          title: eventTitle || `${automation.name} — ${stamp}`,
          mode: automation.mode,
          automation: automation.name,
          automationId: automation.id,
          ...(sandbox
            ? {
                sandbox: {
                  provider: sandbox.provider,
                  sandboxId: sandbox.id,
                  workspace: sandbox.workspace,
                },
              }
            : {}),
          // Keep the automation's account pin on the session so interactive
          // resumes of this session run on the same subscription.
          ...(automation.accountId ? { accountId: automation.accountId } : {}),
          // Keep the trigger payload so a thread reply of "retrigger" can replay
          // this exact run (same truncation as the prompt embed).
          ...(options?.eventContext
            ? { automationEvent: options.eventContext.slice(0, 10_000) }
            : {}),
          ...(plainThreadId ? { plainThreadId } : {}),
          ...(ticketWorkspaceId ? { workspaceId: ticketWorkspaceId } : {}),
          ...existing,
          ...(engineSessionId
            ? engineSessionPatch(effectiveProvider, engineSessionId)
            : {}),
          ...(engineSessionId ? { lastEngineProvider: effectiveProvider } : {}),
          ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(modelHistory.length ? { modelHistory } : {}),
          // Code-mode runs can rename their auto-generated branch before opening
          // a PR — record the worktree's actual HEAD so PR lookups and the
          // review handoff keep resolving this session.
          branch: sandbox ? branch : (branch && worktreeHeadBranch(cwd)) || branch,
          ...(slackThreads.length ? { slackThreads: [...slackThreads] } : {}),
          lastActivity: new Date().toISOString(),
        };
      });

    console.log(
      `[automations] Running "${automation.name}" → ${bksId}${runModel ? ` (${runModel})` : ""}${options?.modelOverride ? " [routed]" : ""}`
    );

    // In-process servers for automation runs — the full automation-bar set
    // (see automationRunInProcessMcp; the run-rpc builder in
    // interactive-mcp.ts fails closed so an automation session can never
    // resolve the admin/sessions siblings through the same socket).
    // Registered per run so the proxies execute THESE instances with
    // automation context — kept even when the primary is a pi model (direct
    // in-memory mounting, no proxies): a mid-run usage-limit fallback can
    // land the run on opencode, whose stdio proxies need this registration.
    const inProcessMcp = automationRunInProcessMcp(automation, bksId, {
      repoId: repo.id,
      cwd,
      model: () => effectiveModel,
    });
    registerSessionMcpServers(bksId, inProcessMcp);

    let engineSessionId = "";
    let errorMsg = "";
    // Tail of the assistant's text: an automation whose prompt declares
    // failure (`RUN STATUS: failed — …` / `SCAN STATUS: failed — …` as the
    // final line) settles the ledger as error instead of "the turn finished
    // ⇒ ok" (the deepsec scans recorded ok for days of zero-batch runs).
    // Opt-in by emission — automations that never declare are unaffected.
    let textTail = "";
    const fallbackModel = (() => {
      if (automation.fallbackModel === "none" || automation.sandbox) return undefined;
      const fb = automation.fallbackModel || DEFAULT_FALLBACK_MODEL;
      return fb ? automationModel(fb) : undefined;
    })();
    let events: AsyncGenerator<StreamEvent>;
    if (sandbox) {
      sandboxRpcToken = crypto.randomUUID();
      registerRunToken(sandboxRpcToken, { sessionId: bksId });
      const spec: RunHostSpec = {
        hostId: `rh-${randomUUIDv7()}`,
        osSessionId: bksId,
        prompt,
        cwd,
        mode: automation.mode,
        model: runModel,
        selectedModel: runModel,
        mcpServers: automation.mcpServers || [],
        proxyMcpServers: Object.keys(inProcessMcp),
        rpcToken: sandboxRpcToken,
        deniedTools: AUTOMATION_DENIED_TOOLS,
        confirmTools: STRIPE_CONFIRM_TOOLS,
        aws: false,
        claudeCliEnv: !!automation.claudeCliEnv,
        codexCliEnv: !!automation.codexCliEnv,
        fallbackModel,
        accountId: automation.accountId,
        accountStrict: true,
        usageCredits: automation.usageCredits,
        // PRs opened from the sandboxed run carry the automation's review
        // policy, same as the in-process runAgent call below.
        prReviewer: automation.prReviewer,
        journalKind: "automation",
        trustProfile: "automation",
      };
      const handle = sandbox.launchRunEager
        ? await sandbox.launchRunEager(spec)
        : sandbox.launchRun(spec);
      events = handle.events();
    } else {
      const common = {
        prompt,
        cwd,
        mode: automation.mode,
        model: runModel,
        mcpServers: (automation.mcpServers ?? "all") as "all" | string[],
        deniedTools: AUTOMATION_DENIED_TOOLS,
        // No onAskUser here, so confirm tools deny with "propose it for a human".
        confirmTools: STRIPE_CONFIRM_TOOLS,
        aws: true, // host automations keep short-lived instance-role read creds
        claudeCliEnv: !!automation.claudeCliEnv,
        codexCliEnv: !!automation.codexCliEnv,
        accountId: automation.accountId,
        accountStrict: !!automation.accountId && automation.accountStrict !== false,
        usageCredits: automation.usageCredits,
        fallbackModel,
        prReviewer: automation.prReviewer,
        // The automation is the commit author. Nobody sent this prompt, so the
        // instance identity would otherwise collapse every routine into one.
        author: labelIdentity(automation.name),
      };
      events = providerFor(runModel) === "pi"
        ? runAgentHosted({
            ...common,
            osSessionId: bksId,
            proxyMcpServers: Object.keys(inProcessMcp),
            fallbackInProcessMcp: () => inProcessMcp,
            journalKind: "automation",
            trustProfile: "automation",
          })
        : runAgent({
            ...common,
            inProcessMcp,
            journal: { osSessionId: bksId, kind: "automation" },
          });
    }
    for await (const event of events) {
      if (event.type === "init") {
        engineSessionId = event.sessionId || "";
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
        await persistSession(engineSessionId);
        onSessionCreated?.(bksId);
      }
      // Capture Slack posts (slack MCP calls + SLACK_MSG_POSTED markers from
      // bash-side posters like dispute_report_pdf.sh) — see
      // createSlackPostScanner in slack-links.ts.
      const slackPost = slackPostScan(event);
      if (slackPost) {
        linkSlackThread(engineSessionId, slackPost.channel, slackPost.threadTs);
      }
      if (event.type === "model_switch") {
        const to = event.toModel || "";
        if (to) {
          effectiveModel = to;
          effectiveProvider = providerFor(to);
          if (shouldPersistModelSwitch(event)) {
            selectedModel = to;
            modelHistory.push({
              model: to,
              at: new Date().toISOString(),
              by: `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`,
            });
          }
        }
      }
      if (event.type === "done") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
      }
      if (event.type === "text_chunk" && event.text) {
        textTail = (textTail + event.text).slice(-16384);
      }
      if (event.type === "error") {
        errorMsg = event.content || "Unknown error";
      }
    }
    if (!errorMsg) errorMsg = declaredRunFailure(textTail) || "";

    await persistSession(engineSessionId);

    if (!errorMsg) {
      await deliverAutomationOutputs({
        automationId: automation.id,
        outputs: automation.outputs,
        sessionId: bksId,
        startedAt,
      });
      preparedInputs.commit();
    }

    settleRun(automation.id, bksId, {
      status: errorMsg ? "error" : "ok",
      error: errorMsg || undefined,
      durationMs: Date.now() - startedAt.getTime(),
    });
    console.log(
      `[automations] "${automation.name}" finished ${errorMsg ? `with error: ${errorMsg}` : "ok"}`
    );
  } catch (e: any) {
    console.error(`[automations] "${automation.name}" failed:`, e);
    settleRun(automation.id, bksId, {
      status: "error",
      error: e.message || String(e),
      durationMs: Date.now() - startedAt.getTime(),
    });
  } finally {
    unregisterRunToken(sandboxRpcToken);
    unregisterSessionMcpServers(bksId);
    const left = (runningCounts.get(automation.id) || 1) - 1;
    if (left <= 0) runningCounts.delete(automation.id);
    else runningCounts.set(automation.id, left);
  }
}

// ── Internal event bus ───────────────────────────────────────
// Agents (Plain/Slack/Linear) publish events; automations subscribe
// via their eventKey. Each event gets its own run (may overlap).

let eventSessionCallback: ((sessionId: string) => void) | undefined;

export function setEventSessionCallback(cb: (sessionId: string) => void): void {
  eventSessionCallback = cb;
}

/**
 * Re-fire the automation behind an automation-created session, replaying the
 * original triggering event payload (stored on the session file). Used by the
 * Slack handlers: a thread reply of "retrigger" under a message the run posted
 * starts a fresh run instead of steering the old session. Fire-and-forget —
 * the new run posts its own results.
 */
export function retriggerAutomationSession(
  sessionId: string,
): { ok: true; name: string } | { ok: false; reason: string } {
  let session: NativeSessionFile;
  try {
    session = JSON.parse(
      readFileSync(`${SESSIONS_DIR}/${sessionId}.json`, "utf-8"),
    );
  } catch {
    return { ok: false, reason: `session ${sessionId} not found` };
  }
  // automationId is stamped since 2026-07-16; older sessions only carry the
  // automation's name — fall back to matching on that.
  const automation = session.automationId
    ? getAutomation(session.automationId)
    : session.automation
      ? (listAutomations().find((a) => a.name === session.automation) ?? null)
      : null;
  if (!automation) {
    return {
      ok: false,
      reason: `no automation found for session ${sessionId} (${session.automation || "not an automation session"})`,
    };
  }
  if (!automation.enabled) {
    return { ok: false, reason: `automation "${automation.name}" is disabled` };
  }
  // With a stored event payload, replay it as an event run (concurrent-safe,
  // like the original). Without one (cron/manual automations) run it plainly —
  // "manual" also gives the still-running skip guard.
  void runAutomation(automation, eventSessionCallback, {
    trigger: session.automationEvent ? "event" : "manual",
    eventContext: session.automationEvent,
  });
  return { ok: true, name: automation.name };
}

/** True when at least one enabled automation watches this Slack channel —
 *  cheap pre-check so the Slack intake doesn't build payloads for nothing. */
export function isChannelWatched(channelId: string): boolean {
  return listAutomations().some((a) => a.enabled && a.slackWatch?.channel === channelId);
}

/** Fire every enabled automation watching `channelId` (one run per message —
 *  these may overlap, like event runs). Returns how many fired. */
export function fireAutomationsForSlackChannel(channelId: string, payload: string): number {
  let fired = 0;
  for (const automation of listAutomations()) {
    if (!automation.enabled || automation.slackWatch?.channel !== channelId) continue;
    console.log(`[automations] Watched channel ${channelId} → "${automation.name}"`);
    void runAutomation(automation, eventSessionCallback, {
      trigger: "event",
      eventContext: payload,
    });
    fired++;
  }
  return fired;
}

export function fireAutomationsForEvent(
  eventKey: string,
  payload: string,
  opts?: { modelOverride?: string }
): number {
  let fired = 0;
  for (const automation of listAutomations()) {
    if (!automation.enabled || automation.eventKey !== eventKey) continue;
    console.log(`[automations] Event ${eventKey} → "${automation.name}"`);
    void runAutomation(automation, eventSessionCallback, {
      trigger: "event",
      eventContext: payload,
      modelOverride: opts?.modelOverride,
    });
    fired++;
  }
  return fired;
}

// ── Scheduler ────────────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let lastFiredMinute = "";

export function startScheduler(onSessionCreated?: (sessionId: string) => void): void {
  if (schedulerInterval) return;

  schedulerInterval = setInterval(() => {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16);
    if (minuteKey === lastFiredMinute) return;
    lastFiredMinute = minuteKey;

    for (const automation of listAutomations()) {
      if (!automation.enabled) continue;

      // One-off runs (reminders / "do this again later"): fire once at/after the
      // target instant, then delete. We persist a "consumed" copy (runOnceAt
      // cleared, disabled) BEFORE firing so a long-running or crashed run can
      // never double-fire on a later tick; the file is deleted once it settles.
      if (automation.runOnceAt) {
        if (Date.parse(automation.runOnceAt) <= now.getTime()) {
          saveAutomation({ ...automation, runOnceAt: undefined, enabled: false });
          void runAutomation({ ...automation, runOnceAt: undefined, enabled: false }, onSessionCreated, {
            trigger: "cron",
          }).finally(() => deleteAutomation(automation.id));
        }
        continue;
      }

      if (!automation.schedule) continue;
      if (cronMatches(automation.schedule, now)) {
        // Fire and forget — runner guards against overlap per automation
        void runAutomation(automation, onSessionCreated, { trigger: "cron" });
      }
    }
  }, 20_000);

  console.log("[automations] Scheduler started (20s tick, UTC cron)");
}

// ── Webhook trigger ──────────────────────────────────────────
// POST /automations/<id>/<secret> on the public webhook server (3848,
// proxied by Caddy). The secret in the path is the only auth, so it's
// long-random and rotatable by editing the automation file.

export function getWebhookRoutes(
  onSessionCreated?: (sessionId: string) => void
): Map<string, (req: Request, url: URL) => Promise<Response>> {
  const routes = new Map<string, (req: Request, url: URL) => Promise<Response>>();

  routes.set("POST /automations/*", async (req, url) => {
    const m = url.pathname.match(/^\/automations\/([^/]+)\/([^/]+)$/);
    if (!m) return Response.json({ error: "Bad path" }, { status: 400 });

    const automation = getAutomation(m[1]);
    // Same response for unknown id and bad secret — don't leak which ids exist
    if (
      !automation ||
      automation.webhookEnabled === false ||
      !automation.webhookSecret ||
      automation.webhookSecret !== m[2]
    ) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!automation.enabled) {
      return Response.json({ ok: false, skipped: "disabled" });
    }
    if (isAutomationRunning(automation.id)) {
      return Response.json({ ok: false, skipped: "already running" });
    }

    let payload = "";
    try {
      payload = await readRequestTextWithinLimit(req, 10_000);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return webhookBodyTooLargeResponse(10_000);
      throw error;
    }

    console.log(`[automations] Webhook trigger: "${automation.name}"`);
    void runAutomation(automation, onSessionCreated, {
      trigger: "webhook",
      eventContext: payload || "(empty body)",
    });

    return Response.json({ ok: true });
  });

  return routes;
}
