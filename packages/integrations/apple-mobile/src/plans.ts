import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config";
import {
  isWithin,
  resolvePrivateKeyPath,
  resolveProjectDir,
  resolveProjectPath,
} from "./security";
import { runChecked } from "./exec";
import { enforceReleasePolicy } from "./project";
import type {
  AppleMobileConfig,
  CommandSpec,
  ReleaseAction,
  ReleasePlan,
} from "./types";

const PLAN_TTL_MS = 60 * 60_000;
const RELEASE_CHECKOUT_REF = "<APPLE_MOBILE_RELEASE_CHECKOUT>";
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
  resolveProjectPath(projectDir, xcode.path);
  const args = [
    xcode.container === "workspace" ? "-workspace" : "-project",
    join(RELEASE_CHECKOUT_REF, xcode.path),
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
  return { executable: "xcodebuild", args, cwd: RELEASE_CHECKOUT_REF };
}

function xcodeExportCommand(
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
    cwd: RELEASE_CHECKOUT_REF,
  };
}

function uploadCommand(ipaPlaceholder: string): CommandSpec {
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
    cwd: RELEASE_CHECKOUT_REF,
  };
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

function ensureControlledState(projectDir: string): void {
  const state = appleMobileStateDir();
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  if (isWithin(projectDir, realpathSync(state))) {
    throw new Error("APPLE_MOBILE_STATE_DIR must be outside the app project");
  }
}

function checkedPlanId(planId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(planId)) throw new Error("Invalid planId");
  return planId;
}

function controlledPlanPath(planId: string, root?: string): string {
  return join(
    appleMobileStateDir(root),
    "plans",
    `${checkedPlanId(planId)}.json`,
  );
}

function controlledOutputDirectory(planId: string, root?: string): string {
  return join(appleMobileStateDir(root), "outputs", checkedPlanId(planId));
}

function controlledArtifactDirectory(planId: string, root?: string): string {
  return join(appleMobileStateDir(root), "artifacts", checkedPlanId(planId));
}

function executionDirectory(
  planId: string,
  executionId: string,
  root?: string,
): string {
  return join(
    appleMobileStateDir(root),
    "executions",
    checkedPlanId(planId),
    executionId,
  );
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
  sourceArtifactName?: string;
  sourceArtifactSha256?: string;
}

interface ReleaseApprovalGrant {
  schemaVersion: 1;
  planId: string;
  projectDir: string;
  commit: string;
  action: ReleaseAction;
  sourceArtifactName?: string;
  sourceArtifactSha256?: string;
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
  return join(approvalsDir(root), `${checkedPlanId(planId)}.${kind}.json`);
}

export function discardReleasePlan(planId: string, root?: string): void {
  checkedPlanId(planId);
  rmSync(controlledPlanPath(planId, root), { force: true });
  rmSync(controlledArtifactDirectory(planId, root), {
    recursive: true,
    force: true,
  });
  rmSync(controlledOutputDirectory(planId, root), {
    recursive: true,
    force: true,
  });
  rmSync(approvalPath(planId, "request", root), { force: true });
  rmSync(approvalPath(planId, "grant", root), { force: true });
}

function writeSigned<T>(path: string, value: T, root?: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ value, signature: signature(value, root) }, null, 2) +
        "\n",
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
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
    sourceArtifactName: plan.sourceArtifactName,
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

function validApprovalRequest(
  request: ReleaseApprovalRequest,
  planId: string,
): boolean {
  const createdAt = Date.parse(request.createdAt);
  const expiresAt = Date.parse(request.expiresAt);
  return (
    request.schemaVersion === 1 &&
    request.planId === planId &&
    ["adhoc", "testflight", "upload"].includes(request.action) &&
    typeof request.projectDir === "string" &&
    request.projectDir.length > 0 &&
    typeof request.commit === "string" &&
    /^[0-9a-f]{40}$/.test(request.commit) &&
    Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    createdAt <= expiresAt &&
    (request.action !== "upload" ||
      (typeof request.sourceArtifactName === "string" &&
        request.sourceArtifactName.length > 0 &&
        basename(request.sourceArtifactName) === request.sourceArtifactName &&
        typeof request.sourceArtifactSha256 === "string" &&
        /^[0-9a-f]{64}$/.test(request.sourceArtifactSha256)))
  );
}

