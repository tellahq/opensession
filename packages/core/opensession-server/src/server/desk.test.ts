import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "opensession-desk-"));
const sessionsDir = join(scratch, "sessions");
const env = {
  ...process.env,
  OPENSESSION_STATE_DIR: scratch,
  OPENSESSION_SESSIONS_DIR: sessionsDir,
};

function ensureDesk() {
  const proc = Bun.spawnSync(
    [
      "bun",
      "-e",
      `import { ensureDeskSession } from "./packages/core/opensession-server/src/server/desk.ts";
console.log(JSON.stringify(ensureDeskSession("Desk Test")));`,
    ],
    { cwd: process.cwd(), env },
  );
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  const lines = proc.stdout.toString().trim().split("\n");
  return JSON.parse(lines.at(-1)!) as { sessionId: string };
}

function readSession(sessionId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(sessionsDir, `${sessionId}.json`), "utf8"),
  ) as Record<string, unknown>;
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("Desk session", () => {
  test("creates a repo-less scratch session", () => {
    const { sessionId } = ensureDesk();
    const session = readSession(sessionId);

    expect(session).toMatchObject({
      id: sessionId,
      title: "Desk",
      mode: "ask",
      desk: true,
      repoLess: true,
      branch: "",
      worktreeDir: "",
    });
    expect(session).not.toHaveProperty("repo");
    expect(session).not.toHaveProperty("workspaceId");
  });

  test("migrates an existing Desk away from workspace metadata", () => {
    const { sessionId } = ensureDesk();
    writeFileSync(
      join(sessionsDir, `${sessionId}.json`),
      JSON.stringify({
        ...readSession(sessionId),
        repoLess: false,
        repo: "opensession",
        branch: "main",
        worktreeDir: "/tmp/opensession",
        workspaceId: "workspace-1",
        attachedRepos: [{ project: "other" }],
      }),
    );

    ensureDesk();
    const session = readSession(sessionId);
    expect(session).toMatchObject({
      repoLess: true,
      branch: "",
      worktreeDir: "",
      workspaceId: null,
      attachedRepos: [],
    });
    expect(session).not.toHaveProperty("repo");
  });
});
