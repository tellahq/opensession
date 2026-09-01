import { request } from "./request";

// ── Security (deepsec scans + profiles) ──

export interface ScanProfile {
  id: string;
  name: string;
  prompt: string;
  createdBy: string;
  createdAt: string;
}

export interface ScanSessionRef {
  repo: string;
  sessionId: string;
  status: "running" | "ok" | "error";
  error?: string;
}

export interface SecurityScan {
  id: string;
  repos: string[];
  profileId?: string;
  profileName?: string;
  instructions?: string;
  interactive: boolean;
  status: "running" | "done" | "error" | "interactive";
  error?: string;
  createdBy: string;
  createdAt: string;
  finishedAt?: string;
  sessions: ScanSessionRef[];
}

export async function fetchSecurity(): Promise<{
  scans: SecurityScan[];
  profiles: ScanProfile[];
  repos: Array<{ id: string; defaultBranch: string }>;
}> {
  return request("/security", { label: "Failed to fetch security" });
}

export async function startScanApi(input: {
  repos: "all" | string[];
  profileId?: string;
  instructions?: string;
  interactive?: boolean;
  recurrence?: "none" | "daily" | "weekly";
  createdBy: string;
}): Promise<{ scan?: SecurityScan; sessionId?: string; automation?: unknown }> {
  return request("/security/scans", { method: "POST", body: input });
}

export async function deleteScanApi(id: string) {
  await request<void>(`/security/scans/${encodeURIComponent(id)}`, {
    method: "DELETE",
    label: "Failed to delete scan",
  });
}

export async function createScanProfileApi(input: {
  name: string;
  prompt: string;
  createdBy: string;
}): Promise<ScanProfile> {
  return request("/security/profiles", { method: "POST", body: input });
}

export async function updateScanProfileApi(
  id: string,
  patch: { name?: string; prompt?: string },
): Promise<ScanProfile> {
  return request(`/security/profiles/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: patch,
  });
}

export async function deleteScanProfileApi(id: string) {
  await request<void>(`/security/profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
    label: "Failed to delete profile",
  });
}
