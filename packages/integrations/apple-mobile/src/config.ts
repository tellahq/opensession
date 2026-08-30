import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppleMobileConfig } from "./types";
import { resolveProjectPath } from "./security";

export const CONFIG_PATH = ".opensession/apple-mobile.json";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

export async function loadConfig(projectDir: string): Promise<{
  config: AppleMobileConfig;
  path: string;
  hash: string;
}> {
  const path = resolve(projectDir, CONFIG_PATH);
  if (!existsSync(path)) throw new Error(`Missing ${CONFIG_PATH}`);
  const text = await Bun.file(path).text();
  let raw: Record<string, unknown>;
  try {
    raw = object(JSON.parse(text), CONFIG_PATH);
  } catch (error) {
    throw new Error(
      `Invalid ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (raw.version !== 1) throw new Error(`${CONFIG_PATH}: version must be 1`);
  if (raw.backend !== "xtool" && raw.backend !== "xcode") {
    throw new Error(`${CONFIG_PATH}: backend must be xtool or xcode`);
  }
  const bundleId = optionalString(raw.bundleId, "bundleId");
  if (!bundleId || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) {
    throw new Error(`${CONFIG_PATH}: bundleId is invalid`);
  }

  const config: AppleMobileConfig = {
    version: 1,
    backend: raw.backend,
    bundleId,
    teamId: optionalString(raw.teamId, "teamId"),
  };

  if (raw.xtool !== undefined) {
    const xtool = object(raw.xtool, "xtool");
    const configuration = xtool.configuration;
    if (
      configuration !== undefined &&
      configuration !== "debug" &&
      configuration !== "release"
    ) {
      throw new Error("xtool.configuration must be debug or release");
    }
    config.xtool = {
      configuration: configuration as "debug" | "release" | undefined,
    };
  }

  if (raw.xcode !== undefined) {
    const xcode = object(raw.xcode, "xcode");
    if (xcode.container !== "workspace" && xcode.container !== "project") {
      throw new Error("xcode.container must be workspace or project");
    }
    const xcodePath = optionalString(xcode.path, "xcode.path");
    const scheme = optionalString(xcode.scheme, "xcode.scheme");
    if (!xcodePath || !scheme)
      throw new Error("xcode.path and xcode.scheme are required");
    resolveProjectPath(projectDir, xcodePath);
    config.xcode = {
      container: xcode.container,
      path: xcodePath,
      scheme,
      configuration: optionalString(xcode.configuration, "xcode.configuration"),
    };
  }

  if (raw.release !== undefined) {
    const release = object(raw.release, "release");
    const allowedBranches = release.allowedBranches;
    if (
      allowedBranches !== undefined &&
      (!Array.isArray(allowedBranches) ||
        allowedBranches.some((x) => typeof x !== "string" || !x))
    ) {
      throw new Error(
        "release.allowedBranches must be an array of non-empty strings",
      );
    }
    if (
      release.requireClean !== undefined &&
      typeof release.requireClean !== "boolean"
    ) {
      throw new Error("release.requireClean must be boolean");
    }
    const artifactDirectory = optionalString(
      release.artifactDirectory,
      "release.artifactDirectory",
    );
    if (artifactDirectory)
      resolveProjectPath(projectDir, artifactDirectory, { mustExist: false });
    config.release = {
      requireClean: release.requireClean as boolean | undefined,
      allowedBranches: allowedBranches as string[] | undefined,
      artifactDirectory,
    };
  }

  if (config.backend === "xcode" && !config.xcode) {
    throw new Error(
      `${CONFIG_PATH}: xcode configuration is required for the xcode backend`,
    );
  }
  if (
    config.backend === "xtool" &&
    !existsSync(resolve(projectDir, "xtool.yml"))
  ) {
    throw new Error(`${CONFIG_PATH}: xtool backend requires xtool.yml`);
  }

  const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  return { config, path, hash };
}
