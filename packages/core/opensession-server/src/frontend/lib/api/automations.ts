import { z } from "zod";
import { ApiError, BASE, request } from "./request";

// ── Automations ──

export interface ModelOption {
  id: string;
  provider: "claude" | "codex" | "pi";
  label: string;
  aliases: string[];
  efforts: string[];
  /** Presets fix the lead model's effort instead of offering a ladder. */
  fixedEffort?: string;
  /** Provider account pool available to this model, if any. */
  accountProvider?: "claude" | "codex" | "xai";
  /** Picker section override ("dial" = The Dial presets). */
  group?: string;
  /** One-line subtitle shown under the label (dial presets). */
  description?: string;
  /** Concrete lead and supporting models participating in a preset. */
  composition?: string[];
  /** This model has subscription-backend priority-tier variants configured. */
  fastModeSupported?: boolean;
}

type ModelCatalog = { models: ModelOption[]; default: string };

const suggestBranchResponseSchema = z.object({ branch: z.string().optional() });
const transcribeResponseSchema = z
  .object({
    text: z.string().optional(),
    error: z.string().optional(),
  })
  .nullable();

/**
 * Ask the backend (a quick Haiku call) to suggest a branch name for a task
 * prompt. Returns null when the prompt is too thin or anything fails — callers
 * just leave the field for the user to fill.
 */
export async function suggestBranch(prompt: string): Promise<string | null> {
  try {
    const data = suggestBranchResponseSchema.parse(
      await request<object>("/suggest-branch", {
        method: "POST",
        body: { prompt },
      }),
    );
    return data.branch ?? null;
  } catch {
    return null;
  }
}

/** Voice dictation: send a recorded clip (raw body), get the transcript back.
 * Bypasses `request` — the body is audio bytes, not JSON. */
