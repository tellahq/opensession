import { request } from "./request";
import type {
  SandboxConnectionInfo,
  SandboxConnectionSettings,
  SandboxIngressInfo,
  SandboxOperationInfo,
} from "./automations";

export interface SessionSandboxStatus {
  enabled: boolean;
  provider?: string;
  sandboxId?: string;
  workspace?: "bind" | "volume";
  status: "none" | "running" | "stopped" | "gone";
  lifecycle?: "preparing" | "awake" | "sleeping" | "waking" | "needs_attention";
  lastLifecycleError?: string;
  materialized?: boolean;
  busy?: boolean;
  cwd?: string | null;
  canPause?: boolean;
  canResume?: boolean;
  canDesktop?: boolean;
  logs?: { setup?: string; resume?: string };
  /** The last workspace checkpoint pushed to origin; absent until the first
   *  clean turn finishes or when the repository cannot hold one. */
  checkpoint?: SandboxCheckpointInfo;
}

export interface SandboxCheckpointInfo {
  at: string;
  commit: string;
  branch: string;
}

export interface SandboxDesktopLink {
  /** A page that is the live desktop (Daytona, Boat). */
  url?: string;
  /** A VNC stream on this origin (Mac VMs), drawn by the in-app viewer. */
  vnc?: { streamPath: string; password: string };
  expiresAt?: number;
}

/** Mints a one-viewer desktop link. Open it in a new tab; never persist it. */
export function openSandboxDesktop(
  sessionId: string,
): Promise<SandboxDesktopLink> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/sandbox/desktop`, {
    method: "POST",
    label: "Failed to open the sandbox desktop",
  });
}

export function fetchSessionSandbox(
  sessionId: string,
): Promise<SessionSandboxStatus> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/sandbox`, {
    label: "Failed to load sandbox status",
  });
}

/** Body of `POST /sessions/:id/sandbox/attach`; `confirm` accepts leaving
 * unpushed work behind on this machine. */
interface AttachSandboxBody {
  provider: string;
  confirm?: true;
}

/** Moves a session that runs on this machine into a Sandbox, which is
 * provisioned on its next turn. A 428 means work exists only on this machine;
 * repeat with `confirm` to move anyway. */
export function attachSandbox(
  sessionId: string,
  provider: string,
  opts: { confirm?: boolean } = {},
): Promise<SessionSandboxStatus> {
  const body: AttachSandboxBody = { provider };
  if (opts.confirm) body.confirm = true;
  return request(`/sessions/${encodeURIComponent(sessionId)}/sandbox/attach`, {
    method: "POST",
    body,
    label: "Failed to move the session into a Sandbox",
  });
}

/** Lifecycle actions. A rebuild first checkpoints the Sandbox; when that is
 * impossible on a reachable Sandbox the server answers 428 and only
 * `discard: true` lets the rebuild throw the Sandbox's files away. */
export function sandboxAction(
  sessionId: string,
  action: "pause" | "resume" | "recreate" | "checkpoint",
  options: { discard?: boolean } = {},
): Promise<SessionSandboxStatus> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/sandbox/${action}`;
  const label = `Failed to ${action} sandbox`;
  if (action !== "recreate") return request(path, { method: "POST", label });
  const body = options.discard
    ? { confirm: true, discard: true }
    : { confirm: true };
  return request(path, { method: "POST", body, label });
}

/** Moves a Sandbox session back to this machine: the Sandbox's work is
 * checkpointed, restored into a worktree here, and the Sandbox is released.
 * A 428 means the Sandbox cannot be reached and no checkpoint exists; repeat
 * with `confirm` to move with the branch as origin has it. */
export function detachSandbox(
  sessionId: string,
  opts: { confirm?: boolean } = {},
): Promise<SessionSandboxStatus> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/sandbox/detach`, {
    method: "POST",
    body: opts.confirm ? { confirm: true } : {},
    label: "Failed to move the session to this machine",
  });
}

export interface SandboxConnectionsResponse {
  connections: SandboxConnectionInfo[];
  operations: SandboxOperationInfo[];
  ingress: SandboxIngressInfo;
  operation?: SandboxOperationInfo;
}

export interface SandboxEnvironmentInfo {
  repo: string;
  provider: SandboxConnectionInfo["provider"];
  state: "not_prepared" | "preparing" | "ready" | "failed" | "stale";
  updatedAt: string;
  preparedAt?: string;
  expiresAt?: string;
  failureCode?: string;
  failureSummary?: string;
  mode?: "template" | "per_session";
  settings?: SandboxMachineSettings;
  /** One prepared Sandbox is kept waiting for this project. */
  keepReady?: boolean;
  readyState?: "ready" | "preparing" | "failed";
}

export interface SandboxMachineSettings {
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
}

export function fetchSandboxConnections(): Promise<SandboxConnectionsResponse> {
  return request("/sandbox/connections", {
    label: "Failed to load sandbox connections",
  });
}

export function connectSandbox(
  provider: SandboxConnectionInfo["provider"],
  body: {
    apiKey?: string;
    tokenId?: string;
    tokenSecret?: string;
    publicBaseUrl?: string;
    settings?: SandboxConnectionSettings;
  },
): Promise<SandboxConnectionsResponse> {
  return request(`/sandbox/connections/${provider}/connect`, {
    method: "POST",
    body,
    label: `Failed to connect ${provider}`,
  });
}

export function testSandboxConnection(
  provider: SandboxConnectionInfo["provider"],
  action: "test" | "repair" = "test",
): Promise<SandboxConnectionsResponse> {
  return request(`/sandbox/connections/${provider}/${action}`, {
    method: "POST",
    label: `Failed to ${action} ${provider}`,
  });
}

export function updateSandboxConnection(
  provider: SandboxConnectionInfo["provider"],
  body: {
    enabled?: boolean;
    settings?: SandboxConnectionSettings;
  },
): Promise<SandboxConnectionsResponse> {
  return request(`/sandbox/connections/${provider}`, {
    method: "PATCH",
    body,
    label: `Failed to update ${provider}`,
  });
}

export function disconnectSandbox(
  provider: SandboxConnectionInfo["provider"],
): Promise<SandboxConnectionsResponse> {
  return request(`/sandbox/connections/${provider}`, {
    method: "DELETE",
    body: { confirm: true },
    label: `Failed to disconnect ${provider}`,
  });
}

export function fetchSandboxEnvironments(): Promise<{
  environments: SandboxEnvironmentInfo[];
}> {
  return request("/sandbox/environments", {
    label: "Failed to load sandbox environments",
  });
}

export function setSandboxKeepReady(
  repo: string,
  provider: SandboxConnectionInfo["provider"],
  enabled: boolean,
): Promise<{ environments: SandboxEnvironmentInfo[] }> {
  return request(
    `/sandbox/environments/${encodeURIComponent(repo)}/${provider}/keep-ready`,
    {
      method: "PUT",
      body: { enabled },
      label: `Failed to update the ready Sandbox for ${repo}`,
    },
  );
}

export function rebuildSandboxEnvironment(
  repo: string,
  provider: SandboxConnectionInfo["provider"],
  settings?: SandboxMachineSettings,
): Promise<{ operation: SandboxOperationInfo }> {
  return request(
    `/sandbox/environments/${encodeURIComponent(repo)}/${provider}/rebuild`,
    {
      method: "POST",
      body: { settings },
      label: `Failed to rebuild ${repo} for ${provider}`,
    },
  );
}
