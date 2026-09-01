import { chmodSync, copyFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { ensureDirectory } from "./build";
import { findExecutable, runChecked } from "./exec";
import { resolveProjectPath } from "./security";
import {
  CREDENTIAL_REFS,
  cleanupReleaseExecution,
  consumeReleaseApproval,
  credentials,
  discardReleasePlan,
  exportOptions,
  loadPlan,
  prepareReleaseExecution,
} from "./plans";
import type { CommandResult, CommandSpec, ReleasePlan } from "./types";

async function writePlist(
  path: string,
  value: Record<string, unknown>,
  cwd: string,
) {
  const json = JSON.stringify(value);
  const script =
    "import json,plistlib,sys; plistlib.dump(json.loads(sys.argv[2]),open(sys.argv[1],'wb'),fmt=plistlib.FMT_XML)";
  await runChecked({
    executable: "python3",
    args: ["-c", script, path, json],
    cwd,
  });
  chmodSync(path, 0o600);
}

function privateKeyEnv(): Record<string, string> {
  const path = credentials(true).keyPath!;
  return { API_PRIVATE_KEYS_DIR: dirname(path) };
}

function withCredentials(command: CommandSpec): CommandSpec {
  const auth = credentials(true);
  const values: Record<string, string> = {
    [CREDENTIAL_REFS.keyId]: auth.keyId!,
    [CREDENTIAL_REFS.issuerId]: auth.issuerId!,
    [CREDENTIAL_REFS.keyPath]: auth.keyPath!,
  };
  return {
    ...command,
    args: command.args.map((arg) => values[arg] ?? arg),
  };
}

function publishArtifact(
  projectDir: string,
  artifactDirectory: string | undefined,
  planId: string,
  artifact: string,
): string {
  const root = resolveProjectPath(
    projectDir,
    artifactDirectory ?? ".build/apple-mobile",
    { mustExist: false },
  );
  const destinationDir = join(root, planId);
  ensureDirectory(destinationDir);
  const destination = join(destinationDir, basename(artifact));
  copyFileSync(artifact, destination);
  return destination;
}

function findExportedIpa(exportPath: string): string {
  const ipas = readdirSync(exportPath, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith(".ipa"))
    .map((entry) => join(exportPath, entry));
  if (ipas.length !== 1)
    throw new Error(`Expected one exported IPA, found ${ipas.length}`);
  return ipas[0]!;
}

export async function executePlan(
  projectDir: string,
  planId: string,
  confirmation: string,
) {
  const { plan } = await loadPlan(projectDir, planId);
  if (confirmation !== plan.commit) {
    throw new Error("confirmation must exactly match the planned commit SHA");
  }
  credentials(true, plan.projectDir);
  if (process.platform !== "darwin" || !findExecutable("xcodebuild")) {
    throw new Error("Release execution requires Xcode on macOS");
  }
  if (
    (plan.action === "testflight" || plan.action === "upload") &&
    !findExecutable("xcrun")
  ) {
    throw new Error(
      "TestFlight upload requires Xcode command-line tools on macOS",
    );
  }
  const prepared = await prepareReleaseExecution(plan);
  let approvalConsumed = false;
  try {
    const approval = consumeReleaseApproval(plan);
    approvalConsumed = true;
    ensureDirectory(plan.outputDirectory);
    const results: CommandResult[] = [];
    let artifact: string | undefined;
    let reportedArtifact: string | undefined;

    if (plan.action === "upload") {
      results.push(
        await runChecked(withCredentials(prepared.commands[0]!), {
          timeoutMs: 45 * 60_000,
          extraEnv: privateKeyEnv(),
        }),
      );
    } else {
      const exportPath = join(plan.outputDirectory, "export");
      const plistPath = join(plan.outputDirectory, "ExportOptions.plist");
      ensureDirectory(exportPath);
      await writePlist(
        plistPath,
        exportOptions(prepared.config, plan.action),
        prepared.checkoutDir,
      );
      results.push(
        await runChecked(withCredentials(prepared.commands[0]!), {
          timeoutMs: 60 * 60_000,
        }),
      );
      results.push(
        await runChecked(withCredentials(prepared.commands[1]!), {
          timeoutMs: 45 * 60_000,
        }),
      );
      artifact = findExportedIpa(exportPath);
      reportedArtifact = publishArtifact(
        plan.projectDir,
        prepared.config.release?.artifactDirectory,
        plan.id,
        artifact,
      );
      if (plan.action === "testflight") {
        const upload = structuredClone(prepared.commands[2]!);
        upload.args = upload.args.map((arg) =>
          arg === "<exported-ipa>" ? artifact! : arg,
        );
        results.push(
          await runChecked(withCredentials(upload), {
            timeoutMs: 45 * 60_000,
            extraEnv: privateKeyEnv(),
          }),
        );
      }
    }

    const sha256 =
      plan.action === "upload"
        ? plan.sourceArtifactSha256
        : artifact
          ? new Bun.CryptoHasher("sha256")
              .update(await Bun.file(artifact).arrayBuffer())
              .digest("hex")
          : undefined;
    return {
      planId: plan.id,
      action: plan.action,
      commit: plan.commit,
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      artifact:
        plan.action === "upload"
          ? plan.sourceArtifactName
          : reportedArtifact
            ? relative(plan.projectDir, reportedArtifact)
            : undefined,
      sha256,
      results,
    };
  } finally {
    try {
      await cleanupReleaseExecution({
        checkoutDir: prepared.checkoutDir,
        executionDir: prepared.executionDir,
        projectDir: plan.projectDir,
      });
    } finally {
      // Once execution starts, a failed command may already have signed or
      // uploaded externally. Burn the approval and plan on both success and
      // failure; preflight failures before consumption remain retryable.
      if (approvalConsumed) discardReleasePlan(plan.id);
    }
  }
}

export function safePlanView(plan: ReleasePlan) {
  const controlledPaths = [plan.sourceArtifact, plan.outputDirectory].filter(
    (value): value is string => Boolean(value),
  );
  const redactControlledPath = (value: string) => {
    const root = controlledPaths.find(
      (path) => value === path || value.startsWith(`${path}/`),
    );
    if (!root) return value;
    const suffix = value.slice(root.length);
    return root === plan.sourceArtifact
      ? `<approved-ipa:${plan.sourceArtifactName}>${suffix}`
      : `<controlled-release-output>${suffix}`;
  };
  return {
    ...plan,
    sourceArtifact: plan.sourceArtifact ? plan.sourceArtifactName : undefined,
    outputDirectory: "<controlled-release-output>",
    commands: plan.commands.map((command) => ({
      ...command,
      args: command.args.map((arg) => {
        if (arg === process.env.APPLE_ASC_PRIVATE_KEY_PATH)
          return "<private-key-path>";
        if (arg === process.env.APPLE_ASC_KEY_ID) return "<key-id>";
        if (arg === process.env.APPLE_ASC_ISSUER_ID) return "<issuer-id>";
        return redactControlledPath(arg);
      }),
    })),
  };
}