export function listReleaseApprovalRequests(
  root?: string,
): ReleaseApprovalRequest[] {
  const dir = approvalsDir(root);
  if (!existsSync(dir)) return [];
  const now = Date.now();
  const requests: ReleaseApprovalRequest[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".request.json")) continue;
    const planId = name.slice(0, -".request.json".length);
    try {
      checkedPlanId(planId);
      const requestPath = join(dir, name);
      const request = readSigned<ReleaseApprovalRequest>(requestPath, root);
      if (!validApprovalRequest(request, planId)) continue;
      const expiresAt = Date.parse(request.expiresAt);
      if (expiresAt < now) {
        discardReleasePlan(planId, root);
        continue;
      }
      if (existsSync(approvalPath(planId, "grant", root))) continue;
      requests.push(request);
    } catch {
      // Invalid request files are never approval candidates.
    }
  }
  return requests
    .sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        b.planId.localeCompare(a.planId),
    )
    .slice(0, 100);
}

export function approveReleasePlan(
  planId: string,
  approvedBy: string,
  root?: string,
): ReleaseApprovalRequest {
  if (!approvedBy.trim())
    throw new Error("An authenticated approver is required");
  let request: ReleaseApprovalRequest;
  try {
    request = readSigned<ReleaseApprovalRequest>(
      approvalPath(planId, "request", root),
      root,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Release approval request is not pending");
    }
    throw error;
  }
  if (!validApprovalRequest(request, planId)) {
    throw new Error("Release approval request is invalid");
  }
  if (Date.parse(request.expiresAt) < Date.now()) {
    discardReleasePlan(planId, root);
    throw new Error("Release approval request has expired");
  }
  const grant: ReleaseApprovalGrant = {
    schemaVersion: 1,
    planId,
    projectDir: request.projectDir,
    commit: request.commit,
    action: request.action,
    sourceArtifactName: request.sourceArtifactName,
    sourceArtifactSha256: request.sourceArtifactSha256,
    approvedBy: approvedBy.trim(),
    approvedAt: new Date().toISOString(),
  };
  writeSigned(approvalPath(planId, "grant", root), grant, root);
  return request;
}

export function consumeReleaseApproval(
  plan: ReleasePlan,
  root?: string,
  hooks: { afterRequestClaimed?: () => void } = {},
): { approvedBy: string; approvedAt: string } {
  const requestPath = approvalPath(plan.id, "request", root);
  const requestClaimPath = `${requestPath}.claimed-${crypto.randomUUID()}`;
  try {
    renameSync(requestPath, requestClaimPath);
  } catch {
    throw new Error(
      "Release plan needs approval in Settings → Integrations → Apple mobile",
    );
  }

  hooks.afterRequestClaimed?.();
  const grantPath = approvalPath(plan.id, "grant", root);
  const grantClaimPath = `${grantPath}.claimed-${crypto.randomUUID()}`;
  try {
    renameSync(grantPath, grantClaimPath);
  } catch {
    try {
      renameSync(requestClaimPath, requestPath);
    } catch (error) {
      throw new Error(
        "Release approval request could not be restored after grant claim failed",
        { cause: error },
      );
    }
    throw new Error(
      "Release plan needs approval in Settings → Integrations → Apple mobile",
    );
  }

  try {
    const request = readSigned<ReleaseApprovalRequest>(requestClaimPath, root);
    const grant = readSigned<ReleaseApprovalGrant>(grantClaimPath, root);
    if (
      !validApprovalRequest(request, plan.id) ||
      request.projectDir !== plan.projectDir ||
      request.commit !== plan.commit ||
      request.action !== plan.action ||
      request.sourceArtifactName !== plan.sourceArtifactName ||
      request.sourceArtifactSha256 !== plan.sourceArtifactSha256 ||
      grant.schemaVersion !== 1 ||
      grant.planId !== plan.id ||
      grant.projectDir !== plan.projectDir ||
      grant.commit !== plan.commit ||
      grant.action !== plan.action ||
      grant.sourceArtifactName !== plan.sourceArtifactName ||
      grant.sourceArtifactSha256 !== plan.sourceArtifactSha256 ||
      Date.parse(grant.approvedAt) < Date.parse(plan.createdAt) ||
      Date.parse(grant.approvedAt) > Date.parse(plan.expiresAt)
    ) {
      throw new Error("Release approval does not match this plan");
    }
    return { approvedBy: grant.approvedBy, approvedAt: grant.approvedAt };
  } finally {
    try {
      unlinkSync(grantClaimPath);
    } catch {}
    try {
      unlinkSync(requestClaimPath);
    } catch {}
  }
}

