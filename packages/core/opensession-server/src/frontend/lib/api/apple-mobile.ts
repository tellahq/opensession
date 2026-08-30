import { request } from "./request";

export interface AppleMobileSetupStatus {
  buildEnabled: boolean;
  releaseEnabled: boolean;
  allowedRoots: string[];
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

export interface AppleMobileSetupInput {
  buildEnabled: boolean;
  releaseEnabled: boolean;
  allowedRoots: string[];
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

export function saveAppleMobileSetup(
  input: AppleMobileSetupInput,
): Promise<AppleMobileSetupStatus> {
  return request("/connections/apple-mobile", {
    method: "PUT",
    body: input,
    label: "Could not save Apple mobile setup",
  });
}
