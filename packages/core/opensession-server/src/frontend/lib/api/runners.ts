import { request } from "./request";

export type RunnerState = "online" | "busy" | "offline" | "maintenance";

export type RunnerPermissions = {
  commands: boolean;
  fullSessions: boolean;
  terminals: boolean;
  portals: boolean;
};

export type RunnerInfo = {
  id: string;
  name: string;
  platform: "darwin" | "linux" | "win32";
  arch: string;
  label?: string;
  description?: string;
  location?: string;
  lastSeenAt?: string;
  softwareVersion?: string;
  maintenance?: boolean;
  state: RunnerState;
  capabilities: { toolchains: string[]; tags: string[] };
  resources?: {
    cpuCores?: number;
    memoryGb?: number;
    freeDiskGb?: number;
    gpu?: {
      kind: string;
      model?: string;
      vramGb?: number;
      cuda?: string;
      metal?: boolean;
      rocm?: string;
    };
    localInference?: Array<{ runtime: string; models: string[] }>;
  };
  permissions: RunnerPermissions;
  allowedUsers: string[];
  allowedRepos: string[];
  workspaceRoots: string[];
  workspaceRetention?: "retain" | "delete";
  migration?:
    | { kind: "ssh"; label: string; host: string; user: string; port: number }
    | {
        kind: "kubernetes";
        label: string;
        context: string;
        namespace: string;
        workload: string;
      };
  localInferencePolicy?: {
    enabled: boolean;
    allowedUsers: string[];
    allowedModels: string[];
    allowedTasks: Array<"chat" | "embedding" | "image" | "video">;
  };
  workload?: { sessionId?: string; operation?: string; startedAt?: string };
  reservation?: {
    sessionId?: string;
    reason: string;
    reservedBy?: string;
    expiresAt: string;
  };
};

export async function fetchRunners(): Promise<{
  runners: RunnerInfo[];
  admin: boolean;
}> {
  return request("/runners", { label: "Failed to load Runners" });
}

export async function createRunnerPairing(): Promise<{
  code: string;
  expiresAt: number;
}> {
  return request("/runners/pair", {
    method: "POST",
    label: "Could not create pairing",
  });
}

export type RunnerBootstrapTarget = {
  id: string;
  label: string;
  host?: string;
  user?: string;
  port?: number;
  fingerprint?: string;
  context?: string;
  namespace?: string;
  workload?: string;
};

export async function fetchRunnerBootstrapTargets(): Promise<{
  ssh: RunnerBootstrapTarget[];
  kubernetes: RunnerBootstrapTarget[];
}> {
  return request("/runners/bootstrap", {
    label: "Could not load Runner connection options",
  });
}

export async function bootstrapRunner(
  kind: "ssh" | "kubernetes",
  targetId: string,
): Promise<{ target: string; phase: "pairing" }> {
  return request(`/runners/bootstrap/${kind}`, {
    method: "POST",
    body: { targetId },
    label: "Could not start Runner migration",
  });
}

export type RunnerPatch = Partial<
  Pick<
    RunnerInfo,
    | "label"
    | "description"
    | "location"
    | "maintenance"
    | "allowedUsers"
    | "allowedRepos"
    | "workspaceRoots"
    | "workspaceRetention"
    | "localInferencePolicy"
  >
> & {
  permissions?: Partial<RunnerPermissions>;
  capabilities?: Partial<RunnerInfo["capabilities"]>;
};

export async function updateRunner(
  id: string,
  patch: RunnerPatch,
): Promise<RunnerInfo> {
  const response = await request<{ runner: RunnerInfo }>(
    `/runners/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch, label: "Could not update Runner" },
  );
  return response.runner;
}

export async function revokeRunner(id: string): Promise<void> {
  await request(`/runners/${encodeURIComponent(id)}`, {
    method: "DELETE",
    label: "Could not revoke Runner",
  });
}
