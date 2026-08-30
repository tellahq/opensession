import { findExecutable } from "../../../../integrations/apple-mobile/src/exec";
import { resolvePrivateKeyPath } from "../../../../integrations/apple-mobile/src/security";
import { readMcpConfig, replaceMcpServerEntries } from "./connections";
import { stateDir } from "./paths";
import { userMatchesAny } from "./shared/user-mappings";

const BUILD_SERVER = "apple-build";
const RELEASE_SERVER = "apple-release";
const COMMAND = "opensession";

interface AppleMcpEntry {
  command?: unknown;
  args?: unknown;
  env?: Record<string, unknown>;
  allowedUsers?: unknown;
}

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

export interface AppleMobileSetupInput {
  buildEnabled?: unknown;
  releaseEnabled?: unknown;
  teamId?: unknown;
  keyId?: unknown;
  issuerId?: unknown;
  privateKeyPath?: unknown;
  allowedUsers?: unknown;
}

function entry(value: unknown): AppleMcpEntry {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AppleMcpEntry)
    : {};
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function configured(entry: AppleMcpEntry, mode: "build" | "release"): boolean {
  return (
    entry.command === COMMAND &&
    Array.isArray(entry.args) &&
    entry.args.join(" ") === `apple-mobile-mcp --mode ${mode}`
  );
}

export function appleReleaseApprover(
  authUser: { login?: string; name?: string } | null | undefined,
  allowedUsers: string[],
): string | undefined {
  return [authUser?.login, authUser?.name]
    .filter((identity): identity is string => !!identity)
    .find((identity) => userMatchesAny(identity, allowedUsers));
}

export function appleMobileSetupStatus(): AppleMobileSetupStatus {
  const servers = readMcpConfig().mcpServers;
  const build = entry(servers[BUILD_SERVER]);
  const release = entry(servers[RELEASE_SERVER]);
  const macos = process.platform === "darwin";
  const xcode = Boolean(findExecutable("xcodebuild"));
  return {
    buildEnabled: configured(build, "build"),
    releaseEnabled: configured(release, "release"),
    teamId:
      typeof release.env?.APPLE_DEVELOPER_TEAM_ID === "string"
        ? release.env.APPLE_DEVELOPER_TEAM_ID
        : "",
    allowedUsers: strings(release.allowedUsers),
    credentials: {
      keyId: Boolean(release.env?.APPLE_ASC_KEY_ID),
      issuerId: Boolean(release.env?.APPLE_ASC_ISSUER_ID),
      privateKeyPath: Boolean(release.env?.APPLE_ASC_PRIVATE_KEY_PATH),
    },
    host: { macos, xcode, releaseCapable: macos && xcode },
  };
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function optional(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function existingEnv(name: string): Record<string, unknown> {
  return entry(readMcpConfig().mcpServers[name]).env ?? {};
}

type AppleMobileUpdates = Record<string, Record<string, unknown> | undefined>;

export function buildAppleMobileUpdates(
  input: AppleMobileSetupInput,
  releaseEnv: Record<string, unknown> = {},
  options: {
    releaseCapable?: boolean;
    validatePrivateKey?: (path: string) => void;
    stateDir?: string;
  } = {},
): AppleMobileUpdates {
  const buildEnabled = boolean(input.buildEnabled, "buildEnabled");
  const releaseEnabled = boolean(input.releaseEnabled, "releaseEnabled");
  const teamId =
    optional(input.teamId, "teamId") ??
    (typeof releaseEnv.APPLE_DEVELOPER_TEAM_ID === "string"
      ? releaseEnv.APPLE_DEVELOPER_TEAM_ID
      : "");
  const keyId = optional(input.keyId, "keyId") ?? releaseEnv.APPLE_ASC_KEY_ID;
  const issuerId =
    optional(input.issuerId, "issuerId") ?? releaseEnv.APPLE_ASC_ISSUER_ID;
  const privateKeyPath =
    optional(input.privateKeyPath, "privateKeyPath") ??
    releaseEnv.APPLE_ASC_PRIVATE_KEY_PATH;
  const allowedUsers = strings(input.allowedUsers);

  if (releaseEnabled) {
    if (options.releaseCapable === false) {
      throw new Error("Release tools require Xcode on this Mac");
    }
    if (!teamId) throw new Error("Apple Developer Team ID is required");
    if (!keyId || !issuerId || !privateKeyPath) {
      throw new Error("Key ID, issuer ID, and private key path are required");
    }
    if (allowedUsers.length === 0) {
      throw new Error("Choose at least one person allowed to release");
    }
    (options.validatePrivateKey ?? resolvePrivateKeyPath)(
      String(privateKeyPath),
    );
  }

  return {
    [BUILD_SERVER]: buildEnabled
      ? {
          command: COMMAND,
          args: ["apple-mobile-mcp", "--mode", "build"],
          env: {
            ...(options.stateDir
              ? { APPLE_MOBILE_STATE_DIR: options.stateDir }
              : {}),
          },
        }
      : undefined,
    [RELEASE_SERVER]: releaseEnabled
      ? {
          command: COMMAND,
          args: ["apple-mobile-mcp", "--mode", "release"],
          env: {
            ...(options.stateDir
              ? { APPLE_MOBILE_STATE_DIR: options.stateDir }
              : {}),
            APPLE_DEVELOPER_TEAM_ID: teamId,
            APPLE_ASC_KEY_ID: String(keyId),
            APPLE_ASC_ISSUER_ID: String(issuerId),
            APPLE_ASC_PRIVATE_KEY_PATH: String(privateKeyPath),
          },
          allowedUsers,
        }
      : undefined,
  };
}

export function configureAppleMobileConnections(
  input: AppleMobileSetupInput,
): AppleMobileSetupStatus {
  const releaseCapable =
    process.platform === "darwin" && Boolean(findExecutable("xcodebuild"));
  const updates = buildAppleMobileUpdates(input, existingEnv(RELEASE_SERVER), {
    releaseCapable,
    stateDir: stateDir("apple-mobile"),
  });
  const result = replaceMcpServerEntries(updates);
  if ("error" in result) throw new Error(result.error);
  return appleMobileSetupStatus();
}
