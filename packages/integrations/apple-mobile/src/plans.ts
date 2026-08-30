import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config";
import {
  resolvePrivateKeyPath,
  resolveProjectDir,
  resolveProjectPath,
} from "./security";
import { enforceReleasePolicy } from "./project";
import type {
  AppleMobileConfig,
  CommandSpec,
  ReleaseAction,
  ReleasePlan,
} from "./types";

const PLAN_TTL_MS = 60 * 60_000;
export const CREDENTIAL_REFS = {
  keyId: "<APPLE_ASC_KEY_ID>",
  issuerId: "<APPLE_ASC_ISSUER_ID>",
  keyPath: "<APPLE_ASC_PRIVATE_KEY_PATH>",
} as const;

export function credentials(required: boolean) {
  const keyId = process.env.APPLE_ASC_KEY_ID;
  const issuerId = process.env.APPLE_ASC_ISSUER_ID;
  const keyPath = process.env.APPLE_ASC_PRIVATE_KEY_PATH;
  if (required && (!keyId || !issuerId || !keyPath)) {
    throw new Error(
      "APPLE_ASC_KEY_ID, APPLE_ASC_ISSUER_ID, and APPLE_ASC_PRIVATE_KEY_PATH are required",
    );
  }
  const resolvedKeyPath = keyPath ? resolvePrivateKeyPath(keyPath) : undefined;
  return { keyId, issuerId, keyPath: resolvedKeyPath };
}

function artifactRoot(projectDir: string, config: AppleMobileConfig): string {
  return resolveProjectPath(
    projectDir,
    config.release?.artifactDirectory ?? ".build/apple-mobile",
    { mustExist: false },
  );
}

function xcodeArchiveCommand(
  projectDir: string,
  config: AppleMobileConfig,
  archivePath: string,
  marketingVersion?: string,
  buildNumber?: string,
): CommandSpec {
  if (config.backend !== "xcode" || !config.xcode) {
    throw new Error(
      "Distribution releases require the xcode backend; xtool currently supports development signing only",
    );
  }
  credentials(true);
  const xcode = config.xcode;
  const args = [
    xcode.container === "workspace" ? "-workspace" : "-project",
    resolveProjectPath(projectDir, xcode.path),
    "-scheme",
    xcode.scheme,
    "-configuration",
    xcode.configuration ?? "Release",
    "-destination",
    "generic/platform=iOS",
    "-archivePath",
    archivePath,
    "-allowProvisioningUpdates",
    "-authenticationKeyPath",
    CREDENTIAL_REFS.keyPath,
    "-authenticationKeyID",
    CREDENTIAL_REFS.keyId,
    "-authenticationKeyIssuerID",
    CREDENTIAL_REFS.issuerId,
  ];
  const teamId = config.teamId ?? process.env.APPLE_DEVELOPER_TEAM_ID;
  if (teamId) args.push(`DEVELOPMENT_TEAM=${teamId}`);
  if (marketingVersion) args.push(`MARKETING_VERSION=${marketingVersion}`);
  if (buildNumber) args.push(`CURRENT_PROJECT_VERSION=${buildNumber}`);
  args.push("archive");
  return { executable: "xcodebuild", args, cwd: projectDir };
}

function xcodeExportCommand(
  projectDir: string,
  archivePath: string,
  outputPath: string,
  plistPath: string,
): CommandSpec {
  credentials(true);
  return {
    executable: "xcodebuild",
    args: [
      "-exportArchive",
      "-archivePath",
      archivePath,
      "-exportPath",
      outputPath,
      "-exportOptionsPlist",
      plistPath,
      "-allowProvisioningUpdates",
      "-authenticationKeyPath",
      CREDENTIAL_REFS.keyPath,
      "-authenticationKeyID",
      CREDENTIAL_REFS.keyId,
      "-authenticationKeyIssuerID",
      CREDENTIAL_REFS.issuerId,
    ],
    cwd: projectDir,
  };
}

function uploadCommand(
  projectDir: string,
  ipaPlaceholder: string,
): CommandSpec {
  credentials(true);
  return {
    executable: "xcrun",
    args: [
      "altool",
      "--upload-app",
      "--type",
      "ios",
      "--file",
      ipaPlaceholder,
      "--apiKey",
      CREDENTIAL_REFS.keyId,
      "--apiIssuer",
      CREDENTIAL_REFS.issuerId,
    ],
    cwd: projectDir,
  };
}

function plansDir(projectDir: string, config: AppleMobileConfig): string {
  return join(artifactRoot(projectDir, config), "plans");
}

function signingKeyPath(): string {
  const root =
    process.env.OPENSESSION_STATE_DIR || join(homedir(), ".opensession");
  return join(root, "apple-mobile-plan-key");
}

function signingKey(): Uint8Array {
  const path = signingKeyPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, crypto.getRandomValues(new Uint8Array(32)), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const key = readFileSync(path);
  if (key.byteLength !== 32) throw new Error("Invalid Apple mobile plan key");
  return key;
}

function signature(plan: ReleasePlan): string {
  return new Bun.CryptoHasher("sha256", signingKey())
    .update(JSON.stringify(plan))
    .digest("hex");
}

