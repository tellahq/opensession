import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { admitTerminalStart } from "./ws-terminal-start";
import {
  beginTerminalStart,
  isTerminalStartCurrent,
  stopAllTerminals,
  stopTerminal,
} from "./terminals";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const sockets: object[] = [];
const oldSock = process.env.SSH_AUTH_SOCK;
let spawn: ReturnType<typeof spyOn>;
function fixture() {
  process.env.SSH_AUTH_SOCK = "/synthetic-agent";
  spawn ??= spyOn(Bun, "spawn").mockImplementation(
    () =>
      ({
        kill: mock(() => {}),
        terminal: {},
        exited: new Promise(() => {}),
      }) as any,
  );
  const ws = {};
  sockets.push(ws);
  const send = mock(() => {});
  const opts = { send };
  const begin = (id = "0") => beginTerminalStart(ws, id, opts)!;
  return { ws, opts, send, begin };
}
afterEach(() => {
  for (const ws of sockets.splice(0)) stopAllTerminals(ws);
  mock.restore();
  spawn = undefined as any;
  if (oldSock === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = oldSock;
});

for (const phase of ["authorization", "lookup"] as const) {
  for (const action of ["stop", "close", "replace"] as const) {
    test(`${action} during ${phase} cannot start or disturb replacement`, async () => {
      const { ws, opts, send, begin } = fixture();
      const gate = deferred<any>();
      const entered = deferred<void>();
      const lookup = mock(async () => {
        if (phase === "lookup") {
          entered.resolve();
          return gate.promise;
        }
        return { id: "shared" };
      });
      const running = admitTerminalStart(
        ws,
        "0",
        begin(),
        opts,
        async () => {
          if (phase === "authorization") {
            entered.resolve();
            return gate.promise;
          }
          return { allowed: true };
        },
        lookup,
      );
      await entered.promise;
      if (action === "close") stopAllTerminals(ws);
      else stopTerminal(ws, "0");
      if (action === "replace") {
        await admitTerminalStart(
          ws,
          "0",
          begin(),
          opts,
          async () => ({ allowed: true }),
          async () => ({ id: "new" }),
        );
      }
      const notices = send.mock.calls.length;
      gate.resolve(
        phase === "authorization" ? { allowed: true } : { id: "old" },
      );
      await running;
      expect(spawn).toHaveBeenCalledTimes(action === "replace" ? 1 : 0);
      expect(send.mock.calls.length).toBe(notices);
      if (phase === "authorization") expect(lookup).not.toHaveBeenCalled();
    });
  }
}
for (const failure of ["missing", "unavailable", "denied"] as const) {
  test(`${failure} fails closed and frees only its reservation`, async () => {
    const { ws, opts, begin } = fixture();
    const token = begin();
    const other = begin("other");
    await admitTerminalStart(
      ws,
      "0",
      token,
      opts,
      async () => ({ allowed: failure !== "denied" }),
      async () => {
        if (failure === "unavailable") throw new Error("catalog offline");
        return undefined;
      },
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(isTerminalStartCurrent(ws, "0", token)).toBe(false);
    expect(isTerminalStartCurrent(ws, "other", other)).toBe(true);
  });
}
test("pending starts are bounded, distinct ids survive replacement, normal shared host starts", async () => {
  const { ws, opts, begin } = fixture();
  const tokens = Array.from({ length: 8 }, (_, i) => begin(String(i)));
  expect(begin("overflow")).toBeUndefined();
  const replacement = begin();
  expect(isTerminalStartCurrent(ws, "0", tokens[0]!)).toBe(false);
  expect(isTerminalStartCurrent(ws, "1", tokens[1]!)).toBe(true);
  await admitTerminalStart(
    ws,
    "0",
    replacement,
    opts,
    async () => ({ allowed: true }),
    async () => ({ id: "shared", worktreeDir: "/tmp" }),
  );
  expect(spawn).toHaveBeenCalledTimes(1);
  expect((spawn.mock.calls[0] as any)[1].cwd).toBe("/tmp");
  expect(begin("overflow")).toBeUndefined();
  stopTerminal(ws, "1");
  expect(begin("overflow")).toBeDefined();
});

test("shared sandbox connects normally; stale connection output and errors are silent", async () => {
  const { ws, opts, send, begin } = fixture();
  const connected = deferred<any>();
  const entered = deferred<void>();
  let io: any;
  mock.module("./sandbox/config", () => ({
    sandboxesEnabled: () => true,
    sandboxProviderConfigured: () => true,
  }));
  mock.module("./sandbox/adapters/daytona", () => ({
    daytonaPtySession: async (_id: string, _cwd: string, callbacks: any) => {
      io = callbacks;
      entered.resolve();
      return connected.promise;
    },
  }));
  const session = {
    id: "shared",
    sandbox: { provider: "daytona", sandboxId: "synthetic" },
  };
  const run = admitTerminalStart(
    ws,
    "0",
    begin(),
    opts,
    async () => ({ allowed: true }),
    async () => session,
  );
  await entered.promise;
  const close = mock(async () => {});
  connected.resolve({ close, write() {}, resize() {} });
  await run;
  expect(spawn).not.toHaveBeenCalled();
  expect(
    send.mock.calls.some(
      ([frame]: any) =>
        frame.type === "term_ready" && frame.target === "daytona",
    ),
  ).toBe(true);
  stopTerminal(ws, "0");
  const count = send.mock.calls.length;
  io.onData(Buffer.from("stale"));
  io.onExit(1);
  expect(send.mock.calls.length).toBe(count);
  expect(close).toHaveBeenCalledTimes(1);
});

test("stale rejected authorization does not release or notify a newer reservation", async () => {
  const { ws, opts, send, begin } = fixture();
  const gate = deferred<{ allowed: boolean }>();
  const run = admitTerminalStart(
    ws,
    "0",
    begin(),
    opts,
    () => gate.promise,
    async () => ({ id: "old" }),
  );
  const newer = begin();
  gate.reject(new Error("catalog unavailable"));
  await run;
  expect(isTerminalStartCurrent(ws, "0", newer)).toBe(true);
  expect(send).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

test("stop during sandbox connect closes late handle without stale output", async () => {
  const { ws, opts, send, begin } = fixture();
  const gate = deferred<any>();
  const entered = deferred<void>();
  let io: any;
  mock.module("./sandbox/config", () => ({
    sandboxesEnabled: () => true,
    sandboxProviderConfigured: () => true,
  }));
  mock.module("./sandbox/adapters/daytona", () => ({
    daytonaPtySession: async (_id: string, _cwd: string, callbacks: any) => {
      io = callbacks;
      entered.resolve();
      return gate.promise;
    },
  }));
  const run = admitTerminalStart(
    ws,
    "0",
    begin(),
    opts,
    async () => ({ allowed: true }),
    async () => ({
      id: "shared",
      sandbox: { provider: "daytona", sandboxId: "synthetic" },
    }),
  );
  await entered.promise;
  stopTerminal(ws, "0");
  io.onData(Buffer.from("stale"));
  const close = mock(async () => {});
  gate.resolve({ close });
  await run;
  expect(close).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
