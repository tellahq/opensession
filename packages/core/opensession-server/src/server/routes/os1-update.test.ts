import { describe, expect, test } from "bun:test";
import {
  chromeDownloadTag,
  isMacInstallerAsset,
  isMacReleaseAsset,
  macDownloadTag,
} from "./os1-update";

describe("isMacReleaseAsset", () => {
  test("accepts the current artifactName", () => {
    expect(isMacReleaseAsset("OpenSession-0.3.12-arm64.zip")).toBe(true);
  });

  // Renaming the app renamed the asset. The feed serves whatever the latest
  // release carries, so until a release ships under the new name the newest
  // asset is still an OS1-* one.
  test("still accepts assets published before the rename", () => {
    expect(isMacReleaseAsset("OS1-0.3.12-arm64.zip")).toBe(true);
  });

  test("rejects the other assets a release carries", () => {
    expect(isMacReleaseAsset("OpenSession-0.3.12-arm64.dmg")).toBe(false);
    expect(isMacReleaseAsset("OpenSession-0.3.12-arm64.zip.blockmap")).toBe(
      false,
    );
    expect(isMacReleaseAsset("os1-chrome-v0.1.0.crx")).toBe(false);
    expect(isMacReleaseAsset("OpenSession-0.3.12-x64.zip")).toBe(false);
    expect(isMacReleaseAsset(undefined)).toBe(false);
  });
});

describe("isMacInstallerAsset", () => {
  test("accepts current and pre-rename disk images only", () => {
    expect(isMacInstallerAsset("OpenSession-0.3.12-arm64.dmg")).toBe(true);
    expect(isMacInstallerAsset("OS1-0.3.12-arm64.dmg")).toBe(true);
    expect(isMacInstallerAsset("OpenSession-0.3.12-arm64.zip")).toBe(false);
    expect(isMacInstallerAsset("OpenSession-0.3.12-x64.dmg")).toBe(false);
  });
});

describe("release download routes", () => {
  test("recognizes the Mac URL emitted by the update feed", () => {
    expect(
      macDownloadTag("/api/packages/clients/mac/download/v0.4.15.zip"),
    ).toBe("v0.4.15");
  });

  test("recognizes the Chrome URL emitted by its update feed", () => {
    expect(
      chromeDownloadTag(
        "/api/packages/clients/chrome/download/os1-chrome-v0.4.15.crx",
      ),
    ).toBe("os1-chrome-v0.4.15");
  });

  test("keeps routes used by older clients working", () => {
    expect(macDownloadTag("/api/os1-mac/download/v0.4.15.zip")).toBe("v0.4.15");
    expect(
      chromeDownloadTag("/api/os1-chrome/download/os1-chrome-v0.4.15.crx"),
    ).toBe("os1-chrome-v0.4.15");
  });

  test("rejects unrelated routes", () => {
    expect(
      macDownloadTag("/api/packages/clients/mac/download/latest.zip"),
    ).toBeNull();
    expect(macDownloadTag("/api/other/download/v0.4.15.zip")).toBeNull();
  });
});
