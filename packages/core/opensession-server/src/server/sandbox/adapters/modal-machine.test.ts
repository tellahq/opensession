import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = mkdtempSync(join(tmpdir(), "opensession-modal-machine-"));
process.env.OPENSESSION_SESSIONS_DIR = root;
const { writeRemoteState } = await import("./bootstrap");
const { ModalProvider, modalSandboxId } = await import("./modal");

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a session's Modal machine is found even when its start failed", () => {
  const provider = new ModalProvider();
  expect(provider.machineFor("s-none")).toBeUndefined();
  const now = new Date().toISOString();
  writeRemoteState({
    sandboxId: modalSandboxId("s-failed"),
    remoteId: "sb-123",
    provider: "modal",
    sessionId: "s-failed",
    cwd: "/home/ubuntu/worktrees/acme",
    repoId: "acme",
    branch: "main",
    resources: { gpu: "T4" },
    createdAt: now,
    lastActivityAt: now,
    trustProfile: "interactive",
    egressAllowlist: [],
  });
  expect(provider.machineFor("s-failed")).toBe(modalSandboxId("s-failed"));
});

test("state files from the retired Modal provider are not machines", () => {
  const now = new Date().toISOString();
  writeRemoteState({
    sandboxId: "sb-legacy",
    provider: "modal",
    sessionId: "s-legacy",
    cwd: "/home/ubuntu/worktrees/acme",
    repoId: "acme",
    branch: "main",
    createdAt: now,
    lastActivityAt: now,
    trustProfile: "interactive",
    egressAllowlist: [],
  });
  expect(new ModalProvider().machineFor("s-legacy")).toBeUndefined();
});
