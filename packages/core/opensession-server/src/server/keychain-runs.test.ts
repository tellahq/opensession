/**
 * Scripted runs: a real child process pages through an API via
 * KEYCHAIN_PROXY_URL. Every call is injected, checked against the grant and
 * the credential's ceiling, capped and audited, and the URL is dead the
 * moment the run ends. Another run's secret opens nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "kc-runs-"));
const STORE = join(dir, "kc.json");
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;

import type { StartRunInput } from "./keychain-runs";

const kc = await import("./keychain");
const runs = await import("./keychain-runs");

const SECRET = "sk-run-secret-5678";
const SESSION = "s-run";

type Seen = { url: string; method: string; headers: Headers };
let seen: Seen[] = [];
let events: Array<Record<string, any>> = [];
const fetchImpl = (async (url: URL, init: RequestInit) => {
  seen.push({
    url: String(url),
    method: String(init.method),
    headers: new Headers(init.headers),
  });
  // An API that echoes the key back: the script must never see it.
  return Response.json(
    { ok: true, echoed: SECRET },
    { headers: { "x-request-id": `req-${seen.length}` } },
  );
}) as unknown as typeof fetch;
const deps = { fetchImpl, audit: (e: Record<string, any>) => events.push(e) };

beforeEach(() => {
  if (existsSync(STORE)) rmSync(STORE);
  const g = globalThis as any;
  g.__keychainCredentials?.clear();
  g.__keychainGrants?.clear();
  g.__keychainAsks?.clear();
  seen = [];
  events = [];
});
afterEach(async () => {
  for (const r of runs.listCredentialRuns(SESSION))
    if (r.state === "running") runs.stopCredentialRun(r.id, SESSION);
});

function credential() {
  return kc.addCredential({
    owner: "Alex",
    service: "acme",
    host: "api.example.test",
    secret: SECRET,
    allowedMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/v1/"],
  });
}

/** A script file in the temp dir, and the command that runs it. */
function script(name: string, source: string): string {
  writeFileSync(join(dir, name), source);
  return `"${process.execPath}" ${name}`;
}

function grantRun(credentialId: string, command: string, maxCalls = 1000) {
  return kc.__mintGrantForTest({
    credentialId,
    sessionId: SESSION,
    requestedBy: "Sam",
    mode: "run",
    run: { command, maxCalls },
  });
}

function start(command: string, over: Partial<StartRunInput> = {}) {
  return runs.startCredentialRun({
    sessionId: SESSION,
    credential: "acme",
    command,
    cwd: dir,
    logDir: join(dir, "logs"),
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    deps,
    ...over,
  });
}

async function started(command: string, over: Partial<StartRunInput> = {}) {
  const result = await start(command, over);
  if ("error" in result) throw new Error(result.error);
  return result.run;
}

/** Wait for a script to write its proxy URL to a file. */
async function proxyUrlFrom(file: string): Promise<string> {
  const path = join(dir, file);
  for (let i = 0; i < 500 && !existsSync(path); i++) await Bun.sleep(10);
  return readFileSync(path, "utf-8").trim();
}

const PAGES = 250;

