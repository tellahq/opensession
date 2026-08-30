export type BuildBackend = "xtool" | "xcode";

export interface XcodeProjectConfig {
  container: "workspace" | "project";
  path: string;
  scheme: string;
  configuration?: string;
}

export interface AppleMobileConfig {
  version: 1;
  backend: BuildBackend;
  bundleId: string;
  teamId?: string;
  xtool?: {
    configuration?: "debug" | "release";
  };
  xcode?: XcodeProjectConfig;
  release?: {
    requireClean?: boolean;
    allowedBranches?: string[];
    artifactDirectory?: string;
  };
}

export type ReleaseAction = "adhoc" | "testflight" | "upload";

export interface CommandSpec {
  executable: string;
  args: string[];
  cwd: string;
}

export interface ReleasePlan {
  schemaVersion: 1;
  id: string;
  action: ReleaseAction;
  projectDir: string;
  commit: string;
  branch: string;
  configHash: string;
  createdAt: string;
  expiresAt: string;
  marketingVersion?: string;
  buildNumber?: string;
  sourceArtifact?: string;
  sourceArtifactSha256?: string;
  outputDirectory: string;
  commands: CommandSpec[];
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}
