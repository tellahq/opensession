import { API_BASE, ApiError, request } from "./request";

// ── Audit log ──

export interface AuditPage {
  dates: string[];
  events?: Array<Record<string, unknown>>;
  total?: number;
  types?: string[];
}

export async function fetchAudit(opts: {
  date?: string;
  q?: string;
  type?: string;
  session?: string;
  /** Include the per-turn firehose (tool_use/tool_result/…). */
  all?: boolean;
  offset?: number;
  limit?: number;
}): Promise<AuditPage> {
  const params = new URLSearchParams();
  if (opts.date) params.set("date", opts.date);
  if (opts.q) params.set("q", opts.q);
  if (opts.type) params.set("type", opts.type);
  if (opts.session) params.set("session", opts.session);
  if (opts.all) params.set("all", "1");
  if (opts.offset) params.set("offset", String(opts.offset));
  if (opts.limit) params.set("limit", String(opts.limit));
  return request(`/audit?${params.toString()}`, {
    label: "Failed to fetch audit log",
  });
}

// ── Papercuts (Settings → Papercuts: cross-session friction log) ──

export interface PapercutDto {
  ts: string;
  message: string;
  repo?: string;
  sessionId?: string;
  model?: string;
  runKind?: string;
  by?: string;
}

export interface PapercutsRepoConfig {
  repoId: string;
  enabled: boolean;
}

export async function fetchPapercuts(opts?: {
  repo?: string;
  days?: number;
}): Promise<{ entries: PapercutDto[]; repos: PapercutsRepoConfig[] }> {
  const params = new URLSearchParams();
  if (opts?.repo) params.set("repo", opts.repo);
  if (opts?.days) params.set("days", String(opts.days));
  const qs = params.toString();
  return request(`/papercuts${qs ? `?${qs}` : ""}`, {
    label: "Failed to fetch papercuts",
  });
}

export async function setPapercutsRepoEnabled(
  repo: string,
  enabled: boolean,
): Promise<{ repos: PapercutsRepoConfig[] }> {
  return request("/papercuts/config", {
    method: "PUT",
    body: { repo, enabled },
  });
}

// ── Tool accounts (Settings → Account: personal sign-in per MCP tool) ──

export interface ToolAccountDto {
  name: string;
  /** null = no probe has finished for this tool yet, so whether it offers a
   *  personal sign-in is still unknown. Not the same as false. */
  capable: boolean | null;
  /** The workspace-wide grant, when one exists. */
  shared?: { connectedBy?: string };
  /** Team members who have connected their own account. */
  users: string[];
}

/**
 * The last list the server handed us, so re-opening settings paints the tools
 * at once instead of showing a placeholder where a list already exists. Every
 * mount still fetches and replaces this, so the only thing ever shown ahead of
 * the server is a list that was right a moment ago. Page-lifetime only, so a
 * reload starts from the server.
 */
let lastToolAccounts: ToolAccountDto[] | null = null;

export function knownToolAccounts(): ToolAccountDto[] | null {
  return lastToolAccounts;
}

export async function fetchToolAccounts(): Promise<{
  servers: ToolAccountDto[];
  pending: boolean;
}> {
  const body = await request<{ servers: ToolAccountDto[]; pending: boolean }>(
    "/connections/mcp-oauth",
    { label: "Failed to fetch tools" },
  );
  lastToolAccounts = body.servers;
  return body;
}

/** Returns the tool's consent URL; the grant lands via the OAuth callback. */
export async function startToolConnect(
  name: string,
  scope: "me" | "shared" = "me",
): Promise<{ url: string }> {
  return request(`/connections/mcp/${encodeURIComponent(name)}/oauth/start`, {
    method: "POST",
    body: { scope },
    label: "Failed to start sign-in",
  });
}

export async function disconnectTool(
  name: string,
  scope: "me" | "shared" = "me",
): Promise<{ ok: true }> {
  return request(
    `/connections/mcp/${encodeURIComponent(name)}/oauth${scope === "me" ? "?scope=me" : ""}`,
    { method: "DELETE", label: "Failed to disconnect" },
  );
}

// ── Keychain (Settings → Account: per-person credentials + grants) ──