export function planPath(planId: string, root?: string): string {
  return controlledPlanPath(planId, root);
}

async function sha256File(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
}

async function copyApprovedArtifact(
  source: string,
  planId: string,
): Promise<{ path: string; name: string; sha256: string }> {
  const directory = controlledArtifactDirectory(planId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = basename(source);
  const path = join(directory, name);
  const temporary = join(directory, `.copy-${crypto.randomUUID()}`);
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    return { path, name, sha256: await sha256File(path) };
  } catch (error) {
    rmSync(temporary, { force: true });
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function persist(plan: ReleasePlan) {
  const path = planPath(plan.id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  writeFileSync(
    temporary,
    JSON.stringify({ plan, signature: signature(plan) }, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  renameSync(temporary, path);
  recordApprovalRequest(plan);
  return {
    plan,
    planFile: relative(appleMobileStateDir(), path),
  };
}

export async function createBuildPlan(
  projectDirInput: string,
  action: Exclude<ReleaseAction, "upload">,
  options: { marketingVersion?: string; buildNumber?: string } = {},
) {
  const projectDir = resolveProjectDir(projectDirInput);
  const { config, hash, git } = await enforceReleasePolicy(projectDir);
  ensureControlledState(projectDir);
  credentials(true, projectDir);
  const id = crypto.randomUUID();
  const outputDirectory = controlledOutputDirectory(id);
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
    xcodeExportCommand(archivePath, exportPath, plistPath),
  ];
  if (action === "testflight") commands.push(uploadCommand("<exported-ipa>"));
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
  return persist(plan);
}

export async function createUploadPlan(
  projectDirInput: string,
  artifactPath: string,
) {
  const projectDir = resolveProjectDir(projectDirInput);
  const { config, hash, git } = await enforceReleasePolicy(projectDir);
  ensureControlledState(projectDir);
  credentials(true, projectDir);
  const artifact = resolveProjectPath(projectDir, artifactPath);
  if (!artifact.endsWith(".ipa"))
    throw new Error("Only .ipa uploads are supported");
  const id = crypto.randomUUID();
  const approvedArtifact = await copyApprovedArtifact(artifact, id);
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
    sourceArtifact: approvedArtifact.path,
    sourceArtifactName: approvedArtifact.name,
    sourceArtifactSha256: approvedArtifact.sha256,
    outputDirectory: dirname(approvedArtifact.path),
    commands: [uploadCommand(approvedArtifact.path)],
  };
  try {
    return await persist(plan);
  } catch (error) {
    rmSync(controlledArtifactDirectory(id), { recursive: true, force: true });
    throw error;
  }
}

export async function loadPlan(
  projectDirInput: string,
  planId: string,
): Promise<{ plan: ReleasePlan }> {
  const projectDir = resolveProjectDir(projectDirInput);
  const stored = JSON.parse(await Bun.file(planPath(planId)).text()) as {
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
  if (Date.parse(plan.expiresAt) < Date.now()) {
    discardReleasePlan(planId);
    throw new Error("Release plan has expired");
  }
  if (plan.action === "upload") {
    if (
      !plan.sourceArtifact ||
      !plan.sourceArtifactName ||
      basename(plan.sourceArtifact) !== plan.sourceArtifactName ||
      !plan.sourceArtifactSha256 ||
      plan.sourceArtifact !==
        join(controlledArtifactDirectory(plan.id), plan.sourceArtifactName)
    ) {
      throw new Error("Invalid approved IPA reference");
    }
  }
  return { plan };
}

export interface PreparedReleaseExecution {
  checkoutDir: string;
  executionDir: string;
  config: AppleMobileConfig;
  commands: CommandSpec[];
}

function materializeCommand(
  command: CommandSpec,
  checkoutDir: string,
  config: AppleMobileConfig,
  sourceArtifact?: { planned: string; execution: string },
): CommandSpec {
  if (command.cwd !== RELEASE_CHECKOUT_REF) {
    throw new Error("Release command is not bound to the isolated checkout");
  }
  const plannedContainer = config.xcode
    ? join(RELEASE_CHECKOUT_REF, config.xcode.path)
    : undefined;
  const executionContainer = config.xcode
    ? resolveProjectPath(checkoutDir, config.xcode.path)
    : undefined;
  return {
    ...command,
    cwd: checkoutDir,
    args: command.args.map((arg) => {
      if (sourceArtifact && arg === sourceArtifact.planned) {
        return sourceArtifact.execution;
      }
      if (plannedContainer && arg === plannedContainer) {
        return executionContainer!;
      }
      if (arg === RELEASE_CHECKOUT_REF) return checkoutDir;
      if (arg.startsWith(`${RELEASE_CHECKOUT_REF}${sep}`)) {
        return resolveProjectPath(
          checkoutDir,
          relative(RELEASE_CHECKOUT_REF, arg),
        );
      }
      return arg;
    }),
  };
}

export async function prepareReleaseExecution(
  plan: ReleasePlan,
): Promise<PreparedReleaseExecution> {
  ensureControlledState(plan.projectDir);
  const executionDir = executionDirectory(plan.id, crypto.randomUUID());
  const checkoutDir = join(executionDir, "checkout");
  mkdirSync(executionDir, { recursive: true, mode: 0o700 });
  try {
    await runChecked({
      executable: "git",
      args: ["worktree", "add", "--detach", checkoutDir, plan.commit],
      cwd: plan.projectDir,
    });
    const commit = (
      await runChecked({
        executable: "git",
        args: ["rev-parse", "HEAD"],
        cwd: checkoutDir,
      })
    ).stdout.trim();
    if (commit !== plan.commit) {
      throw new Error("Isolated release checkout is not at the planned commit");
    }
    const status = (
      await runChecked({
        executable: "git",
        args: ["status", "--porcelain"],
        cwd: checkoutDir,
      })
    ).stdout.trim();
    if (status) throw new Error("Isolated release checkout is not clean");
    const loaded = await loadConfig(checkoutDir);
    if (loaded.hash !== plan.configHash) {
      throw new Error("Planned configuration does not match the commit");
    }

    let sourceArtifact: { planned: string; execution: string } | undefined;
    if (
      plan.action === "upload" &&
      plan.sourceArtifact &&
      plan.sourceArtifactName &&
      plan.sourceArtifactSha256
    ) {
      const executionArtifactDir = join(executionDir, "approved-artifact");
      mkdirSync(executionArtifactDir, { mode: 0o700 });
      const executionArtifact = join(
        executionArtifactDir,
        plan.sourceArtifactName,
      );
      copyFileSync(plan.sourceArtifact, executionArtifact);
      chmodSync(executionArtifact, 0o600);
      if ((await sha256File(executionArtifact)) !== plan.sourceArtifactSha256) {
        throw new Error("Approved IPA copy does not match the planned SHA-256");
      }
      sourceArtifact = {
        planned: plan.sourceArtifact,
        execution: executionArtifact,
      };
    }

    return {
      checkoutDir,
      executionDir,
      config: loaded.config,
      commands: plan.commands.map((command) =>
        materializeCommand(command, checkoutDir, loaded.config, sourceArtifact),
      ),
    };
  } catch (error) {
    await cleanupReleaseExecution({
      checkoutDir,
      executionDir,
      projectDir: plan.projectDir,
    });
    throw error;
  }
}

export async function cleanupReleaseExecution(input: {
  checkoutDir: string;
  executionDir: string;
  projectDir: string;
}): Promise<void> {
  try {
    await runChecked({
      executable: "git",
      args: ["worktree", "remove", "--force", input.checkoutDir],
      cwd: input.projectDir,
    });
  } catch {
    rmSync(input.checkoutDir, { recursive: true, force: true });
  } finally {
    rmSync(input.executionDir, { recursive: true, force: true });
  }
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
