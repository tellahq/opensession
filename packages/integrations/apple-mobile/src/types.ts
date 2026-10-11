export type BuildBackend = "xtool" | "xcode";

/** Apple platform an app ships on. Only iOS distribution is enabled today;
 *  macOS is accepted in config so projects can declare it ahead of support. */
export type ApplePlatform = "ios" | "macos";

export interface XcodeProjectConfig {
  container: "workspace" | "project";
  path: string;
  scheme: string;
  configuration?: string;
  /** Regenerate the Xcode project before building, so the generated
   *  project does not need to be committed. */
  generator?: "xcodegen";
}

export interface AppleMobileConfig {
  version: 1;
  backend: BuildBackend;
  bundleId: string;
  platform: ApplePlatform;
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

export type ReleaseAction =
  | "adhoc"
  | "testflight"
  | "upload"
  | "submit"
  | "release";

/** Actions that only call the App Store Connect API: no checkout or Xcode. */
export type StoreAction = Extract<ReleaseAction, "submit" | "release">;

export type AppStoreReleaseType = "manual" | "after_approval";

export interface CommandSpec {
  executable: string;
  args: string[];
  cwd: string;
  /** What the command does in a release; absent on ad-hoc commands. */
  step?: "generate" | "archive" | "export" | "upload";
}

export interface ReleasePlan {
  schemaVersion: 1;
  id: string;
  action: ReleaseAction;
  projectDir: string;
  commit: string;
  branch: string;
  configHash: string;
  bundleId: string;
  platform: ApplePlatform;
  createdAt: string;
  expiresAt: string;
  marketingVersion?: string;
  buildNumber?: string;
  sourceArtifact?: string;
  sourceArtifactName?: string;
  sourceArtifactSha256?: string;
  releaseType?: AppStoreReleaseType;
  whatsNew?: string;
  /** Human-readable effects shown to the approver. */
  effects: string[];
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
