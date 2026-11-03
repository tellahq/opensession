import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "daytona-retirement-"));
const previous = process.env.OPENSESSION_SESSIONS_DIR;
process.env.OPENSESSION_SESSIONS_DIR = root;
let getError: Error | undefined;
let deleteError: Error | undefined;
let deleted = false;
const connections = await import("../connections");
mock.module("../connections", () => ({
  ...connections,
  getSandboxConnection: () => ({ settings: {} }),
  sandboxProviderCredential: () => ({ apiKey: "test-only" }),
}));
mock.module("@daytonaio/sdk", () => ({
  Daytona: class {
    async get() {
      if (getError) throw getError;
      return { id: "failed-vm", state: "started" };
    }
    async delete() {
      if (deleteError) throw deleteError;
      deleted = true;
    }
  },
}));
const { DaytonaProvider } = await import("./daytona");
const { writeRemoteState, readRemoteState } = await import("./bootstrap");
const provider = new DaytonaProvider();
beforeEach(async () => {
  deleted = false;
  getError = undefined;
  deleteError = undefined;
  await writeRemoteState({
    provider: "daytona",
    sandboxId: "failed-vm",
    sessionId: "test-failed",
    cwd: "/test",
    trustProfile: "interactive",
    egressAllowlist: [],
    createdAt: "2026-09-16T00:00:00Z",
    lastActivityAt: "2026-09-16T00:00:00Z",
  });
});
afterAll(() => {
  mock.restore();
  if (previous === undefined) delete process.env.OPENSESSION_SESSIONS_DIR;
  else process.env.OPENSESSION_SESSIONS_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("a refused delete propagates and retains the paid machine's recovery mapping", async () => {
  deleteError = new Error("provider timed out");
  await expect(provider.destroy("failed-vm")).rejects.toThrow(
    "provider timed out",
  );
  expect((await readRemoteState("daytona", "failed-vm"))?.sessionId).toBe(
    "test-failed",
  );
  expect(deleted).toBe(false);
});

test("a failed lookup is not treated as a missing machine", async () => {
  getError = new Error("connection refused");
  await expect(provider.destroy("failed-vm")).rejects.toThrow(
    "connection refused",
  );
  expect(await readRemoteState("daytona", "failed-vm")).not.toBeNull();
});

test("successful deletion forgets the mapping", async () => {
  await provider.destroy("failed-vm");
  expect(deleted).toBe(true);
  expect(await readRemoteState("daytona", "failed-vm")).toBeNull();
});

test("already-deleted machines are idempotent even in strict mode", async () => {
  getError = Object.assign(new Error("not found"), { statusCode: 404 });
  await provider.destroy("failed-vm", { strict: true });
  expect(await readRemoteState("daytona", "failed-vm")).toBeNull();
});

test("strict deletion retains the mapping if the machine still exists", async () => {
  await expect(provider.destroy("failed-vm", { strict: true })).rejects.toThrow(
    "still exists",
  );
  expect(await readRemoteState("daytona", "failed-vm")).not.toBeNull();
});
