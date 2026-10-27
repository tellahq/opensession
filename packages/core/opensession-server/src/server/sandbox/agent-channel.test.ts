import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AGENT_LOST_MESSAGE,
  handleSandboxAgentUpgrade,
  mintSandboxAgentToken,
  resetSandboxAgentsForTests,
  revokeSandboxAgent,
  SANDBOX_AGENT_PATH,
  sandboxAgentClose,
  sandboxAgentConnected,
  sandboxAgentMessage,
  sandboxAgentOpen,
  sandboxAgentRequest,
  waitForSandboxAgent,
} from "./agent-channel";
import {
  composeAgentShell,
  SANDBOX_AGENT_ENTRY,
  sandboxAgentLaunchScript,
  sandboxAgentPrepareScript,
  withSandboxAgent,
} from "./agent-driver";
import type { RemoteDriver } from "./adapters/bootstrap";
import {
  commandEnv,
  keepTail,
  probeToken,
} from "../../runner-host/sandbox-agent";

let server: ReturnType<typeof Bun.serve>;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "sandbox-agent-test-"));
// Read per call: never the live sandbox.json.
process.env.OPENSESSION_SANDBOX_CONFIG = join(dir, "sandbox.json");
const agents: Array<ReturnType<typeof Bun.spawn>> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      return (
        handleSandboxAgentUpgrade(req, srv as any, path) ?? (undefined as any)
      );
    },
    websocket: {
      open: (ws) => void sandboxAgentOpen(ws),
      message: (ws, message) => void sandboxAgentMessage(ws, message),
      close: (ws) => void sandboxAgentClose(ws),
    },
  });
  base = `ws://127.0.0.1:${server.port}${SANDBOX_AGENT_PATH}`;
});