describe("a scripted run", () => {
  test("a script's many calls are injected, held to the ceiling and audited", async () => {
    const cred = credential();
    const command = script(
      "bulk.ts",
      `
const base = process.env.KEYCHAIN_PROXY_URL;
const statuses = {};
const bump = (s) => (statuses[s] = (statuses[s] || 0) + 1);
let leaked = false;
for (let batch = 0; batch < ${PAGES}; batch += 25) {
  await Promise.all(
    Array.from({ length: 25 }, async (_, i) => {
      const res = await fetch(base + "/v1/customers?page=" + (batch + i), {
        headers: { authorization: "Bearer mine", accept: "application/json" },
      });
      const text = await res.text();
      if (text.includes(${JSON.stringify(SECRET)})) leaked = true;
      bump(res.status);
    }),
  );
}
bump("delete:" + (await fetch(base + "/v1/customers/1", { method: "DELETE" })).status);
bump("admin:" + (await fetch(base + "/admin/users")).status);
console.log(JSON.stringify({ statuses, leaked }));
`,
    );
    grantRun(cred.id, command);

    const run = await started(command);
    expect(run.state).toBe("running");
    const done = await runs.waitForCredentialRun(run.id, 30_000);
    expect(done?.state).toBe("exited");
    expect(done?.exitCode).toBe(0);

    const output = JSON.parse(
      readFileSync(done!.logPath, "utf-8").trim().split("\n").pop()!,
    );
    expect(output).toEqual({
      statuses: { 200: PAGES, "delete:403": 1, "admin:403": 1 },
      leaked: false,
    });
    expect(done?.calls).toBe(PAGES);
    expect(done?.denied).toBe(2);

    expect(seen).toHaveLength(PAGES);
    for (const call of seen) {
      expect(call.url).toMatch(
        /^https:\/\/api\.example\.test\/v1\/customers\?page=\d+$/,
      );
      expect(call.method).toBe("GET");
      expect(call.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    }

    const calls = events.filter((e) => e.kind === "keychain_run_call");
    expect(calls).toHaveLength(PAGES);
    expect(new Set(calls.map((e) => e.grant_id))).toEqual(
      new Set([run.grantId]),
    );
    expect(
      events
        .filter((e) => e.kind === "keychain_run_denied")
        .map((e) => `${e.method} ${e.path}`)
        .sort(),
    ).toEqual(["DELETE /v1/customers/1", "GET /admin/users"]);
    expect(events.at(-1)).toMatchObject({
      kind: "keychain_run_ended",
      state: "exited",
      calls: PAGES,
      denied: 2,
    });

    // The grant started one run and is spent.
    expect(kc.listGrants({ sessionId: SESSION })[0]!.status).toBe("used");
    expect(await start(command)).toHaveProperty("error");
  });

  test("the URL is refused once the process exits", async () => {
    const cred = credential();
    const command = script(
      "once.ts",
      `await Bun.write("once.url", process.env.KEYCHAIN_PROXY_URL);
const res = await fetch(process.env.KEYCHAIN_PROXY_URL + "/v1/ping");
console.log(res.status);`,
    );
    grantRun(cred.id, command);
    const run = await started(command);
    const url = await proxyUrlFrom("once.url");
    await runs.waitForCredentialRun(run.id, 30_000);
    expect(seen).toHaveLength(1);

    const after = await fetch(`${url}/v1/ping`).then(
      (r) => r.status,
      () => "refused",
    );
    expect(after).toBe("refused");
    expect(seen).toHaveLength(1);
  });

  test("one run's secret opens nothing on another run's proxy, and a stopped run is closed", async () => {
    const cred = credential();
    const waiter = (file: string) =>
      script(
        `${file}.ts`,
        `await Bun.write(${JSON.stringify(file)}, process.env.KEYCHAIN_PROXY_URL);
await new Promise(() => {});`,
      );
    const a = waiter("a.url");
    const b = waiter("b.url");
    grantRun(cred.id, a);
    grantRun(cred.id, b);
    const runA = await started(a);
    const runB = await started(b);
    const urlA = new URL(await proxyUrlFrom("a.url"));
    const urlB = new URL(await proxyUrlFrom("b.url"));

    // B's secret on A's port, and a made-up one.
    const crossed = await fetch(`${urlA.origin}${urlB.pathname}/v1/ping`);
    expect(crossed.status).toBe(404);
    const guessed = await fetch(`${urlA.origin}/${"A".repeat(43)}/v1/ping`);
    expect(guessed.status).toBe(404);
    // A's own secret still works.
    expect((await fetch(`${urlA.href}/v1/ping`)).status).toBe(200);
    expect(seen).toHaveLength(1);

    expect(runs.stopCredentialRun(runA.id, SESSION)).toHaveProperty("run");
    const stopped = await runs.waitForCredentialRun(runA.id, 30_000);
    expect(stopped?.state).toBe("stopped");
    const after = await fetch(`${urlA.href}/v1/ping`).then(
      (r) => r.status,
      () => "refused",
    );
    expect(after).toBe("refused");
    expect(
      runs.listCredentialRuns(SESSION).find((r) => r.id === runB.id)?.state,
    ).toBe("running");
    runs.stopCredentialRun(runB.id, SESSION);
    await runs.waitForCredentialRun(runB.id, 30_000);
    expect(seen).toHaveLength(1);
  });

  test("calls past the approved cap are refused", async () => {
    const cred = credential();
    const command = script(
      "capped.ts",
      `const out = [];
for (let i = 0; i < 5; i++) out.push((await fetch(process.env.KEYCHAIN_PROXY_URL + "/v1/x")).status);
console.log(out.join(","));`,
    );
    grantRun(cred.id, command, 3);
    const run = await started(command);
    const done = await runs.waitForCredentialRun(run.id, 30_000);
    expect(readFileSync(done!.logPath, "utf-8").trim()).toBe(
      "200,200,200,429,429",
    );
    expect(seen).toHaveLength(3);
  });

  test("revoking the grant cuts the run off and ends it", async () => {
    const cred = credential();
    const command = script(
      "revoked.ts",
      `await Bun.write("revoked.url", process.env.KEYCHAIN_PROXY_URL);
await new Promise(() => {});`,
    );
    const grant = grantRun(cred.id, command);
    const run = await started(command);
    const url = await proxyUrlFrom("revoked.url");
    expect((await fetch(`${url}/v1/x`)).status).toBe(200);

    expect(kc.revokeGrant(grant.id, "Alex")).toEqual({ ok: true });
    const after = await fetch(`${url}/v1/x`).then(
      (r) => r.status,
      () => "refused",
    );
    expect(after).toBe("refused");
    const done = await runs.waitForCredentialRun(run.id, 30_000);
    expect(done?.state).toBe("revoked");
    expect(seen).toHaveLength(1);
  });

  test("a run times out", async () => {
    const cred = credential();
    const command = script("slow.ts", "await new Promise(() => {});");
    grantRun(cred.id, command);
    const run = await started(command, { timeoutMinutes: 0.005 });
    const done = await runs.waitForCredentialRun(run.id, 30_000);
    expect(done?.state).toBe("timed_out");
  });

  test("only the approved command, with a run grant, can start", async () => {
    const cred = credential();
    const approved = script("approved.ts", "console.log(1)");
    expect(await start(approved)).toHaveProperty("error");

    kc.__mintGrantForTest({
      credentialId: cred.id,
      sessionId: SESSION,
      requestedBy: "Sam",
      mode: "standing",
    });
    expect(await start(approved)).toHaveProperty("error");

    grantRun(cred.id, approved);
    const other = await start(`${approved} --all`);
    expect("error" in other && other.error).toContain(
      "approved a different command",
    );
    expect(await start(approved, { sessionId: "s-other" })).toHaveProperty(
      "error",
    );
    const run = await started(approved);
    await runs.waitForCredentialRun(run.id, 30_000);
  });
});
