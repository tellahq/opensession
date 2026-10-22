import type { ApplePlatform } from "./types";

/** Everything that differs between Apple platforms in one place, so adding
 *  macOS distribution means filling in a row rather than finding branches. */
export interface PlatformProfile {
  /** App Store Connect API platform value. */
  asc: "IOS" | "MAC_OS";
  /** xcodebuild archive destination. */
  archiveDestination: string;
  /** xcodebuild SDK for an unsigned development build. */
  unsignedSdk: string;
  /** `xcrun altool --type` value. */
  uploadType: "ios" | "macos";
  /** Extension of the exported, uploadable artifact. */
  artifactExtension: ".ipa" | ".pkg";
  /** XcodeGen platform name. */
  xcodegen: "iOS" | "macOS";
  distribution: boolean;
}

export const PLATFORMS: Record<ApplePlatform, PlatformProfile> = {
  ios: {
    asc: "IOS",
    archiveDestination: "generic/platform=iOS",
    unsignedSdk: "iphonesimulator",
    uploadType: "ios",
    artifactExtension: ".ipa",
    xcodegen: "iOS",
    distribution: true,
  },
  macos: {
    asc: "MAC_OS",
    archiveDestination: "generic/platform=macOS",
    unsignedSdk: "macosx",
    uploadType: "macos",
    artifactExtension: ".pkg",
    xcodegen: "macOS",
    distribution: false,
  },
};

export function platformProfile(platform: ApplePlatform): PlatformProfile {
  return PLATFORMS[platform];
}

export function requireDistribution(platform: ApplePlatform): PlatformProfile {
  const profile = PLATFORMS[platform];
  if (!profile.distribution) {
    throw new Error(
      `${platform} distribution is not supported yet; only iOS apps can be released`,
    );
  }
  return profile;
}
