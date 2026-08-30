import { chmodSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ensureDirectory } from "./build";
import { findExecutable, runChecked } from "./exec";
import { CREDENTIAL_REFS, credentials, exportOptions, loadPlan } from "./plans";
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
  const { plan, config } = await loadPlan(projectDir, planId);
  if (confirmation !== plan.commit) {
    throw new Error("confirmation must exactly match the planned commit SHA");
  }
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
  ensureDirectory(plan.outputDirectory);
  const results: CommandResult[] = [];
  let artifact = plan.sourceArtifact;

  if (plan.action === "upload") {
    results.push(
      await runChecked(withCredentials(plan.commands[0]!), {
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
      exportOptions(config, plan.action),
      plan.projectDir,
    );
    results.push(
      await runChecked(withCredentials(plan.commands[0]!), {
        timeoutMs: 60 * 60_000,
      }),
    );
    results.push(
      await runChecked(withCredentials(plan.commands[1]!), {
        timeoutMs: 45 * 60_000,
      }),
    );
    artifact = findExportedIpa(exportPath);
    if (plan.action === "testflight") {
      const upload = structuredClone(plan.commands[2]!);
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

  const sha256 = artifact
    ? new Bun.CryptoHasher("sha256")
        .update(await Bun.file(artifact).arrayBuffer())
        .digest("hex")
    : undefined;
  return {
    planId: plan.id,
    action: plan.action,
    commit: plan.commit,
    artifact: artifact ? relative(plan.projectDir, artifact) : undefined,
    sha256,
    results,
  };
}

export function safePlanView(plan: ReleasePlan) {
  return {
    ...plan,
    commands: plan.commands.map((command) => ({
      ...command,
      args: command.args.map((arg) => {
        if (arg === process.env.APPLE_ASC_PRIVATE_KEY_PATH)
          return "<private-key-path>";
        if (arg === process.env.APPLE_ASC_KEY_ID) return "<key-id>";
        if (arg === process.env.APPLE_ASC_ISSUER_ID) return "<issuer-id>";
        return arg;
      }),
    })),
  };
}
