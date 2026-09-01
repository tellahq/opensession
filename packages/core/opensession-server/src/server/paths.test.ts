import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import {
  __setSessionsDirForTest,
  isClientSessionId,
  resolveLegacySessionsPath,
} from "./paths";

/**
 * The store has been ~/.backstage-chats, ~/.opensession-chats, and
 * ~/.opensession-sessions. It now lives at ~/.opensession/sessions. Absolute
 * paths under it were persisted verbatim
 * (walkthrough stills, staged uploads, media links already spliced into PR
 * bodies), so a rename orphans records that are otherwise perfectly intact.
 */
describe("resolveLegacySessionsPath", () => {
  let home = "";
  let sessions = "";
  let prevHome: string | undefined;
  let prevSessionsDir = "";

  beforeAll(() => {
    home = mkdtempSync(`${tmpdir()}/os-paths-`);
    sessions = `${home}/.opensession/sessions`;
    mkdirSync(`${sessions}/uploads/walkthrough/os-1`, { recursive: true });
    writeFileSync(`${sessions}/uploads/walkthrough/os-1/after.png`, "png");
    prevHome = process.env.HOME;
    process.env.HOME = home;
    prevSessionsDir = __setSessionsDirForTest(sessions);
  });

  afterAll(() => {
    __setSessionsDirForTest(prevSessionsDir);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("remaps the previous Open Session path onto the active store", () => {
    const stored = `${home}/.opensession-sessions/uploads/walkthrough/os-1/after.png`;
    expect(resolveLegacySessionsPath(stored)).toBe(
      `${sessions}/uploads/walkthrough/os-1/after.png`,
    );
  });

  it("remaps a path under a former store name onto the active store", () => {
    const stored = `${home}/.opensession-chats/uploads/walkthrough/os-1/after.png`;
    expect(resolveLegacySessionsPath(stored)).toBe(
      `${sessions}/uploads/walkthrough/os-1/after.png`,
    );
  });

  it("remaps the older backstage name too", () => {
    const stored = `${home}/.backstage-chats/uploads/walkthrough/os-1/after.png`;
    expect(resolveLegacySessionsPath(stored)).toBe(
      `${sessions}/uploads/walkthrough/os-1/after.png`,
    );
  });

  it("leaves a legacy path alone when the file isn't in the active store", () => {
    const stored = `${home}/.opensession-chats/uploads/walkthrough/os-1/gone.png`;
    expect(resolveLegacySessionsPath(stored)).toBe(stored);
  });

  it("prefers a legacy dir that still has the file itself", () => {
    mkdirSync(`${home}/.opensession-chats/uploads/walkthrough/os-1`, {
      recursive: true,
    });
    const stored = `${home}/.opensession-chats/uploads/walkthrough/os-1/live.png`;
    writeFileSync(stored, "png");
    writeFileSync(`${sessions}/uploads/walkthrough/os-1/live.png`, "other");
    expect(resolveLegacySessionsPath(stored)).toBe(stored);
  });

  it("passes through paths that are not under the store", () => {
    expect(resolveLegacySessionsPath("/tmp/demo.mp4")).toBe("/tmp/demo.mp4");
    expect(resolveLegacySessionsPath(`${sessions}/uploads/a.png`)).toBe(
      `${sessions}/uploads/a.png`,
    );
    expect(resolveLegacySessionsPath("")).toBe("");
  });

  it("keeps traversal segments in the path for the caller to reject", () => {
    const stored = `${home}/.opensession-chats/uploads/../../etc/passwd`;
    expect(resolveLegacySessionsPath(stored)).toContain("..");
  });
});

describe("isClientSessionId", () => {
  it("accepts only client-minted os uuidv7 ids", () => {
    expect(isClientSessionId("os-019f0000-0000-7000-8000-000000000001")).toBe(
      true,
    );
    expect(isClientSessionId("bks-019f0000-0000-7000-8000-000000000001")).toBe(
      false,
    );
    expect(isClientSessionId("os-019f0000-0000-4000-8000-000000000001")).toBe(
      false,
    );
    expect(isClientSessionId("os-release-2026")).toBe(false);
  });
});

/**
 * A dev/demo instance repoints OPENSESSION_STATE_DIR, and statePath reads it
 * at call time, so the legacy remap has to land in THAT instance's store.
 * Resolving the prefix live and the store from a load-time pin made the two
 * halves belong to different instances.
 */
describe("resolveLegacySessionsPath under a repointed state root", () => {
  let stateRoot = "";
  let prevStateDir: string | undefined;

  beforeAll(() => {
    stateRoot = mkdtempSync(`${tmpdir()}/os-paths-state-`);
    mkdirSync(`${stateRoot}/.opensession-sessions/uploads/walkthrough/os-2`, {
      recursive: true,
    });
    writeFileSync(
      `${stateRoot}/.opensession-sessions/uploads/walkthrough/os-2/after.png`,
      "png",
    );
    prevStateDir = process.env.OPENSESSION_STATE_DIR;
    process.env.OPENSESSION_STATE_DIR = stateRoot;
  });

  afterAll(() => {
    if (prevStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
    else process.env.OPENSESSION_STATE_DIR = prevStateDir;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("remaps into the isolated store, not the load-time one", () => {
    const stored = `${stateRoot}/.opensession-chats/uploads/walkthrough/os-2/after.png`;
    expect(resolveLegacySessionsPath(stored)).toBe(
      `${stateRoot}/.opensession-sessions/uploads/walkthrough/os-2/after.png`,
    );
  });
});