export interface KeychainCredentialDto {
  id: string;
  owner: string;
  service: string;
  description?: string;
  host: string;
  injection?: { header?: string; scheme?: string };
  allowedMethods?: string[];
  allowedPathPrefixes?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KeychainGrantDto {
  id: string;
  credentialId: string;
  owner: string;
  sessionId: string;
  requestedBy: string;
  purpose: string;
  mode: "once" | "standing";
  status: "active" | "used" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
}

export interface KeychainAskDto {
  id: string;
  credentialId: string;
  owner: string;
  sessionId: string;
  requestedBy: string;
  purpose: string;
  requestedMode: "once" | "standing";
  status: "pending" | "approved" | "declined" | "expired";
  createdAt: string;
}

export async function fetchKeychain(): Promise<{
  credentials: KeychainCredentialDto[];
  grants: KeychainGrantDto[];
  asks: KeychainAskDto[];
}> {
  return request("/keychain", { label: "Failed to fetch the keychain" });
}

export async function addKeychainCredential(input: {
  service: string;
  host: string;
  secret: string;
  description?: string;
  injection?: { header?: string; scheme?: string };
  allowedMethods?: string[];
  allowedPathPrefixes?: string[];
}): Promise<{ credential: KeychainCredentialDto }> {
  return request("/keychain/credentials", { method: "POST", body: input });
}

export async function deleteKeychainCredential(
  id: string,
): Promise<{ ok: true }> {
  return request(`/keychain/credentials/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function revokeKeychainGrant(id: string): Promise<{ ok: true }> {
  return request(`/keychain/grants/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ── Deploys (Settings → Deploys: agent-published internal apps) ──

export interface DeployVersionDto {
  version: number;
  createdAt: string;
  createdBy: string;
  sessionId?: string;
  entrypoint: string;
}

export interface DeployDto {
  id: string;
  name: string;
  owner: string;
  sessionId?: string;
  description?: string;
  port: number;
  currentVersion: number;
  versions: DeployVersionDto[];
  state: "running" | "stopped" | "crashed";
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchDeploys(): Promise<{ deploys: DeployDto[] }> {
  return request("/deploys", { label: "Failed to fetch deploys" });
}

export async function setDeployRunning(
  name: string,
  running: boolean,
): Promise<{ deploy: DeployDto }> {
  return request(
    `/deploys/${encodeURIComponent(name)}/${running ? "start" : "stop"}`,
    {
      method: "POST",
    },
  );
}

export async function rollbackDeployTo(
  name: string,
  version: number,
): Promise<{ deploy: DeployDto }> {
  return request(`/deploys/${encodeURIComponent(name)}/rollback`, {
    method: "POST",
    body: { version },
  });
}

export async function deleteDeployApp(name: string): Promise<{ ok: true }> {
  return request(`/deploys/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// ── Personal output style and system prompt (Settings → Preferences) ──

export type PersonalOutputStyle = "default" | "concise";

export async function fetchPersonalOutputStyle(
  user: string,
): Promise<{ outputStyle: PersonalOutputStyle }> {
  return request(`/personal-output-style?user=${encodeURIComponent(user)}`, {
    label: "Failed to fetch output style",
  });
}

export async function savePersonalOutputStyle(
  user: string,
  outputStyle: PersonalOutputStyle,
): Promise<{ outputStyle: PersonalOutputStyle }> {
  return request("/personal-output-style", {
    method: "PUT",
    body: { user, outputStyle },
  });
}

export async function fetchPersonalPrompt(
  user: string,
): Promise<{ prompt: string }> {
  return request(`/personal-prompt?user=${encodeURIComponent(user)}`, {
    label: "Failed to fetch personal prompt",
  });
}

export async function savePersonalPrompt(
  user: string,
  prompt: string,
): Promise<{ prompt: string }> {
  return request("/personal-prompt", {
    method: "PUT",
    body: { user, prompt },
  });
}

// ── Organization settings (Settings → Workspace → General) ──

export interface OrganizationSettingsDto {
  organizationName: string;
  organizationIconUrl: string | null;
  organizationIconRevision: string | null;
  configPath: string;
}

export async function fetchOrganizationSettings(): Promise<OrganizationSettingsDto> {
  return request("/settings/general", {
    label: "Failed to fetch organization settings",
  });
}

/** Empty string resets the name to the instance's product name. */
export async function saveOrganizationSettings(patch: {
  organizationName?: string;
}): Promise<OrganizationSettingsDto> {
  return request("/settings/general", { method: "PUT", body: patch });
}

export async function uploadOrganizationIcon(
  png: Blob,
): Promise<OrganizationSettingsDto> {
  const res = await fetch(`${API_BASE}/settings/general/icon`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: png,
  });
  const body = (await res.json().catch(() => null)) as
    | (OrganizationSettingsDto & { error?: string })
    | null;
  if (!res.ok) {
    throw new ApiError(
      body?.error || `Failed to upload the organization icon: ${res.status}`,
      res.status,
    );
  }
  if (!body)
    throw new ApiError("The server returned an empty response", res.status);
  return body;
}

export async function removeOrganizationIcon(): Promise<OrganizationSettingsDto> {
  return request("/settings/general/icon", { method: "DELETE" });
}

/** The connected GitHub organization's public profile, read server-side so the
 *  token stays there. Empty strings when GitHub had nothing to say. */
export interface GithubOrganizationProfileDto {
  login: string;
  name: string;
  avatarUrl: string;
}

/** Never throws: onboarding fills what it can and leaves the rest editable, so
 *  a rate limit or a private org must not stop the step. */
export async function fetchGithubOrganizationProfile(
  login: string,
): Promise<GithubOrganizationProfileDto | null> {
  try {
    return await request(
      `/settings/general/github-organization?login=${encodeURIComponent(login)}`,
      { label: "Failed to read the GitHub organization" },
    );
  } catch {
    return null;
  }
}

export interface AssetStorageSettingsDto {
  provider: "local" | "s3";
  bucket: string;
  region: string;
  endpoint: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKeySet: boolean;
  forcePathStyle: boolean;
}

export interface AssetStorageSettingsInput {
  provider: "local" | "s3";
  bucket?: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export async function fetchAssetStorageSettings(): Promise<AssetStorageSettingsDto> {
  return request("/settings/asset-storage", {
    label: "Failed to fetch asset storage settings",
  });
}

export async function testAssetStorageSettings(
  input: AssetStorageSettingsInput,
): Promise<{ ok: true }> {
  return request("/settings/asset-storage/test", {
    method: "POST",
    body: input,
  });
}

export async function saveAssetStorageSettings(
  input: AssetStorageSettingsInput,
): Promise<AssetStorageSettingsDto> {
  return request("/settings/asset-storage", { method: "PUT", body: input });
}

// ── Instance identity (Settings → Workspace → Identity) ──

export interface InstanceIdentityDto {
  personaName: string;
  productName: string;
  productMark: string;
  configPath: string;
}

export async function fetchInstanceIdentity(): Promise<InstanceIdentityDto> {
  return request("/settings/identity", {
    label: "Failed to fetch instance identity",
  });
}

/** Empty string resets a field to its built-in default. */
export async function saveInstanceIdentity(patch: {
  personaName?: string;
  productName?: string;
}): Promise<InstanceIdentityDto> {
  return request("/settings/identity", { method: "PUT", body: patch });
}

// ── Memory (Settings → Memory: repo/user/team/channel stores) ──

export interface MemoryEntryDto {
  id: string;
  text: string;
  by: string;
  at: string;
}

export interface MemoryScopeDto {
  scope: {
    key: string;
    kind: "repo" | "user" | "team" | "channel";
    label: string;
  };
  entries: MemoryEntryDto[];
}

export async function fetchMemory(): Promise<{ scopes: MemoryScopeDto[] }> {
  return request("/memory", { label: "Failed to fetch memory" });
}

export async function addMemoryEntryApi(
  scopeKey: string,
  text: string,
  by: string,
): Promise<{ entry: MemoryEntryDto }> {
  return request("/memory", {
    method: "POST",
    body: { scopeKey, text, by },
    label: "Failed to add memory",
  });
}

export async function updateMemoryEntryApi(
  scopeKey: string,
  id: string,
  text: string,
): Promise<{ entry: MemoryEntryDto }> {
  return request("/memory", {
    method: "PUT",
    body: { scopeKey, id, text },
    label: "Failed to update memory",
  });
}

export async function deleteMemoryEntryApi(
  scopeKey: string,
  id: string,
): Promise<void> {
  await request<void>("/memory", {
    method: "DELETE",
    body: { scopeKey, id },
    label: "Failed to delete memory",
  });
}