afterEach(() => {
  resetSandboxAgentsForTests();
  for (const agent of agents.splice(0))
    try {
      agent.kill();
    } catch {}
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

function startAgent(sandboxId: string, token: string) {
  const tokenFile = join(dir, `${sandboxId}.token`);
  writeFileSync(tokenFile, token);
  const agent = Bun.spawn(["bun", "run", SANDBOX_AGENT_ENTRY], {
    env: {
      ...process.env,
      OPENSESSION_SANDBOX_AGENT_URL: `${base}?sandbox=${sandboxId}`,
      OPENSESSION_SANDBOX_AGENT_TOKEN_FILE: tokenFile,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  agents.push(agent);
  return { agent, tokenFile };
}

test("an agent dials out, runs commands, and keeps its token to itself", async () => {
  const token = mintSandboxAgentToken({ sandboxId: "sbx-a", provider: "box" });
  const { tokenFile } = startAgent("sbx-a", token);
  expect(await waitForSandboxAgent("sbx-a", 10_000)).toBe(true);
  // Read once and deleted: never on disk while the agent runs.
  expect(existsSync(tokenFile)).toBe(false);

  const ran = await sandboxAgentRequest(
    "sbx-a",
    {
      t: "exec",
      script:
        "echo out; echo err >&2; env | grep -c OPENSESSION_SANDBOX_AGENT_ || true; exit 3",
      timeoutMs: 10_000,
    },
    20_000,
  );
  expect(ran).toEqual({ exitCode: 3, stdout: "out\n0\n", stderr: "err\n" });

  const file = join(dir, "nested", "written.txt");
  const wrote = await sandboxAgentRequest(
    "sbx-a",
    { t: "write", path: file, b64: Buffer.from("héllo").toString("base64") },
    10_000,
  );
  expect(wrote?.exitCode).toBe(0);
  expect(readFileSync(file, "utf8")).toBe("héllo");
});

test("a timeout stops every process the command started", async () => {
  const token = mintSandboxAgentToken({ sandboxId: "sbx-t", provider: "box" });
  startAgent("sbx-t", token);
  expect(await waitForSandboxAgent("sbx-t", 10_000)).toBe(true);
  const marker = join(dir, "survived");
  const started = Date.now();
  const ran = await sandboxAgentRequest(
    "sbx-t",
    {
      t: "exec",
      script: `(sleep 3; touch ${marker}) & sleep 30`,
      timeoutMs: 500,
    },
    10_000,
  );
  expect(ran?.exitCode).toBe(124);
  expect(Date.now() - started).toBeLessThan(5_000);
  await Bun.sleep(3_500);
  expect(existsSync(marker)).toBe(false);
});

test("a detached process outlives its request", async () => {
  const token = mintSandboxAgentToken({ sandboxId: "sbx-d", provider: "box" });
  startAgent("sbx-d", token);
  expect(await waitForSandboxAgent("sbx-d", 10_000)).toBe(true);
  const marker = join(dir, "detached");
  const spawned = await sandboxAgentRequest(
    "sbx-d",
    { t: "spawn", script: `sleep 0.3; touch ${marker}` },
    10_000,
  );
  expect(spawned?.exitCode).toBe(0);
  await Bun.sleep(1_000);
  expect(existsSync(marker)).toBe(true);
});

test("an unknown token is refused before any socket, and a stale agent exits", async () => {
  const token = mintSandboxAgentToken({ sandboxId: "sbx-r", provider: "box" });
  expect(await probeToken(`${base}?sandbox=sbx-r`, token)).toBe("valid");
  expect(await probeToken(`${base}?sandbox=sbx-r`, "nope")).toBe("rejected");
  expect(await probeToken(`${base}?sandbox=sbx-other`, token)).toBe("rejected");
  revokeSandboxAgent("sbx-r");
  const { agent } = startAgent("sbx-r", token);
  expect(await agent.exited).toBe(0);
});

test("a new token replaces the old agent and fails its requests in flight", async () => {
  const first = mintSandboxAgentToken({ sandboxId: "sbx-n", provider: "box" });
  startAgent("sbx-n", first);
  expect(await waitForSandboxAgent("sbx-n", 10_000)).toBe(true);
  const pending = sandboxAgentRequest(
    "sbx-n",
    { t: "exec", script: "sleep 10", timeoutMs: 20_000 },
    30_000,
  );
  mintSandboxAgentToken({ sandboxId: "sbx-n", provider: "box" });
  expect(sandboxAgentConnected("sbx-n")).toBe(false);
  expect((await pending)?.stderr).toBe(AGENT_LOST_MESSAGE);
  expect(
    sandboxAgentRequest("sbx-n", { t: "exec", script: "true" }, 1_000),
  ).toBeNull();
});

test("the driver takes the provider lane until the agent is connected", async () => {
  const calls: string[] = [];
  const inner: RemoteDriver = {
    async exec(cmd) {
      calls.push(`exec:${cmd}`);
      return { exitCode: 0, stdout: "inner", stderr: "" };
    },
    async execBackground(cmd) {
      calls.push(`bg:${cmd}`);
    },
    async writeFile(path) {
      calls.push(`write:${path}`);
    },
    async ensureStarted() {},
  };
  const driver = withSandboxAgent(inner, {
    providerId: "box",
    sandboxId: "sbx-f",
  });
  expect((await driver.exec("echo hi")).stdout).toBe("inner");
  await driver.writeFile("/tmp/x", "y");
  expect(calls).toEqual(["exec:echo hi", "write:/tmp/x"]);

  const token = mintSandboxAgentToken({ sandboxId: "sbx-f", provider: "box" });
  startAgent("sbx-f", token);
  expect(await waitForSandboxAgent("sbx-f", 10_000)).toBe(true);
  const viaAgent = await driver.exec("echo $GREETING", {
    cwd: dir,
    env: { GREETING: "from the agent" },
  });
  expect(viaAgent.stdout).toBe("from the agent\n");
  // The env reaches the process, not its command line.
  const argv = await driver.exec("cat /proc/$$/cmdline | tr '\\0' ' '", {
    env: { GH_TOKEN: "ghu_secret_value" },
  });
  expect(argv.exitCode).toBe(0);
  expect(argv.stdout).not.toContain("ghu_secret_value");
  expect(calls).toHaveLength(2);
});

test("helpers fold env and cwd, strip the credential, and keep tails", () => {
  expect(composeAgentShell("pwd", { cwd: "/w x", env: { A: "1 2" } })).toBe(
    "cd '/w x' && { env A='1 2' sh -c pwd\n}",
  );
  expect(
    commandEnv({
      PATH: "/bin",
      OPENSESSION_SANDBOX_AGENT_URL: "u",
      X: undefined,
    }),
  ).toEqual({ PATH: "/bin" });
  expect(keepTail("abcdef", 3)).toBe("[... 3 characters omitted ...]\ndef");
  expect(
    sandboxAgentPrepareScript({ bun: "/h/.bun/bin/bun", home: "/h" }),
  ).toContain("exit 3");
  const launch = sandboxAgentLaunchScript({
    bun: "/h/.bun/bin/bun",
    home: "/h",
    path: "/bin",
    entry: "/h/a.ts",
    endpoint: "wss://example.test/sandbox-agent-ws?sandbox=s",
  });
  expect(launch).toContain("echo $$ > /tmp/opensession-agent/pid");
  expect(launch).toContain("exec env HOME=/h");
  expect(launch).not.toContain("TOKEN=");
});
