import { request } from "./request";

export interface AppleMobileSetupStatus {
  buildEnabled: boolean;
  releaseEnabled: boolean;
  teamId: string;
  allowedUsers: string[];
  credentials: {
    keyId: boolean;
    issuerId: boolean;
    privateKeyPath: boolean;
  };
  host: {
    macos: boolean;
    xcode: boolean;
    releaseCapable: boolean;
  };
}

export interface AppleReleaseApprovalRequest {
  schemaVersion: 1;
  planId: string;
  action: "adhoc" | "testflight" | "upload";
  projectDir: string;
  commit: string;
  branch: string;
  createdAt: string;
  expiresAt: string;
  marketingVersion?: string;
  buildNumber?: string;
  sourceArtifactName?: string;
  sourceArtifactSha256?: string;
}

export interface AppleReleaseApprovals {
  authenticated: boolean;
  allowed: boolean;
  requests: AppleReleaseApprovalRequest[];
}

export interface AppleMobileSetupInput {
  buildEnabled: boolean;
  releaseEnabled: boolean;
  teamId: string;
  keyId?: string;
  issuerId?: string;
  privateKeyPath?: string;
  allowedUsers: string[];
}

export function fetchAppleMobileSetup(): Promise<AppleMobileSetupStatus> {
  return request("/connections/apple-mobile", {
    label: "Could not load Apple mobile setup",
  });
}

export function fetchAppleReleaseApprovals(): Promise<AppleReleaseApprovals> {
  return request("/connections/apple-mobile/approvals", {
    label: "Could not load Apple release approvals",
  });
}

export function approveAppleRelease(planId: string): Promise<{ ok: true }> {
  return request(
    `/connections/apple-mobile/approvals/${encodeURIComponent(planId)}`,
    {
      method: "POST",
      label: "Could not approve Apple release",
    },
  );
}

export function saveAppleMobileSetup(
  input: AppleMobileSetupInput,
): Promise<AppleMobileSetupStatus> {
  return request("/connections/apple-mobile", {
    method: "PUT",
    body: input,
    label: "Could not save Apple mobile setup",
  });
}
