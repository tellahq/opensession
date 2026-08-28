import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createLinuxPeerCredentialVerifier,
  createLinuxPeerCredentialVerifierFromBackend,
  decodeLinuxUcred,
  type LinuxPeerCredentialBackend,
} from "./linux-peer-credentials";
import {
  createLinuxUnixSocketPathLock,
  createVerifiedUnixSocketServer,
  doctorLinuxPeerCredentials,
  isProvenStaleSocketConnectError,
  type VerifiedAcceptedSocket,
  removeProvenStaleUnixSocket,
  validateUnixSocketParent,
  validateUnixSocketPath,
} from "./unix-socket-security";

const uid = process.getuid!();
const gid = process.getgid!();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function secureTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(homedir(), `.${prefix}`));
  await chmod(dir, 0o700);
  return dir;
}

async function listeningSocket(onConnection?: (socket: Socket) => void) {
  const dir = await secureTempDir("os-peer-");
  const path = join(dir, "peer.sock");
  const server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => server.listen(path, resolve).once("error", reject));
  cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  return { dir, path, server };
}

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path, () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextAccepted(server: ReturnType<typeof createServer>): Promise<Socket> {
  return new Promise((resolve) => server.once("connection", resolve));
}

describe("Linux peer credentials", () => {
  test("requires the exact architecture-neutral struct ucred length", () => {
    const bytes = new Uint8Array(12);
    expect(() => decodeLinuxUcred(bytes, 11)).toThrow("11 bytes");
    expect(() => decodeLinuxUcred(bytes, 13)).toThrow("13 bytes");
    expect(() => decodeLinuxUcred(new Uint8Array(11), 12)).toThrow("expected 12");
  });

  test("fails closed when Bun FFI is unavailable", async () => {
    await expect(createLinuxPeerCredentialVerifier(async () => { throw new Error("injected import failure"); })).rejects.toThrow("FFI is unavailable");
  });

  test("reads real current-process credentials and closes idempotently", async () => {
    const { path, server } = await listeningSocket();
    const acceptedPromise = nextAccepted(server);
    const client = await dial(path);
    const accepted = await acceptedPromise;
    const verifier = await createLinuxPeerCredentialVerifier();
    expect(verifier.verify(accepted, { uid, gid })).toMatchObject({ uid, gid, pid: process.pid });
    verifier.close();
    verifier.close();
    expect(() => verifier.verify(accepted, { uid })).toThrow("closed");
    client.destroy(); accepted.destroy();
  });

  test("rejects wrong IDs, implicit root, malformed policy, closed socket, and backend errors", async () => {
    const { path, server } = await listeningSocket();
    const acceptedPromise = nextAccepted(server);
    const client = await dial(path);
    const accepted = await acceptedPromise;
    const verifier = await createLinuxPeerCredentialVerifier();
    expect(() => verifier.verify({} as Socket, { uid })).toThrow("Unsupported runtime");
    expect(() => verifier.verify(accepted, { uid: uid + 1 })).toThrow("UID");
    expect(() => verifier.verify(accepted, { uid, gid: gid + 1 })).toThrow("GID");
    expect(() => verifier.verify(accepted, { uid: 0 })).toThrow("explicit allowRoot");
    expect(() => verifier.verify(accepted, { uid: -1 })).toThrow("Malformed");
    expect(() => verifier.verify(accepted, { uid, processIdentity: "/usr/bin/agent-host" })).toThrow("evidence unavailable");
    accepted.destroy();
    expect(() => verifier.verify(accepted, { uid })).toThrow("open accepted socket");
    verifier.close(); client.destroy();

    const backend: LinuxPeerCredentialBackend = { read() { throw new Error("injected getsockopt error"); }, close() {} };
    const injected = createLinuxPeerCredentialVerifierFromBackend(backend);
    const pair = await listeningSocket();
    const serverSocketPromise = nextAccepted(pair.server);
    const peer = await dial(pair.path);
    const serverSocket = await serverSocketPromise;
    expect(() => injected.verify(serverSocket, { uid })).toThrow("injected getsockopt");
    injected.close(); peer.destroy(); serverSocket.destroy();
  });

  test("gate verifies before first byte, destroys rejection, and never transfers identity", async () => {
    const dir = await secureTempDir("os-verified-peer-");
    const path = join(dir, "peer.sock");
    const verifier = await createLinuxPeerCredentialVerifier();
    const events: string[] = [];
    const identities: symbol[] = [];
    const acceptedSockets: VerifiedAcceptedSocket[] = [];
    const gate = createVerifiedUnixSocketServer(verifier, { uid }, (accepted) => {
      const { socket, socketIdentity } = accepted;
      acceptedSockets.push(accepted);
      events.push("verified"); identities.push(socketIdentity);
      socket.once("data", () => events.push("data"));
      socket.resume();
    });
    const pathLock = await createLinuxUnixSocketPathLock(path, { uid, gid, mode: 0o700 });
    const listenOptions = {
      path,
      parentPolicy: { uid, gid, mode: 0o700 },
      socketPolicy: { uid, gid, mode: 0o600 },
      pathLock,
    } as const;
    const starting = gate.listen(listenOptions);
    await expect(gate.listen(listenOptions)).rejects.toThrow("while starting");
    await starting;
    expect((await lstat(path)).mode & 0o7777).toBe(0o600);
    cleanups.push(async () => { await gate.closeAndDrain(); await rm(dir, { recursive: true, force: true }); });
    const first = connect(path); first.write("before-connect");
    await Bun.sleep(30);
    const second = connect(path); second.write("second");
    await Bun.sleep(30);
    expect(events).toEqual(["verified", "data", "verified", "data"]);
    expect(identities[0]).not.toBe(identities[1]);
    first.destroy();
    acceptedSockets[0].socket.destroy();
    await new Promise((resolve) => acceptedSockets[0].socket.once("close", resolve));
    expect(() => acceptedSockets[0].assertCurrent()).toThrow("no longer current");
    second.destroy(); await gate.closeAndDrain(); verifier.close();

    const rejectedDir = await secureTempDir("os-rejected-peer-");
    const rejectedPath = join(rejectedDir, "peer.sock");
    const rejecting = await createLinuxPeerCredentialVerifier();
    const rejectedServer = createVerifiedUnixSocketServer(rejecting, { uid: uid + 1 }, () => { throw new Error("must not run"); });
    const rejectedLock = await createLinuxUnixSocketPathLock(rejectedPath, { uid, gid, mode: 0o700 });
    await rejectedServer.listen({
      path: rejectedPath,
      parentPolicy: { uid, gid, mode: 0o700 },
      socketPolicy: { uid, gid, mode: 0o600 },
      pathLock: rejectedLock,
    });
    cleanups.push(async () => { await rejectedServer.closeAndDrain(); await rm(rejectedDir, { recursive: true, force: true }); });
    const rejected = await dial(rejectedPath);
    await new Promise<void>((resolve) => rejected.once("close", () => resolve()));
    expect(rejected.destroyed).toBe(true);
    rejecting.close();
  });

  test("rejects mocked root credentials before admission", async () => {
    const dir = await secureTempDir("os-peer-root-reject-");
    const path = join(dir, "peer.sock");
    let backendReads = 0;
    let admissions = 0;
    const verifier = createLinuxPeerCredentialVerifierFromBackend({
      read(fd) {
        expect(fd).toBeGreaterThanOrEqual(0);
        backendReads++;
        return { pid: process.pid, uid: 0, gid: 0 };
      },
      close() {},
    });
    const server = createVerifiedUnixSocketServer(verifier, { uid }, () => { admissions++; });
    const pathLock = await createLinuxUnixSocketPathLock(path, { uid, gid, mode: 0o700 });
    await server.listen({
      path,
      parentPolicy: { uid, gid, mode: 0o700 },
      socketPolicy: { uid, gid, mode: 0o600 },
      pathLock,
    });
    const client = await dial(path);
    await new Promise<void>((resolve) => client.once("close", resolve));
    expect(backendReads).toBe(1);
    expect(admissions).toBe(0);
    await server.closeAndDrain();
    verifier.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("adopts a multiprocess inherited listener without replacing its path", async () => {
    const dir = await secureTempDir("os-peer-inherited-");
    const path = join(dir, "peer.sock");
    const helper = join(import.meta.dir, "testing/inherited-unix-socket-child.ts");
    const orchestratorSource = `
import os, socket, subprocess, sys
path, bun, helper, uid = sys.argv[1:]
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(path)
os.chmod(path, 0o600)
sock.listen(16)
env = dict(os.environ, TEST_INHERITED_FD=str(sock.fileno()), TEST_EXPECTED_UID=uid)
child = subprocess.Popen([bun, helper], pass_fds=(sock.fileno(),), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
sock.close()
line = child.stdout.readline()
if line:
    print(line, end="", flush=True)
else:
    print(child.stderr.read(), file=sys.stderr)
sys.stdin.buffer.read()
child.terminate()
child.wait(timeout=10)
`;
    const orchestrator = Bun.spawn(["python3", "-c", orchestratorSource, path, process.execPath, helper, String(uid)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const ready = await orchestrator.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    const before = await lstat(path);
    const client = await dial(path);
    const response = await new Promise<string>((resolve, reject) => {
      let value = "";
      client.on("data", (chunk) => { value += chunk.toString(); });
      client.once("end", () => resolve(value));
      client.once("error", reject);
    });
    expect(response).toBe(`verified:${uid}`);
    const whileListening = await lstat(path);
    expect([whileListening.dev, whileListening.ino, whileListening.mode & 0o7777]).toEqual([before.dev, before.ino, 0o600]);
    orchestrator.stdin.end();
    expect(await orchestrator.exited).toBe(0);
    const after = await lstat(path);
    expect([after.dev, after.ino, after.mode & 0o7777]).toEqual([before.dev, before.ino, 0o600]);
    await rm(dir, { recursive: true, force: true });
  });

  test("can require inherited-FD-only composition and rejects root policy or malformed descriptors", async () => {
    const verifier = createLinuxPeerCredentialVerifierFromBackend({
      read() { return { pid: process.pid, uid, gid }; },
      close() {},
    });
    const inheritedOnly = createVerifiedUnixSocketServer(
      verifier,
      { uid },
      () => {},
      undefined,
      { listenerMode: "inherited-fd-only" },
    );
    await expect(inheritedOnly.listen({
      path: "/must-not-bind.sock",
      parentPolicy: { uid, gid, mode: 0o700 },
      socketPolicy: { uid, gid, mode: 0o600 },
      pathLock: undefined as never,
    })).rejects.toThrow("requires an inherited listener");
    await inheritedOnly.closeAndDrain();

    const malformedDescriptor = createVerifiedUnixSocketServer(verifier, { uid }, () => {});
    await expect(malformedDescriptor.listen({ inheritedFd: 2 })).rejects.toThrow("Malformed inherited");
    await malformedDescriptor.closeAndDrain();

    const tcp = createServer();
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const tcpFd = (tcp as unknown as { _handle: { fd: number } })._handle.fd;
    const wrongDomain = createVerifiedUnixSocketServer(verifier, { uid }, () => {});
    await expect(wrongDomain.listen({ inheritedFd: tcpFd })).rejects.toThrow("not Unix-domain");
    await wrongDomain.closeAndDrain();
    await new Promise<void>((resolve) => tcp.close(() => resolve()));

    const rootPolicy = createVerifiedUnixSocketServer(verifier, { uid: 0, allowRoot: true }, () => {});
    await expect(rootPolicy.listen({ inheritedFd: 3 })).rejects.toThrow("non-root");
    await rootPolicy.closeAndDrain();
    verifier.close();
  });

  test("drains physical sockets even when an accepted handler never settles", async () => {
    const dir = await secureTempDir("os-peer-drain-");
    const path = join(dir, "peer.sock");
    const verifier = await createLinuxPeerCredentialVerifier();
    const server = createVerifiedUnixSocketServer(verifier, { uid }, () => new Promise<void>(() => {}));
    const pathLock = await createLinuxUnixSocketPathLock(path, { uid, gid, mode: 0o700 });
    await server.listen({
      path,
      parentPolicy: { uid, gid, mode: 0o700 },
      socketPolicy: { uid, gid, mode: 0o600 },
      pathLock,
    });
    const client = await dial(path);
    await server.closeAndDrain(20);
    expect(pathLock.closed).toBe(true);
    client.destroy(); verifier.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("rejects a real TCP socket before SO_PEERCRED authorization", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");
    const acceptedPromise = nextAccepted(server);
    const client = await new Promise<Socket>((resolve, reject) => {
      const socket = connect(address.port, "127.0.0.1", () => resolve(socket));
      socket.once("error", reject);
    });
    const accepted = await acceptedPromise;
    const verifier = await createLinuxPeerCredentialVerifier();
    expect(() => verifier.verify(accepted, { uid })).toThrow("not Unix-domain");
    verifier.close(); client.destroy(); accepted.destroy();
  });

  test("doctor proves runtime without exposing credentials and drains verifier", async () => {
    const { path, server } = await listeningSocket();
    const acceptedPromise = nextAccepted(server);
    const client = await dial(path); const accepted = await acceptedPromise;
    const report = await doctorLinuxPeerCredentials(accepted, uid, createLinuxPeerCredentialVerifier);
    expect(report.ok).toBe(true);
    expect(Object.keys(report).sort()).toEqual(["expectedUid", "ok", "platform", "runtime"]);
    const rootReport = await doctorLinuxPeerCredentials(accepted, 0, createLinuxPeerCredentialVerifier);
    expect(rootReport).toMatchObject({ ok: false, expectedUid: 0, reason: "Root peer policy requires explicit allowRoot" });
    client.destroy(); accepted.destroy();
  });
});

describe("Unix socket paths", () => {
  test("validates exact parent/socket ownership and mode; rejects symlinks and mode mismatches", async () => {
    const { dir, path } = await listeningSocket();
    await chmod(dir, 0o700); await chmod(path, 0o600);
    await validateUnixSocketParent(dir, { uid, gid, mode: 0o700 });
    await validateUnixSocketPath(path, { uid, gid, mode: 0o600 });
    await expect(validateUnixSocketPath(path, { uid, gid, mode: 0o666 })).rejects.toThrow("mode");
    const link = `${path}.link`; await symlink(path, link);
    await expect(validateUnixSocketPath(link, { uid, gid, mode: 0o600 })).rejects.toThrow("symlink");

    const unsafeAncestor = join(dir, "unsafe");
    const protectedLeaf = join(unsafeAncestor, "leaf");
    await mkdir(unsafeAncestor, { mode: 0o700 });
    await chmod(unsafeAncestor, 0o770);
    await mkdir(protectedLeaf, { mode: 0o700 });
    await expect(validateUnixSocketParent(protectedLeaf, { uid, gid, mode: 0o700 })).rejects.toThrow("writable by an untrusted principal");
  });

  test("serializes stale removal and bind with a crash-safe path lock", async () => {
    const dir = await secureTempDir("os-peer-lock-");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "peer.sock");
    const first = await createLinuxUnixSocketPathLock(path, { uid, gid, mode: 0o700 });
    await expect(createLinuxUnixSocketPathLock(path, { uid, gid, mode: 0o700 })).rejects.toThrow("Unable to acquire");
    await first.close();
    await first.close();
    const replacement = await createLinuxUnixSocketPathLock(path, { uid, gid, mode: 0o700 });
    await replacement.close();
  });

  test("accepts only ECONNREFUSED as stale-socket proof", () => {
    expect(isProvenStaleSocketConnectError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isProvenStaleSocketConnectError({ code: "EACCES" })).toBe(false);
    expect(isProvenStaleSocketConnectError(new Error("resource pressure"))).toBe(false);
  });

  test("atomically removes only a proven stale socket inode", async () => {
    const dir = await secureTempDir("os-peer-stale-");
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "stale.sock");
    const child = Bun.spawn([process.execPath, "-e", `const {createServer}=require('node:net');const s=createServer();s.listen(${JSON.stringify(path)},()=>console.log('ready'))`], { stdout: "pipe" });
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill("SIGKILL");
    await child.exited;
    await chmod(path, 0o600);
    const before = await lstat(path);
    const staleLock = await createLinuxUnixSocketPathLock(path, { uid, gid, mode: 0o700 });
    await removeProvenStaleUnixSocket(
      path,
      { uid, gid, mode: 0o600 },
      { uid, gid, mode: 0o700 },
      staleLock,
    );
    await staleLock.close();
    await expect(lstat(path)).rejects.toThrow();
    expect(before.isSocket()).toBe(true);

    const notSocketPath = join(dir, "not-socket");
    await mkdir(notSocketPath, { mode: 0o700 });
    const notSocketLock = await createLinuxUnixSocketPathLock(notSocketPath, { uid, gid, mode: 0o700 });
    await expect(removeProvenStaleUnixSocket(
      notSocketPath,
      { uid, gid, mode: 0o700 },
      { uid, gid, mode: 0o700 },
      notSocketLock,
    )).rejects.toThrow("file type");
    await notSocketLock.close();

    const activePath = join(dir, "active.sock");
    const active = createServer();
    await new Promise<void>((resolve) => active.listen(activePath, resolve));
    await chmod(activePath, 0o600);
    const activeLock = await createLinuxUnixSocketPathLock(activePath, { uid, gid, mode: 0o700 });
    await expect(removeProvenStaleUnixSocket(
      activePath,
      { uid, gid, mode: 0o600 },
      { uid, gid, mode: 0o700 },
      activeLock,
    )).rejects.toThrow("active");
    await activeLock.close();
    await new Promise<void>((resolve) => active.close(() => resolve()));
  });
});
