import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { loadConfig } from "./config";
import { findExecutable, runChecked, runCommand } from "./exec";
import { resolveProjectDir, resolveProjectPath } from "./security";

async function probe(name: string, args: string[]) {
  const path = findExecutable(name);
  if (!path) return { path: null, usable: false, detail: "not installed" };
  try {
    const result = await runCommand(
      { executable: name, args, cwd: process.cwd() },
      { timeoutMs: 10_000 },
    );
    const detail = (result.stdout || result.stderr)
      .trim()
      .split("\n")
      .slice(0, 3)
      .join(" | ");
    return { path, usable: result.exitCode === 0, detail };
  } catch (error) {
    return {
      path,
      usable: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function doctor(projectDirInput?: string) {
  const platform = `${process.platform}/${process.arch}`;
  const tools = {
    swift: await probe("swift", ["--version"]),
    xtool: await probe("xtool", ["--version"]),
    xcodebuild: await probe("xcodebuild", ["-version"]),
    xcrun: await probe("xcrun", ["--version"]),
    unzip: await probe("unzip", ["-v"]),
    python3: await probe("python3", ["--version"]),
    git: await probe("git", ["--version"]),
  };
  let project: unknown;
  if (projectDirInput) {
    const projectDir = resolveProjectDir(projectDirInput);
    try {
      project = (await loadConfig(projectDir)).config;
    } catch (error) {
      project = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    platform,
    mode: process.env.APPLE_MOBILE_MCP_MODE ?? "build",
    tools,
    appleCredentialsConfigured: {
      keyId: Boolean(process.env.APPLE_ASC_KEY_ID),
      issuerId: Boolean(process.env.APPLE_ASC_ISSUER_ID),
      privateKeyPath: Boolean(process.env.APPLE_ASC_PRIVATE_KEY_PATH),
    },
    project,
    notes: [
      "xtool builds are development/experimental; this integration never uses xtool for App Store distribution.",
      "Xcode is required for archive, ad-hoc, and TestFlight release operations.",
    ],
  };
}

export async function runSwiftTests(projectDirInput: string) {
  const projectDir = resolveProjectDir(projectDirInput);
  if (!existsSync(join(projectDir, "Package.swift")))
    throw new Error("Package.swift is required");
  return runChecked(
    { executable: "swift", args: ["test"], cwd: projectDir },
    { timeoutMs: 30 * 60_000 },
  );
}

export async function buildUnsigned(
  projectDirInput: string,
  configuration?: "debug" | "release",
  ipa = false,
) {
  const projectDir = resolveProjectDir(projectDirInput);
  const { config } = await loadConfig(projectDir);
  const selected = configuration ?? config.xtool?.configuration ?? "debug";

  if (config.backend === "xtool") {
    const args = ["dev", "build", "--configuration", selected];
    if (ipa) args.push("--ipa");
    const result = await runChecked(
      { executable: "xtool", args, cwd: projectDir },
      { timeoutMs: 45 * 60_000 },
    );
    const match = result.stdout.match(/Wrote to (.+)$/m);
    return {
      backend: "xtool",
      configuration: selected,
      artifact: match?.[1]?.trim() ?? null,
      result,
    };
  }

  const xcode = config.xcode!;
  const containerPath = resolveProjectPath(projectDir, xcode.path);
  const args = [
    xcode.container === "workspace" ? "-workspace" : "-project",
    containerPath,
    "-scheme",
    xcode.scheme,
    "-configuration",
    xcode.configuration ?? selected[0]!.toUpperCase() + selected.slice(1),
    "-sdk",
    "iphonesimulator",
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ];
  const result = await runChecked(
    { executable: "xcodebuild", args, cwd: projectDir },
    { timeoutMs: 45 * 60_000 },
  );
  return { backend: "xcode", configuration: selected, artifact: null, result };
}

export async function inspectIpa(
  projectDirInput: string,
  artifactPath: string,
) {
  const projectDir = resolveProjectDir(projectDirInput);
  const ipa = resolveProjectPath(projectDir, artifactPath);
  if (!ipa.endsWith(".ipa"))
    throw new Error("artifactPath must reference an .ipa");
  if (!findExecutable("unzip") || !findExecutable("python3"))
    throw new Error("unzip and python3 are required");

  const temporary = mkdtempSync(join(tmpdir(), "apple-mobile-ipa-"));
  try {
    await runChecked({
      executable: "unzip",
      args: ["-qq", ipa, "-d", temporary],
      cwd: projectDir,
    });
    const glob = new Bun.Glob("Payload/*.app/Info.plist");
    const matches = Array.from(
      glob.scanSync({ cwd: temporary, absolute: true }),
    );
    if (matches.length !== 1)
      throw new Error(`Expected one app Info.plist, found ${matches.length}`);
    const script = [
      "import json, plistlib, sys",
      "with open(sys.argv[1], 'rb') as f: p=plistlib.load(f)",
      "keys=['CFBundleIdentifier','CFBundleDisplayName','CFBundleShortVersionString','CFBundleVersion','MinimumOSVersion']",
      "print(json.dumps({k:p.get(k) for k in keys}, sort_keys=True))",
    ].join("; ");
    const parsed = await runChecked({
      executable: "python3",
      args: ["-c", script, matches[0]!],
      cwd: projectDir,
    });
    const metadata = JSON.parse(parsed.stdout);
    const sha256 = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(ipa).arrayBuffer())
      .digest("hex");
    return {
      artifact: relative(projectDir, ipa),
      file: basename(ipa),
      size: Bun.file(ipa).size,
      sha256,
      metadata,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
