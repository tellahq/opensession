import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertInheritedUnixListenerDescriptor } from "../server/security/transport/unix-socket-security";
import { parseAgentHostArguments } from "./main";
import {
  decodeHostLedgerCredential,
  generationLedgerPath,
  inheritedActivationFd,
  installBoundedSignalDrain,
  readSystemdCredential,
} from "./runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "agent-host-runtime-"));
  roots.push(path);
  return path;
}

describe("detached Agent Host runtime", () => {
  test("entrypoint import is inert", async () => {
    const entry = new URL("./main.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(entry)}); console.log("inert")`], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CREDENTIALS_DIRECTORY: "", LISTEN_FDS: "" },
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("inert\n");
  });

  test("requires exact service identities and named socket activation", () => {
    expect(parseAgentHostArguments([
      "--doctor", "--generation", "7", "--expected-gateway-uid", "12345", "--expected-host-uid", "12346",
    ])).toEqual({ generation: "7", expectedGatewayUid: 12345, expectedHostUid: 12346, doctor: true });
    expect(() => parseAgentHostArguments(["--generation", "7", "--expected-gateway-uid", "12345"])).toThrow();
    expect(inheritedActivationFd({ LISTEN_PID: "42", LISTEN_FDS: "1", LISTEN_FDNAMES: "agent-host" }, 42)).toBe(3);
    expect(() => inheritedActivationFd({ LISTEN_PID: "42", LISTEN_FDS: "2", LISTEN_FDNAMES: "agent-host" }, 42)).toThrow();
  });

  test("proves an inherited descriptor is a listening AF_UNIX socket", async () => {
    const directory = await root();
    const path = join(directory, "listener.sock");
    const server = createServer();
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(path, resolveListen);
    });
    const fd = (server as unknown as { _handle: { fd: number } })._handle.fd;
    await expect(assertInheritedUnixListenerDescriptor(fd)).resolves.toBeUndefined();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  test("rejects malformed, redirected, and loose credential files", async () => {
    expect(() => decodeHostLedgerCredential({ version: 1, activeKeyId: "x", keys: [] })).toThrow();
    const directory = await root();
    const credential = join(directory, "credential");
    await writeFile(credential, "{}", { mode: 0o600 });
    await expect(readSystemdCredential("credential", directory, process.getuid!())).rejects.toThrow("mode validation");
    await chmod(credential, 0o400);
    expect(await readSystemdCredential("credential", directory, process.getuid!())).toEqual({});
    const redirected = join(directory, "redirected");
    await symlink(credential, redirected);
    await expect(readSystemdCredential("redirected", directory, process.getuid!())).rejects.toThrow();
  });

  test("isolates the ledger path to the exact generation StateDirectory", async () => {
    const parent = await root();
    const one = join(parent, "1");
    const two = join(parent, "2");
    await Promise.all([mkdir(one, { mode: 0o700 }), mkdir(two, { mode: 0o700 })]);
    expect(await generationLedgerPath("1", one)).toBe(join(one, "recovery-ledger.sqlite"));
    expect(await generationLedgerPath("2", two)).toBe(join(two, "recovery-ledger.sqlite"));
    await expect(generationLedgerPath("1", two)).rejects.toThrow();
    await chmod(one, 0o750);
    await expect(generationLedgerPath("1", one)).rejects.toThrow("mode validation");
  });

  test("SIGTERM drain is idempotent and bounded", async () => {
    let drains = 0;
    let code: number | undefined;
    const signal = installBoundedSignalDrain(async () => { drains++; }, (value) => { code = value; }, 100);
    signal();
    signal();
    await Bun.sleep(10);
    expect(drains).toBe(1);
    expect(code).toBe(0);

    let timeoutCode: number | undefined;
    installBoundedSignalDrain(() => new Promise(() => {}), (value) => { timeoutCode = value; }, 5)();
    await Bun.sleep(15);
    expect(timeoutCode).toBe(1);
  });
});
