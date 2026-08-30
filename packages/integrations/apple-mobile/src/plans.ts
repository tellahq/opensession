import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
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

export function credentials(required: boolean, projectDir?: string) {
  const keyId = process.env.APPLE_ASC_KEY_ID;
  const issuerId = process.env.APPLE_ASC_ISSUER_ID;
  const keyPath = process.env.APPLE_ASC_PRIVATE_KEY_PATH;
  if (required && (!keyId || !issuerId || !keyPath)) {
    throw new Error(
      "APPLE_ASC_KEY_ID, APPLE_ASC_ISSUER_ID, and APPLE_ASC_PRIVATE_KEY_PATH are required",
    );
  }
  const resolvedKeyPath = keyPath
    ? resolvePrivateKeyPath(keyPath, projectDir)
    : undefined;
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

function appleMobileStateDir(root?: string): string {
  if (root) return root;
  if (process.env.APPLE_MOBILE_STATE_DIR) {
    return process.env.APPLE_MOBILE_STATE_DIR;
  }
  if (process.env.OPENSESSION_STATE_DIR) {
    return join(process.env.OPENSESSION_STATE_DIR, "apple-mobile");
  }
  return join(homedir(), ".opensession", "apple-mobile");
}

function signingKeyPath(root?: string): string {
  return join(appleMobileStateDir(root), "plan-key");
}

function signingKey(root?: string): Uint8Array {
  const path = signingKeyPath(root);
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

function signature(value: unknown, root?: string): string {
  return new Bun.CryptoHasher("sha256", signingKey(root))
    .update(JSON.stringify(value))
    .digest("hex");
}

function validSignature(
  value: unknown,
  actual: unknown,
  root?: string,
): boolean {
  if (typeof actual !== "string" || !/^[0-9a-f]{64}$/.test(actual))
    return false;
  return timingSafeEqual(
    Buffer.from(signature(value, root), "hex"),
    Buffer.from(actual, "hex"),
  );
}

export interface ReleaseApprovalRequest {
  schemaVersion: 1;
  planId: string;
  action: ReleaseAction;
  projectDir: string;
  commit: string;
  branch: string;
  createdAt: string;
  expiresAt: string;
  marketingVersion?: string;
  buildNumber?: string;
  sourceArtifactSha256?: string;
}

interface ReleaseApprovalGrant {
  schemaVersion: 1;
  planId: string;
  projectDir: string;
  commit: string;
  approvedBy: string;
  approvedAt: string;
}

interface Signed<T> {
  value: T;
  signature: string;
}

function approvalsDir(root?: string): string {
  return join(appleMobileStateDir(root), "approvals");
}

function approvalPath(
  planId: string,
  kind: "request" | "grant",
  root?: string,
): string {
  if (!/^[0-9a-f-]{36}$/.test(planId)) throw new Error("Invalid planId");
  return join(approvalsDir(root), `${planId}.${kind}.json`);
}

function writeSigned<T>(path: string, value: T, root?: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({ value, signature: signature(value, root) }, null, 2) +
      "\n",
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

function readSigned<T>(path: string, root?: string): T {
  const stored = JSON.parse(readFileSync(path, "utf8")) as Signed<T>;
  if (!stored?.value || !validSignature(stored.value, stored.signature, root)) {
    throw new Error("Apple mobile approval signature is invalid");
  }
  return stored.value;
}

function approvalRequest(plan: ReleasePlan): ReleaseApprovalRequest {
  return {
    schemaVersion: 1,
    planId: plan.id,
    action: plan.action,
    projectDir: plan.projectDir,
    commit: plan.commit,
    branch: plan.branch,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    marketingVersion: plan.marketingVersion,
    buildNumber: plan.buildNumber,
    sourceArtifactSha256: plan.sourceArtifactSha256,
  };
}

function recordApprovalRequest(plan: ReleasePlan, root?: string): void {
  writeSigned(
    approvalPath(plan.id, "request", root),
    approvalRequest(plan),
    root,
  );
}

export function listReleaseApprovalRequests(
  root?: string,
): ReleaseApprovalRequest[] {
  const dir = approvalsDir(root);
  if (!existsSync(dir)) return [];
  const requests: ReleaseApprovalRequest[] = [];
  for (const name of readdirSync(dir).sort().slice(-100)) {
    if (!name.endsWith(".request.json")) continue;
    const planId = name.slice(0, -".request.json".length);
    if (existsSync(approvalPath(planId, "grant", root))) continue;
    try {
      const request = readSigned<ReleaseApprovalRequest>(join(dir, name), root);
      if (
        request.schemaVersion === 1 &&
        request.planId === planId &&
        Date.parse(request.expiresAt) >= Date.now()
      ) {
        requests.push(request);
      }
    } catch {
      // Invalid request files are never approval candidates.
    }
  }
  return requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function approveReleasePlan(
  planId: string,
  approvedBy: string,
  root?: string,
): ReleaseApprovalRequest {
  if (!approvedBy.trim())
    throw new Error("An authenticated approver is required");
  const request = readSigned<ReleaseApprovalRequest>(
    approvalPath(planId, "request", root),
    root,
  );
  if (request.planId !== planId || Date.parse(request.expiresAt) < Date.now()) {
    throw new Error("Release approval request has expired");
  }
  const grant: ReleaseApprovalGrant = {
    schemaVersion: 1,
    planId,
    projectDir: request.projectDir,
    commit: request.commit,
    approvedBy: approvedBy.trim(),
    approvedAt: new Date().toISOString(),
  };
  writeSigned(approvalPath(planId, "grant", root), grant, root);
  return request;
}

export function consumeReleaseApproval(
  plan: ReleasePlan,
  root?: string,
): { approvedBy: string; approvedAt: string } {
  const grantPath = approvalPath(plan.id, "grant", root);
  const claimPath = `${grantPath}.claimed-${crypto.randomUUID()}`;
  try {
    renameSync(grantPath, claimPath);
  } catch {
    throw new Error(
      "Release plan needs approval in Settings → Integrations → Apple mobile",
    );
  }
  try {
    const grant = readSigned<ReleaseApprovalGrant>(claimPath, root);
    if (
      grant.schemaVersion !== 1 ||
      grant.planId !== plan.id ||
      grant.projectDir !== plan.projectDir ||
      grant.commit !== plan.commit ||
      Date.parse(grant.approvedAt) < Date.parse(plan.createdAt) ||
      Date.parse(grant.approvedAt) > Date.parse(plan.expiresAt)
    ) {
      throw new Error("Release approval does not match this plan");
    }
    return { approvedBy: grant.approvedBy, approvedAt: grant.approvedAt };
  } finally {
    try {
      unlinkSync(claimPath);
    } catch {}
    try {
      unlinkSync(approvalPath(plan.id, "request", root));
    } catch {}
  }
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
  recordApprovalRequest(plan);
  return { plan, planFile: relative(plan.projectDir, path) };
}

export async function createBuildPlan(
  projectDirInput: string,
  action: Exclude<ReleaseAction, "upload">,
  options: { marketingVersion?: string; buildNumber?: string } = {},
) {
  const projectDir = resolveProjectDir(projectDirInput);
  const { config, hash, git } = await enforceReleasePolicy(projectDir);
  credentials(true, projectDir);
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
  credentials(true, projectDir);
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