export async function transcribeClip(audio: Blob): Promise<string> {
  const res = await fetch(`${BASE}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": audio.type || "audio/webm" },
    body: audio,
  });
  const parsed = transcribeResponseSchema.safeParse(
    await res.json().catch(() => null),
  );
  const data = parsed.success ? parsed.data : null;
  if (!res.ok) {
    throw new ApiError(data?.error ?? `Transcribe: ${res.status}`, res.status);
  }
  return data?.text ?? "";
}

export async function fetchModels(workspaceId?: string): Promise<ModelCatalog> {
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspace", workspaceId);
  return request<ModelCatalog>(`/models${params.size ? `?${params}` : ""}`, {
    label: "Failed to fetch models",
  });
}

/** Trimmed provider account shape for the per-session account picker. */
export interface ProviderAccountOption {
  id: string;
  name: string;
  email?: string;
  provider: "claude" | "codex" | "xai";
  /** Personal-sub owner, if any (else it's a shared-pool account). */
  owner?: string;
  /** False when the account is currently exhausted / over its cap. */
  usable: boolean;
  /** Credential mechanism; Fast mode is unavailable for direct API keys. */
  kind?: string;
}

const providerAccountRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  owner: z.string().optional(),
  usable: z.boolean().optional(),
  kind: z.string().optional(),
});

const providerAccountsResponseSchema = z.object({
  accounts: z.array(providerAccountRecordSchema).optional(),
});

export async function fetchProviderAccounts(options?: {
  onPoolError?: (cause: unknown) => void;
}): Promise<ProviderAccountOption[]> {
  const fetchPool = async (
    provider: "claude" | "codex" | "xai",
    path: string,
  ) => {
    try {
      const data = providerAccountsResponseSchema.parse(
        await request<object>(path),
      );
      return (data.accounts ?? []).map((account) => ({
        id: account.id,
        name: account.name,
        email: account.email,
        provider,
        owner: account.owner,
        usable: account.usable !== false,
        kind: account.kind,
      }));
    } catch (cause: unknown) {
      options?.onPoolError?.(cause);
      // Account pins are optional because automatic pool selection remains
      // valid. Keep accounts from the other provider available when one pool
      // cannot load.
      return [];
    }
  };
  const [claude, codex, xai] = await Promise.all([
    fetchPool("claude", "/claude-accounts"),
    fetchPool("codex", "/codex-accounts"),
    fetchPool("xai", "/xai-accounts"),
  ]);
  return [...claude, ...codex, ...xai];
}

export interface AutomationRun {
  at: string;
  sessionId: string;
  trigger: "cron" | "webhook" | "manual" | "event";
  status: "running" | "ok" | "error";
  error?: string;
  durationMs?: number;
}

export interface AutomationInput {
  id: string;
  label?: string;
  window?: {
    mode?: "since_last_success" | "rolling";
    minutes?: number;
    overlapMinutes?: number;
  };
  reduce?: { model?: string; instructions?: string; maxOutputChars?: number };
  source:
    | {
        type: "slack_channel";
        channel: string;
        includeThreads?: boolean;
        includeBots?: boolean;
        limit?: number;
      }
    | { type: "reports"; automationId: string; limit?: number };
}

export type AutomationOutput =
  | {
      id: string;
      type: "report";
      enabled?: boolean;
      publish?: "always" | "on_findings";
    }
  | {
      id: string;
      type: "slack";
      enabled?: boolean;
      channel: string;
      minUrgency?: "low" | "medium" | "high" | "critical";
      minConfidence?: "low" | "medium" | "high";
    };

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  mode: "ask" | "code";
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  webhookSecret?: string;
  webhookEnabled?: boolean;
  eventKey?: string;
  mcpServers?: string[];
  slackWatch?: { channel: string };
  inputs?: AutomationInput[];
  outputs?: AutomationOutput[];
  owner?: string;
  workspaceId?: string;
  model?: string;
  fallbackModel?: string;
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  sandbox?: boolean;
  lastRunAt?: string;
  lastRunSessionId?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  lastTrigger?: "cron" | "webhook" | "manual" | "event";
  nextRunAt: string | null;
  isRunning?: boolean;
  runs?: AutomationRun[];
}

export async function fetchAutomations(): Promise<Automation[]> {
  return request("/automations", {
    label: "Failed to fetch automations",
  });
}

/**
 * One automation as the sidebar's Automations band needs it: who owns it,
 * where it files, and the outcome of its latest run.
 */
export interface AutomationOverview {
  id: string;
  name: string;
  enabled: boolean;
  repo?: string;
  workspaceId?: string;
  workspaceName?: string;
  /** The workspace's own repo, so the repo lens can match through it. */
  workspaceRepo?: string;
  owner?: string;
  lastRunAt?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunSessionId?: string;
  latestReport?: {
    id: string;
    title: string;
    summary?: string;
    urgency?: "low" | "medium" | "high" | "critical";
    confidence?: "low" | "medium" | "high";
    createdAt: string;
    sessionId?: string;
  };
}

export async function fetchAutomationOverview(): Promise<AutomationOverview[]> {
  const result = await request<{ automations: AutomationOverview[] }>(
    "/automations/overview",
    { label: "Failed to load automations" },
  );
  return result.automations;
}

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  category: "sweep" | "digest" | "investigator" | "triage" | "hygiene";
  prompt: string;
  schedule: string;
  mode: "ask" | "code";
  mcpServers?: string[];
  eventKey?: string;
}

export async function fetchAutomationTemplates(): Promise<
  AutomationTemplate[]
> {
  const res = await fetch(`${BASE}/automation-templates`);
  if (!res.ok) throw new Error(`Failed to fetch templates: ${res.status}`);
  return res.json();
}

export interface AutomationDraft {
  name: string;
  prompt: string;
  schedule: string;
  mode: "ask" | "code";
  mcpServers?: string[];
  eventKey?: string;
}

/** Draft an automation config from a free-text description (backend Haiku
 *  call). Throws with a friendly message when the draft fails. */
export async function draftAutomationApi(
  description: string,
): Promise<AutomationDraft> {
  const res = await fetch(`${BASE}/automations/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
  return body;
}

/** MCP server list + agent health, for pickers (Automations) and Settings. */
export async function fetchConnections(): Promise<{
  mcpServers: Array<{ name: string; status: string; allowedUsers?: string[] }>;
  engines?: string[];
}> {
  const res = await fetch(`${BASE}/connections`);
  if (!res.ok) throw new Error(`Failed to fetch connections: ${res.status}`);
  return res.json();
}

/** Provider-independent model-family sandboxability from the server. */
export interface SandboxModelFamilyInfo {
  id: string;
  label: string;
  match: { provider: "claude" | "codex" | "pi" };
  sandboxable: boolean;
  hint?: string;
}

/** Sandbox capability status for the New-session provider picker
 *  (GET /api/sandbox/status — read fresh server-side per call). */
export interface SandboxStatusInfo {
  enabled: boolean;
  defaultProvider: string;
  providers: Array<{
    id: "docker" | "daytona" | "e2b" | "box" | "modal" | "lambda-microvm";
    configured: boolean;
    certified: boolean;
    lastPassedAt?: string;
    note?: string;
  }>;
  killSwitch: boolean;
  defaults?: {
    workspace: string;
    personal: string;
    effective: string;
  };
  connections?: SandboxConnectionInfo[];
  operations?: SandboxOperationInfo[];
  ingress?: SandboxIngressInfo;
  canManage?: boolean;
  /** Absent on a pre-upgrade server = no client-side combo warnings. */
  modelFamilies?: SandboxModelFamilyInfo[];
  /** Disposable automation Executor availability. */
  automation?: {
    provider: "daytona";
    available: boolean;
    reason?: string;
  };
}

export type SandboxConnectionState =
  | "not_configured"
  | "checking"
  | "ready"
  | "needs_attention"
  | "disabled";

export interface SandboxConnectionInfo {
  id: string;
  provider: "docker" | "daytona" | "box" | "modal";
  enabled: boolean;
  settings: Record<string, string | number | boolean | undefined>;
  qualification?: {
    status: "checking" | "ready" | "failed";
    adapterSignature: string;
    checkedAt?: string;
    failureCode?: string;
    failureSummary?: string;
  };
  createdAt: string;
  updatedAt: string;
  hasCredentials: boolean;
  state: SandboxConnectionState;
}

export interface SandboxOperationInfo {
  id: string;
  kind: "qualification" | "repair" | "environment_rebuild";
  provider: string;
  repo?: string;
  status: "running" | "succeeded" | "failed";
  stage: string;
  detail?: string;
  progress?: number;
  createdAt: string;
  updatedAt: string;
  failureCode?: string;
  failureSummary?: string;
}

export interface SandboxIngressInfo {
  configuredUrl?: string;
  proposedUrl?: string;
  source: "config" | "caddy" | "none";
  health: "ready" | "unreachable" | "not_configured";
  caddyAdminReachable: boolean;
  generatedSnippet: string;
  note?: string;
}

export async function fetchSandboxStatus(
  user?: string,
): Promise<SandboxStatusInfo> {
  const query = user ? `?user=${encodeURIComponent(user)}` : "";
  const res = await fetch(`${BASE}/sandbox/status${query}`);
  if (!res.ok) throw new Error(`Failed to fetch sandbox status: ${res.status}`);
  return res.json();
}

export async function saveSandboxDefault(input: {
  scope: "workspace" | "personal";
  value: string;
  user: string;
}): Promise<{ defaults: NonNullable<SandboxStatusInfo["defaults"]> }> {
  return request("/sandbox/defaults", { method: "PUT", body: input });
}

/** Warm-on-typing sandbox prewarm (POST /api/sandbox/prewarm): fired by the
 *  New-session palette when the user types with a REMOTE provider selected,
 *  so the sandbox bootstrap runs while they write the prompt. Idempotent and
 *  cheap server-side; callers must swallow failures (never block typing). */
export async function requestSandboxPrewarm(
  provider: string,
  repo: string,
  user: string,
): Promise<{ state: string }> {
  const res = await fetch(`${BASE}/sandbox/prewarm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, repo, user }),
  });
  if (!res.ok) throw new Error(`prewarm failed: ${res.status}`);
  return res.json();
}

export async function createAutomationApi(input: {
  name: string;
  prompt: string;
  schedule: string;
  mode: "ask" | "code";
  createdBy: string;
  eventKey?: string;
  model?: string;
  fallbackModel?: string;
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  sandbox?: boolean;
  mcpServers?: string[];
  slackWatch?: { channel: string };
  webhookEnabled?: boolean;
  inputs?: unknown[];
  outputs?: unknown[];
  owner?: string;
  workspaceId?: string;
}): Promise<Automation> {
  return request("/automations", { method: "POST", body: input });
}

export type AutomationPatch = Partial<
  Omit<Automation, "mcpServers" | "slackWatch">
> & {
  mcpServers?: string[] | null;
  slackWatch?: { channel: string } | null;
};

export async function updateAutomationApi(
  id: string,
  patch: AutomationPatch,
): Promise<Automation> {
  return request(`/automations/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: patch,
  });
}