function validSignature(plan: ReleasePlan, actual: unknown): boolean {
  if (typeof actual !== "string" || !/^[0-9a-f]{64}$/.test(actual))
    return false;
  return timingSafeEqual(
    Buffer.from(signature(plan), "hex"),
    Buffer.from(actual, "hex"),
  );
}

export function planPath(
  projectDir: string,
  config: AppleMobileConfig,
  planId: string,
): string {
  if (!/^[0-9a-f-]{36}$/.test(planId)) throw new Error("Invalid planId");
  return join(plansDir(projectDir, config), `${planId}.json`);
}

async function persist(plan: ReleasePlan, config: AppleMobileConfig) {
  const path = planPath(plan.projectDir, config, plan.id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await Bun.write(
    path,
    JSON.stringify({ plan, signature: signature(plan) }, null, 2) + "\n",
  );
  chmodSync(path, 0o600);
  return { plan, planFile: relative(plan.projectDir, path) };
}

export async function createBuildPlan(
  projectDirInput: string,
  action: Exclude<ReleaseAction, "upload">,
  options: { marketingVersion?: string; buildNumber?: string } = {},
) {
  const projectDir = resolveProjectDir(projectDirInput);
  const { config, hash, git } = await enforceReleasePolicy(projectDir);
  credentials(true);
  const id = crypto.randomUUID();
  const outputDirectory = join(artifactRoot(projectDir, config), id);
  const archivePath = join(
    outputDirectory,
    `${config.xcode?.scheme ?? "App"}.xcarchive`,
  );
  const exportPath = join(outputDirectory, "export");
  const plistPath = join(outputDirectory, "ExportOptions.plist");
  const commands = [
    xcodeArchiveCommand(
      projectDir,
      config,
      archivePath,
      options.marketingVersion,
      options.buildNumber,
    ),
    xcodeExportCommand(projectDir, archivePath, exportPath, plistPath),
  ];
  if (action === "testflight")
    commands.push(uploadCommand(projectDir, "<exported-ipa>"));
  const now = Date.now();
  const plan: ReleasePlan = {
    schemaVersion: 1,
    id,
    action,
    projectDir,
    commit: git.commit,
    branch: git.branch,
    configHash: hash,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
    marketingVersion: options.marketingVersion,
    buildNumber: options.buildNumber,
    outputDirectory,
    commands,
  };
  return persist(plan, config);
}

export async function createUploadPlan(
  projectDirInput: string,
  artifactPath: string,
) {
  const projectDir = resolveProjectDir(projectDirInput);
  const { config, hash, git } = await enforceReleasePolicy(projectDir);
  credentials(true);
  const artifact = resolveProjectPath(projectDir, artifactPath);
  if (!artifact.endsWith(".ipa"))
    throw new Error("Only .ipa uploads are supported");
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(artifact).arrayBuffer())
    .digest("hex");
  const id = crypto.randomUUID();
  const now = Date.now();
  const plan: ReleasePlan = {
    schemaVersion: 1,
    id,
    action: "upload",
    projectDir,
    commit: git.commit,
    branch: git.branch,
    configHash: hash,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
    sourceArtifact: artifact,
    sourceArtifactSha256: sha256,
    outputDirectory: dirname(artifact),
    commands: [uploadCommand(projectDir, artifact)],
  };
  return persist(plan, config);
}

export async function loadPlan(
  projectDirInput: string,
  planId: string,
): Promise<{ plan: ReleasePlan; config: AppleMobileConfig }> {
  const projectDir = resolveProjectDir(projectDirInput);
  const loaded = await loadConfig(projectDir);
  const path = planPath(projectDir, loaded.config, planId);
  const stored = JSON.parse(await Bun.file(path).text()) as {
    plan: ReleasePlan;
    signature: unknown;
  };
  const plan = stored.plan;
  if (!plan || !validSignature(plan, stored.signature)) {
    throw new Error("Release plan signature is invalid");
  }
  if (
    plan.schemaVersion !== 1 ||
    plan.id !== planId ||
    plan.projectDir !== projectDir
  )
    throw new Error("Invalid release plan");
  if (Date.parse(plan.expiresAt) < Date.now())
    throw new Error("Release plan has expired");
  const current = await enforceReleasePolicy(projectDir);
  if (current.git.commit !== plan.commit)
    throw new Error("Commit changed after planning");
  if (current.git.branch !== plan.branch)
    throw new Error("Branch changed after planning");
  if (current.hash !== plan.configHash)
    throw new Error("Configuration changed after planning");
  if (plan.sourceArtifact && plan.sourceArtifactSha256) {
    const hash = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(plan.sourceArtifact).arrayBuffer())
      .digest("hex");
    if (hash !== plan.sourceArtifactSha256)
      throw new Error("IPA changed after planning");
  }
  return { plan, config: loaded.config };
}

export function exportOptions(
  config: AppleMobileConfig,
  action: ReleaseAction,
): Record<string, unknown> {
  const method = action === "adhoc" ? "release-testing" : "app-store-connect";
  return {
    method,
    destination: "export",
    signingStyle: "automatic",
    teamID: config.teamId ?? process.env.APPLE_DEVELOPER_TEAM_ID,
    manageAppVersionAndBuildNumber: false,
    uploadSymbols: true,
  };
}
