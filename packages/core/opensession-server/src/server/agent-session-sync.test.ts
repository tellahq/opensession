import { afterAll, expect, mock, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = mkdtempSync(join(tmpdir(), "agent-session-sync-"));
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;
mock.module("./session-cache", () => ({
  publishSessionChange: async () => {},
}));
const { syncAgentSessionEngine } = await import("./agent-session-sync");
const { statePath } = await import("./paths");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
  rmSync(root, { recursive: true, force: true });
});

test("concurrent patches to one session file keep every change", async () => {
  const dir = statePath(".linear-sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "eng-1-race.json");
  writeFileSync(path, JSON.stringify({ claudeSessionId: "old", model: "a" }));
  const session = {
    id: "linear-eng-1-race",
    source: "linear" as const,
    branch: "eng-1-race",
  };
  const results = await Promise.all([
    syncAgentSessionEngine(session, { engineSessionId: "new-engine" }),
    syncAgentSessionEngine(session, { model: "b" }),
  ]);
  expect(results).toEqual([true, true]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    claudeSessionId: "new-engine",
    model: "b",
  });
});