export async function deleteAutomationApi(id: string) {
  await request<void>(`/automations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    label: "Failed to delete",
  });
}

export async function runAutomationApi(id: string) {
  await request<void>(`/automations/${encodeURIComponent(id)}/run`, {
    method: "POST",
  });
}

/** Re-fire an automation replaying the triggering event of one of its past
 *  runs (the run is identified by its session id). */
export async function retriggerAutomationApi(sessionId: string) {
  await request<void>(`/automations/retrigger`, {
    method: "POST",
    body: { sessionId },
    label: "Failed to retrigger",
  });
}

// ── Scheduled prompts (composer "send later") ──

export interface ScheduledPrompt {
  id: string;
  sessionId: string;
  prompt: string;
  user: string;
  at: string;
  createdAt: string;
}

export async function fetchScheduledPrompts(
  sessionId: string,
): Promise<ScheduledPrompt[]> {
  const data = await request<{ prompts?: ScheduledPrompt[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/scheduled-prompts`,
    { label: "Failed to fetch scheduled prompts" },
  );
  return data?.prompts ?? [];
}

export async function createScheduledPromptApi(
  sessionId: string,
  input: { prompt: string; at: string; user: string },
): Promise<ScheduledPrompt> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/scheduled-prompts`,
    {
      method: "POST",
      body: input,
    },
  );
}

export async function deleteScheduledPromptApi(id: string): Promise<void> {
  await request<void>(`/scheduled-prompts/${encodeURIComponent(id)}`, {
    method: "DELETE",
    label: "Failed to delete scheduled prompt",
  });
}
