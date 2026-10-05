/**
 * Scripted runs: a real script host runs a real child process that pages
 * through an API via KEYCHAIN_PROXY_URL. Every call is injected, checked
 * against the grant and the credential's ceiling, counted and audited, and
 * the URL is dead the moment the run ends. Another run's secret opens
 * nothing, and the run keeps going through a server restart.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "kc-runs-"));
// Short: the runs' relay sockets live under it.
const scriptRoot = mkdtempSync("/tmp/kcr-");
const STORE = join(dir, "kc.json");
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;

import type { StartRunInput } from "./keychain-runs";
import type { KeychainScriptedRun } from "./keychain";

const kc = await import("./keychain");
const runs = await import("./keychain-runs");
const scripts = await import("./script-runs");

// Real processes, and a host start per run.
setDefaultTimeout(30_000);

/** No user scope under test: a plain detached host, like a dev box. */
const scriptDeps = (extra: Record<string, unknown> = {}) => ({
  root: scriptRoot,
  hostArgv: [
    process.execPath,
    "run",
    join(import.meta.dir, "../script-host/main.ts"),
  ],
  launch: async (input: { argv: string[]; env: Record<string, string> }) => {
    const proc = Bun.spawn({
      cmd: input.argv,
      env: input.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      detached: true,
    });
    return { pid: proc.pid, exited: proc.exited };
  },
  deliver: async () => {},
  broadcast: () => {},
  ...extra,
});

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
  rmSync(scriptRoot, { recursive: true, force: true });
  scripts.__resetScriptRunsForTest(scriptDeps());
  runs.__resetKeychainRunsForTest();
  if (existsSync(STORE)) rmSync(STORE);
  const g = globalThis as any;
  g.__keychainCredentials?.clear();
  g.__keychainGrants?.clear();
  g.__keychainAsks?.clear();
  seen = [];
  events = [];
});
afterEach(async () => {
  for (const r of await runs.listCredentialRuns(SESSION))
    if (r.state === "running") {
      await runs.stopCredentialRun(r.id, SESSION);
      await runs.waitForCredentialRun(r.id, 15_000);
    }
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

function grantRun(credentialId: string, command: string) {
  return kc.__mintGrantForTest({
    credentialId,
    sessionId: SESSION,
    requestedBy: "Sam",
    mode: "run",
    run: { command },
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

/** Wait for a script to write its proxy URLs to a file, one per line. The
 *  file exists before its content is written, so wait for every line. */
async function proxyUrlFrom(file: string, lines = 1): Promise<string> {
  const path = join(dir, file);
  const written = () =>
    existsSync(path)
      ? readFileSync(path, "utf-8").trim().split("\n").filter(Boolean)
      : [];
  for (let i = 0; i < 500 && written().length < lines; i++) await Bun.sleep(10);
  return written().join("\n");
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

    expect(await runs.stopCredentialRun(runA.id, SESSION)).toHaveProperty(
      "run",
    );
    const stopped = await runs.waitForCredentialRun(runA.id, 30_000);
    expect(stopped?.state).toBe("stopped");
    const after = await fetch(`${urlA.href}/v1/ping`).then(
      (r) => r.status,
      () => "refused",
    );
    expect(after).toBe("refused");
    expect(
      (await runs.listCredentialRuns(SESSION)).find((r) => r.id === runB.id)
        ?.state,
    ).toBe("running");
    await runs.stopCredentialRun(runB.id, SESSION);
    await runs.waitForCredentialRun(runB.id, 30_000);
    expect(seen).toHaveLength(1);
  });

  test("a run keeps proxying past the call cap older approvals carried", async () => {
    const cred = credential();
    const command = script(
      "uncapped.ts",
      `const out = [];
for (let i = 0; i < 25; i++) out.push((await fetch(process.env.KEYCHAIN_PROXY_URL + "/v1/x")).status);
console.log(out.join(","));`,
    );
    // An approval stored before the cap was dropped still has maxCalls.
    kc.__mintGrantForTest({
      credentialId: cred.id,
      sessionId: SESSION,
      requestedBy: "Sam",
      mode: "run",
      run: { command, maxCalls: 3 } as KeychainScriptedRun,
    });
    const run = await started(command);
    const done = await runs.waitForCredentialRun(run.id, 30_000);
    expect(readFileSync(done!.logPath, "utf-8").trim()).toBe(
      Array(25).fill(200).join(","),
    );
    expect(seen).toHaveLength(25);
    expect(done).toMatchObject({ state: "exited", calls: 25, denied: 0 });
    expect(done).not.toHaveProperty("maxCalls");
    expect(done?.credentials[0]).not.toHaveProperty("maxCalls");
    expect(events.filter((e) => e.kind === "keychain_run_call")).toHaveLength(
      25,
    );
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
    // Refused at once (403 while the run is told to stop, 410 once it is
    // stopping, or a closed port once it ended), and never forwarded.
    const after = await fetch(`${url}/v1/x`).then(
      (r) => r.status,
      () => "refused",
    );
    expect([403, 410, "refused"]).toContain(after);
    const done = await runs.waitForCredentialRun(run.id, 30_000);
    expect(done?.state).toBe("revoked");
    expect(seen).toHaveLength(1);
  });

  test("a grant revoked while the run is starting never runs the command", async () => {
    const cred = credential();
    const command = script("never.ts", `await Bun.write("never.ran", "yes");`);
    const grant = grantRun(cred.id, command);
    const pending = start(command);
    // Claimed, and suspended on the log file before spawning.
    const claimed = () =>
      kc.listGrants({ sessionId: SESSION }).find((g) => g.id === grant.id)
        ?.runId;
    for (let i = 0; i < 2000 && !claimed(); i++) await Bun.sleep(1);
    expect(claimed()).toBeDefined();
    expect(kc.revokeGrant(grant.id, "Alex")).toEqual({ ok: true });

    const result = await pending;
    expect("error" in result && result.error).toContain("revoked");
    await Bun.sleep(200);
    expect(existsSync(join(dir, "never.ran"))).toBe(false);
    expect(events.at(-1)).toMatchObject({
      kind: "keychain_run_ended",
      state: "revoked",
      calls: 0,
    });
  });

  test("two concurrent starts cannot both claim one grant", async () => {
    const cred = credential();
    const command = script("twice.ts", "console.log(1)");
    grantRun(cred.id, command);
    const [a, b] = await Promise.all([start(command), start(command)]);
    expect(["error" in a, "error" in b].sort()).toEqual([false, true]);
    const run = "run" in a ? a.run : "run" in b ? b.run : undefined;
    await runs.waitForCredentialRun(run!.id, 30_000);
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

describe("a scripted run with two credentials", () => {
  const PAY = "sk-payments-1111";
  const BILL = "bk-billing-2222";

  /** Echoes every header it got, so a leaked credential would show. */
  const echoing = (async (url: URL, init: RequestInit) => {
    const headers = new Headers(init.headers);
    seen.push({ url: String(url), method: String(init.method), headers });
    return Response.json({ got: Object.fromEntries(headers) });
  }) as unknown as typeof fetch;
  const twoDeps = { ...deps, fetchImpl: echoing };

  function credentials() {
    const payments = kc.addCredential({
      owner: "Alex",
      service: "payments-prod",
      host: "api.payments.example.test",
      secret: PAY,
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/v1/"],
    });
    const billing = kc.addCredential({
      owner: "Bea",
      service: "billing-prod",
      host: "api.billing.example.test",
      secret: BILL,
      injection: { header: "X-Api-Key", scheme: "" },
      allowedMethods: ["POST"],
      allowedPathPrefixes: ["/v2/"],
    });
    return { payments, billing };
  }

  const MEMBERS = [
    {
      service: "payments-prod",
      host: "api.payments.example.test",
      owner: "Alex",
    },
    {
      service: "billing-prod",
      host: "api.billing.example.test",
      owner: "Bea",
    },
  ];

  /** The grants each owner's approval mints for one request. `only` mints
   *  just some of them, as when an owner has not answered. */
  function grantGroup(
    ids: { payments: string; billing: string },
    command: string,
    only: Array<"payments" | "billing"> = ["payments", "billing"],
  ) {
    const group = { id: `krg-${crypto.randomUUID()}`, members: MEMBERS };
    return only.map((which) =>
      kc.__mintGrantForTest({
        credentialId: ids[which],
        sessionId: SESSION,
        requestedBy: "Sam",
        mode: "run",
        run: { command, group },
      }),
    );
  }

  const both = {
    credential: undefined,
    credentials: ["payments-prod", "billing-prod"],
  };

  test("each proxy injects only its own credential, on its own host, within its own limits", async () => {
    const { payments, billing } = credentials();
    const command = script(
      "sync.ts",
      `
const pay = process.env.KEYCHAIN_PROXY_URL_PAYMENTS_PROD;
const bill = process.env.KEYCHAIN_PROXY_URL_BILLING_PROD;
const out = { single: process.env.KEYCHAIN_PROXY_URL ?? null, sync: [], leaked: false, denied: {} };
const check = async (res) => {
  const text = await res.text();
  if (text.includes(${JSON.stringify(PAY)}) || text.includes(${JSON.stringify(BILL)})) out.leaked = true;
  return res.status;
};
for (let i = 0; i < 5; i++) {
  const read = await check(await fetch(pay + "/v1/subscriptions?page=" + i, { headers: { "x-api-key": "mine" } }));
  const write = await check(await fetch(bill + "/v2/usage", { method: "POST", body: "{}", headers: { authorization: "Bearer mine" } }));
  out.sync.push(read + "/" + write);
}
// Each credential's own ceiling, whichever URL it came through.
out.denied.payPost = (await fetch(pay + "/v1/subscriptions", { method: "POST", body: "{}" })).status;
out.denied.billGet = (await fetch(bill + "/v2/usage")).status;
// One proxy's secret on the other's port opens nothing.
const crossed = new URL(pay).origin + new URL(bill).pathname + "/v2/usage";
out.denied.crossed = (await fetch(crossed, { method: "POST", body: "{}" })).status;
console.log(JSON.stringify(out));
`,
    );
    grantGroup({ payments: payments.id, billing: billing.id }, command);

    const run = await started(command, { ...both, deps: twoDeps });
    const done = await runs.waitForCredentialRun(run.id, 30_000);
    expect(done?.state).toBe("exited");
    const out = JSON.parse(
      readFileSync(done!.logPath, "utf-8").trim().split("\n").pop()!,
    );
    expect(out).toEqual({
      single: null,
      sync: ["200/200", "200/200", "200/200", "200/200", "200/200"],
      leaked: false,
      denied: { payPost: 403, billGet: 403, crossed: 404 },
    });

    const toPayments = seen.filter((c) =>
      c.url.startsWith("https://api.payments.example.test/v1/subscriptions"),
    );
    const toBilling = seen.filter(
      (c) => c.url === "https://api.billing.example.test/v2/usage",
    );
    expect(toPayments).toHaveLength(5);
    expect(toBilling).toHaveLength(5);
    expect(seen).toHaveLength(10);
    for (const call of toPayments) {
      expect(call.method).toBe("GET");
      expect(call.headers.get("authorization")).toBe(`Bearer ${PAY}`);
      expect(call.headers.get("x-api-key")).toBe("mine");
    }
    for (const call of toBilling) {
      expect(call.method).toBe("POST");
      expect(call.headers.get("x-api-key")).toBe(BILL);
      expect(call.headers.get("authorization")).toBeNull();
    }

    expect(done).toMatchObject({ calls: 10, denied: 2 });
    expect(done?.grantId).toBeUndefined();
    expect(
      done?.credentials.map(({ service, env, calls, denied }) => ({
        service,
        env,
        calls,
        denied,
      })),
    ).toEqual([
      {
        service: "payments-prod",
        env: "KEYCHAIN_PROXY_URL_PAYMENTS_PROD",
        calls: 5,
        denied: 1,
      },
      {
        service: "billing-prod",
        env: "KEYCHAIN_PROXY_URL_BILLING_PROD",
        calls: 5,
        denied: 1,
      },
    ]);

    const legOf = new Map(done!.credentials.map((c) => [c.grantId, c.service]));
    const audited = events
      .filter((e) => e.kind === "keychain_run_call")
      .map((e) => `${legOf.get(e.grant_id)} ${e.service} ${e.host}`);
    expect(new Set(audited)).toEqual(
      new Set([
        "payments-prod payments-prod api.payments.example.test",
        "billing-prod billing-prod api.billing.example.test",
      ]),
    );
    expect(audited).toHaveLength(10);
    expect(
      events
        .filter((e) => e.kind === "keychain_run_denied")
        .map((e) => `${e.service} ${e.method} ${e.path}`)
        .sort(),
    ).toEqual([
      "billing-prod GET /v2/usage",
      "payments-prod POST /v1/subscriptions",
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "keychain_run_ended",
      calls: 10,
      denied: 2,
      credentials: [
        { service: "payments-prod", calls: 5, denied: 1 },
        { service: "billing-prod", calls: 5, denied: 1 },
      ],
    });
    // Both grants started this one run and are spent.
    expect(
      kc.listGrants({ sessionId: SESSION }).map((g) => [g.status, g.runCalls]),
    ).toEqual(
      expect.arrayContaining([
        ["used", 5],
        ["used", 5],
      ]),
    );
    expect(await start(command, both)).toHaveProperty("error");
  });

  test("a run missing one owner's approval does not start", async () => {
    const { payments, billing } = credentials();
    const command = script("half.ts", `await Bun.write("half.ran", "yes");`);
    grantGroup({ payments: payments.id, billing: billing.id }, command, [
      "payments",
    ]);
    const refused = await start(command, both);
    expect("error" in refused && refused.error).toContain("billing-prod");

    // Approvals from two different requests do not add up to one run.
    grantGroup({ payments: payments.id, billing: billing.id }, command, [
      "billing",
    ]);
    expect(await start(command, both)).toHaveProperty("error");
    // Nor does an ordinary single-credential run grant for one of them.
    grantRun(billing.id, command);
    expect(await start(command, both)).toHaveProperty("error");

    // Neither credential alone starts it with a group's grant.
    expect(
      await start(command, { credential: "payments-prod" }),
    ).toHaveProperty("error");
    await Bun.sleep(100);
    expect(existsSync(join(dir, "half.ran"))).toBe(false);
    expect(kc.listGrants({ sessionId: SESSION }).every((g) => !g.runId)).toBe(
      true,
    );
  });

  test("every proxy URL is refused once the process exits", async () => {
    const { payments, billing } = credentials();
    const command = script(
      "pair.ts",
      `await Bun.write("pair.url", process.env.KEYCHAIN_PROXY_URL_PAYMENTS_PROD + "\\n" + process.env.KEYCHAIN_PROXY_URL_BILLING_PROD);`,
    );
    grantGroup({ payments: payments.id, billing: billing.id }, command);
    const run = await started(command, { ...both, deps: twoDeps });
    const [pay, bill] = (await proxyUrlFrom("pair.url", 2)).split("\n");
    await runs.waitForCredentialRun(run.id, 30_000);

    const status = (url: string, init?: RequestInit) =>
      fetch(url, init).then(
        (r) => r.status,
        () => "refused",
      );
    expect(await status(`${pay}/v1/x`)).toBe("refused");
    expect(await status(`${bill}/v2/x`, { method: "POST", body: "{}" })).toBe(
      "refused",
    );
    expect(seen).toHaveLength(0);
  });

  test("revoking either grant ends the whole run", async () => {
    const { payments, billing } = credentials();
    const command = script(
      "held.ts",
      `await Bun.write("held.url", process.env.KEYCHAIN_PROXY_URL_PAYMENTS_PROD + "\\n" + process.env.KEYCHAIN_PROXY_URL_BILLING_PROD);
await new Promise(() => {});`,
    );
    const [, billingGrant] = grantGroup(
      { payments: payments.id, billing: billing.id },
      command,
    );
    const run = await started(command, { ...both, deps: twoDeps });
    const [pay, bill] = (await proxyUrlFrom("held.url", 2)).split("\n");
    expect((await fetch(`${pay}/v1/x`)).status).toBe(200);

    expect(kc.revokeGrant(billingGrant!.id, "Bea")).toEqual({ ok: true });
    const done = await runs.waitForCredentialRun(run.id, 30_000);
    expect(done?.state).toBe("revoked");
    for (const url of [`${pay}/v1/x`, `${bill}/v2/x`])
      expect(
        await fetch(url).then(
          (r) => r.status,
          () => "refused",
        ),
      ).toBe("refused");
    expect(seen).toHaveLength(1);
  });

  test("a live run saves its call counts as it goes", async () => {
    scripts.__resetScriptRunsForTest(scriptDeps({ persistEveryMs: 20 }));
    const { payments, billing } = credentials();
    const command = script(
      "progress.ts",
      `for (let i = 0; i < 2; i++) await fetch(process.env.KEYCHAIN_PROXY_URL_PAYMENTS_PROD + "/v1/x");
await Bun.write("progress.done", "1");
await new Promise(() => {});`,
    );
    grantGroup({ payments: payments.id, billing: billing.id }, command);
    const run = await started(command, { ...both, deps: twoDeps });
    await proxyUrlFrom("progress.done");
    const registry = join(scriptRoot, "registry.json");
    const saved = () =>
      existsSync(registry)
        ? JSON.parse(readFileSync(registry, "utf-8"))
            .runs.find((r: any) => r.id === run.id)
            ?.relays.map((r: any) => r.calls)
        : [];
    for (let i = 0; i < 200 && !saved()?.includes(2); i++) await Bun.sleep(10);
    expect(saved()).toEqual([2, 0]);
    await runs.stopCredentialRun(run.id, SESSION);
    await runs.waitForCredentialRun(run.id, 30_000);
  });
});

describe("a server restart", () => {
  test("leaves the run going: its calls wait for the server and then go through, and its grant stays claimed until it ends", async () => {
    const cred = credential();
    const command = script(
      "survivor.ts",
      `const base = process.env.KEYCHAIN_PROXY_URL;
const first = (await fetch(base + "/v1/first")).status;
await Bun.write("survivor.first", "1");
while (!(await Bun.file("survivor.go").exists())) await Bun.sleep(20);
const second = (await fetch(base + "/v1/second")).status;
console.log(first + "," + second);`,
    );
    const grant = grantRun(cred.id, command);
    const run = await started(command);
    await proxyUrlFrom("survivor.first");

    // The server shuts down (saving the moving call counts, as its graceful
    // shutdown does) and comes back with no script runs in memory and the
    // keychain loaded afresh from its file.
    await scripts.flushScriptRuns();
    scripts.__simulateRestartForTest();
    runs.__resetKeychainRunsForTest();
    const restarted = join(dir, "kc-restarted.json");
    copyFileSync(STORE, restarted);
    process.env.OPENSESSION_KEYCHAIN_STORE = restarted;
    const g = globalThis as any;
    g.__keychainCredentials.clear();
    g.__keychainGrants.clear();
    g.__keychainAsks.clear();
    await kc.ensureKeychainLoaded();
    // The script's next call is made while the server is down.
    writeFileSync(join(dir, "survivor.go"), "");
    await Bun.sleep(300);

    // Boot, in the server's order, with this test's upstream.
    runs.__setKeychainRunDefaultsForTest(deps);
    runs.hookKeychainRuns();
    await scripts.startScriptRuns(scriptDeps());
    await runs.startKeychainRuns();
    expect(
      kc.listGrants({ sessionId: SESSION }).find((x) => x.id === grant.id)
        ?.status,
    ).toBe("active");
    const done = await runs.waitForCredentialRun(run.id, 30_000);
    expect(done?.state).toBe("exited");
    expect(readFileSync(done!.logPath, "utf-8").trim()).toBe("200,200");
    expect(done?.calls).toBe(2);
    // The grant settles when the run ends, with its calls, not as cut off.
    const settled = kc
      .listGrants({ sessionId: SESSION })
      .find((x) => x.id === grant.id);
    expect(settled?.status).toBe("used");
    expect(settled?.runCalls).toBe(2);
    expect(settled?.interrupted).toBeUndefined();
    process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
    rmSync(restarted, { force: true });
  });

  test("settles at boot a grant whose run is gone, as cut off", async () => {
    const cred = credential();
    const grant = grantRun(cred.id, "true");
    const claim = await kc.claimRunGrants({
      sessionId: SESSION,
      credentials: ["acme"],
      command: "true",
      runId: "sr-gone",
      deadline: Date.now() + 60_000,
    });
    expect("claims" in claim).toBe(true);
    await runs.startKeychainRuns();
    const settled = kc
      .listGrants({ sessionId: SESSION })
      .find((x) => x.id === grant.id);
    expect([settled?.status, settled?.interrupted]).toEqual(["used", true]);
  });
});

describe("a single-credential run", () => {
  test("still gets KEYCHAIN_PROXY_URL, and the same URL under its own name", async () => {
    const cred = credential();
    const command = script(
      "names.ts",
      `console.log(JSON.stringify([process.env.KEYCHAIN_PROXY_URL === process.env.KEYCHAIN_PROXY_URL_ACME, (await fetch(process.env.KEYCHAIN_PROXY_URL + "/v1/x")).status]));`,
    );
    grantRun(cred.id, command);
    const run = await started(command);
    const done = await runs.waitForCredentialRun(run.id, 30_000);
    expect(readFileSync(done!.logPath, "utf-8").trim()).toBe("[true,200]");
    expect(done).toMatchObject({
      grantId: run.grantId,
      service: "acme",
      host: "api.example.test",
      calls: 1,
      denied: 0,
    });
  });
});
