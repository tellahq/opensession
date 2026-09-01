import { request } from "./request";
import type {
  SandboxConnectionInfo,
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
  logs?: { setup?: string; resume?: string };
}

export function fetchSessionSandbox(
  sessionId: string,
): Promise<SessionSandboxStatus> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/sandbox`, {
    label: "Failed to load sandbox status",
  });
}

export function sandboxAction(
  sessionId: string,
  action: "pause" | "resume" | "recreate",
): Promise<SessionSandboxStatus> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/sandbox/${action}`,
    {
      method: "POST",
      ...(action === "recreate" ? { body: { confirm: true } } : {}),
      label: `Failed to ${action} sandbox`,
    },
  );
}

export interface SandboxConnectionsResponse {
  canManage: boolean;
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
    settings?: Record<string, string | number | boolean | undefined>;
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
    settings?: Record<string, string | number | boolean | undefined>;
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
