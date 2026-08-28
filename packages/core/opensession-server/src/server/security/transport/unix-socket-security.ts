import { constants as fsConstants } from "node:fs";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { LinuxPeerCredentialVerifier, PeerCredentialPolicy, VerifiedPeer } from "./linux-peer-credentials";

export interface UnixPathPolicy {
  readonly uid: number;
  readonly gid?: number;
  /** Exact permission bits, for example 0o700 or 0o600. */
  readonly mode: number;
}

export interface UnixSocketPathLock {
  readonly path: string;
  readonly closed: boolean;
  close(): Promise<void>;
}

const livePathLocks = new WeakMap<object, string>();

function assertLivePathLock(lock: UnixSocketPathLock, path: string): void {
  if (!lock || lock.closed || livePathLocks.get(lock) !== path)
    throw new Error("A live exclusive lock for the exact Unix socket path is required");
}

export interface VerifiedAcceptedSocket {
  readonly socket: Socket;
  /** Throws after this exact physical socket closes or loses its binding. */
  readonly peer: VerifiedPeer;
  /** Unique per physical accepted Socket object. Audit/fencing metadata only. */
  readonly socketIdentity: symbol;
  assertCurrent(): VerifiedPeer;
}

function validPathPolicy(policy: UnixPathPolicy): void {
  if (!policy || !Number.isSafeInteger(policy.uid) || policy.uid < 0 || policy.uid > 0xffff_ffff ||
      (policy.gid !== undefined && (!Number.isSafeInteger(policy.gid) || policy.gid < 0 || policy.gid > 0xffff_ffff)) ||
      !Number.isSafeInteger(policy.mode) || policy.mode < 0 || policy.mode > 0o7777)
    throw new Error("Malformed Unix socket path policy");
}

function requireCurrentProcessOwner(policy: UnixPathPolicy): void {
  const currentUid = process.getuid?.();
  if (!Number.isSafeInteger(currentUid) || policy.uid !== currentUid)
    throw new Error("Unix socket mutation policy must name the current numeric UID");
}

function assertMetadata(stat: Awaited<ReturnType<typeof lstat>>, policy: UnixPathPolicy, kind: "directory" | "socket") {
  if (kind === "directory" ? !stat.isDirectory() : !stat.isSocket())
    throw new Error(`Unix ${kind} path has wrong file type`);
  if (stat.isSymbolicLink()) throw new Error(`Unix ${kind} path must not be a symlink`);
  if (stat.uid !== policy.uid || (policy.gid !== undefined && stat.gid !== policy.gid))
    throw new Error(`Unix ${kind} path owner rejected`);
  if ((Number(stat.mode) & 0o7777) !== policy.mode) throw new Error(`Unix ${kind} path mode rejected`);
}

async function assertProtectedPathComponents(path: string, policy: UnixPathPolicy): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Unix socket path must be absolute and normalized");
  const root = parse(path).root;
  const pieces = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const piece of pieces) {
    current = resolve(current, piece);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Unix path contains symlink component: ${current}`);
    if (stat.uid !== 0 && stat.uid !== policy.uid)
      throw new Error(`Unix path component has an untrusted owner: ${current}`);
    if ((Number(stat.mode) & 0o022) !== 0)
      throw new Error(`Unix path component is writable by an untrusted principal: ${current}`);
  }
}

export async function validateUnixSocketParent(path: string, policy: UnixPathPolicy): Promise<void> {
  validPathPolicy(policy);
  await assertProtectedPathComponents(path, policy);
  assertMetadata(await lstat(path), policy, "directory");
}

export async function validateUnixSocketPath(path: string, policy: UnixPathPolicy): Promise<void> {
  validPathPolicy(policy);
  await assertProtectedPathComponents(path, policy);
  assertMetadata(await lstat(path), policy, "socket");
}

/** Acquires a crash-safe advisory lock retained across stale removal and bind. */
export async function createLinuxUnixSocketPathLock(
  path: string,
  parentPolicy: UnixPathPolicy,
): Promise<UnixSocketPathLock> {
  if (process.platform !== "linux") throw new Error("Unix socket path locks are supported only on linux");
  validPathPolicy(parentPolicy);
  requireCurrentProcessOwner(parentPolicy);
  await validateUnixSocketParent(dirname(path), parentPolicy);
  const lockPath = `${path}.lock`;
  const handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
  let library: { symbols: { flock(fd: number, operation: number): number }; close(): void } | undefined;
  try {
    await handle.chmod(0o600);
    const [descriptor, lockStat] = await Promise.all([lstat(lockPath), handle.stat()]);
    if (!descriptor.isFile() || descriptor.isSymbolicLink() || descriptor.uid !== parentPolicy.uid ||
        (Number(descriptor.mode) & 0o7777) !== 0o600 || descriptor.dev !== lockStat.dev || descriptor.ino !== lockStat.ino)
      throw new Error("Unix socket lock file identity, owner, or mode rejected");
    const ffi = await import("bun:ffi");
    library = ffi.dlopen("libc.so.6", {
      flock: { args: ["int", "int"], returns: "int" },
    } as const);
    // Linux LOCK_EX | LOCK_NB. Values stay private to this linux-gated helper.
    if (library.symbols.flock(handle.fd, 2 | 4) !== 0)
      throw new Error("Unix socket path lock is already held");
    let closed = false;
    const lock: UnixSocketPathLock = Object.freeze({
      path,
      get closed() { return closed; },
      async close() {
        if (closed) return;
        closed = true;
        livePathLocks.delete(lock);
        try { library!.symbols.flock(handle.fd, 8); } finally {
          await handle.close();
          library!.close();
        }
      },
    });
    livePathLocks.set(lock, path);
    return lock;
  } catch (error) {
    await handle.close().catch(() => {});
    library?.close();
    throw new Error("Unable to acquire Unix socket path lock", { cause: error });
  }
}

/**
 * Removes only the exact stale socket inode inspected by this call. It first
 * proves the parent and every ancestor are protected, then uses an atomic
 * rename so a later path replacement is never unlinked.
 */
export function isProvenStaleSocketConnectError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ECONNREFUSED";
}

export async function removeProvenStaleUnixSocket(
  path: string,
  policy: UnixPathPolicy,
  parentPolicy: UnixPathPolicy,
  lock: UnixSocketPathLock,
): Promise<void> {
  assertLivePathLock(lock, path);
  validPathPolicy(policy);
  validPathPolicy(parentPolicy);
  requireCurrentProcessOwner(policy);
  requireCurrentProcessOwner(parentPolicy);
  await validateUnixSocketParent(dirname(path), parentPolicy);
  const original = await lstat(path);
  assertMetadata(original, policy, "socket");
  await new Promise<void>((resolveStale, rejectUnproven) => {
    const probe = connect(path);
    const timer = setTimeout(() => {
      probe.destroy();
      rejectUnproven(new Error("Unix socket stale probe timed out"));
    }, 250);
    timer.unref?.();
    probe.once("connect", () => {
      clearTimeout(timer);
      probe.destroy();
      rejectUnproven(new Error("Refusing to remove an active Unix socket"));
    });
    probe.once("error", (error) => {
      clearTimeout(timer);
      if (isProvenStaleSocketConnectError(error)) resolveStale();
      else rejectUnproven(new Error("Unix socket staleness was not proven", { cause: error }));
    });
  });
  const afterProbe = await lstat(path);
  if (afterProbe.dev !== original.dev || afterProbe.ino !== original.ino)
    throw new Error("Unix socket identity changed during stale probe");
  const quarantine = `${path}.stale-${process.pid}-${crypto.randomUUID()}`;
  await rename(path, quarantine);
  const moved = await lstat(quarantine);
  if (moved.dev !== original.dev || moved.ino !== original.ino || !moved.isSocket() || moved.uid !== original.uid) {
    throw new Error(`Stale Unix socket identity changed during atomic removal; retained at ${quarantine}`);
  }
  await unlink(quarantine);
}

/**
 * Installs a fail-closed accepted-socket gate. The socket is paused and verified
 * before user code can attach protocol readers or allocate session state.
 */
export interface VerifiedUnixSocketGate {
  close(): void;
  closeAndDrain(): Promise<void>;
}

function installVerifiedUnixSocketGate(
  server: Server,
  verifier: LinuxPeerCredentialVerifier,
  policy: PeerCredentialPolicy,
  accept: (accepted: VerifiedAcceptedSocket) => void | Promise<void>,
): VerifiedUnixSocketGate {
  if (server.listenerCount("connection") !== 0)
    throw new Error("Verified Unix socket gate must be the first connection listener");
  const identities = new WeakMap<Socket, symbol>();
  const sockets = new Set<Socket>();
  const closeWaiters = new Set<Promise<void>>();
  let closed = false;
  const onConnection = (socket: Socket) => {
    socket.pause();
    // Untrusted peers can race a reset with rejection. Consume ordinary socket
    // errors so an unauthorized connection cannot raise an uncaught exception.
    socket.on("error", () => {});
    if (closed) { socket.destroy(); return; }
    sockets.add(socket);
    const closeWaiter = new Promise<void>((resolve) => socket.once("close", () => {
      sockets.delete(socket);
      identities.delete(socket);
      resolve();
    }));
    closeWaiters.add(closeWaiter);
    void closeWaiter.finally(() => closeWaiters.delete(closeWaiter));
    const identity = Symbol("accepted-unix-socket");
    identities.set(socket, identity);
    let peer: VerifiedPeer;
    try {
      peer = verifier.verify(socket, policy);
      if (socket.destroyed || identities.get(socket) !== identity)
        throw new Error("Accepted socket changed before admission");
    } catch {
      socket.destroy();
      return;
    }
    const assertCurrent = () => {
      if (socket.destroyed || identities.get(socket) !== identity)
        throw new Error("Verified socket binding is no longer current");
      return peer;
    };
    const accepted = Object.freeze({
      socket,
      get peer() { return assertCurrent(); },
      socketIdentity: identity,
      assertCurrent,
    });
    let result: void | Promise<void>;
    try { result = accept(accepted); }
    catch { socket.destroy(); return; }
    void Promise.resolve(result).catch(() => { socket.destroy(); });
  };
  server.prependListener("connection", onConnection);
  const close = () => {
    if (closed) return;
    closed = true;
    server.off("connection", onConnection);
    for (const socket of sockets) socket.destroy();
  };
  return Object.freeze({
    close,
    async closeAndDrain() {
      close();
      await Promise.allSettled([...closeWaiters]);
    },
  });
}

export interface VerifiedUnixSocketOwnedPathListenOptions {
  readonly path: string;
  readonly parentPolicy: UnixPathPolicy;
  readonly socketPolicy: UnixPathPolicy;
  /** Held from stale-socket proof through bind; closed by server drain. */
  readonly pathLock: UnixSocketPathLock;
  readonly inheritedFd?: never;
}

export interface VerifiedUnixSocketInheritedListenOptions {
  /** An already-bound, already-listening Unix socket descriptor, normally from systemd. */
  readonly inheritedFd: number;
  readonly path?: never;
  readonly parentPolicy?: never;
  readonly socketPolicy?: never;
  readonly pathLock?: never;
}

export type VerifiedUnixSocketListenOptions =
  | VerifiedUnixSocketOwnedPathListenOptions
  | VerifiedUnixSocketInheritedListenOptions;

export interface VerifiedUnixSocketServerOptions {
  /** Fail closed if composition accidentally supplies the legacy owned-path mode. */
  readonly listenerMode?: "owned-path-or-inherited" | "inherited-fd-only";
}

export interface VerifiedUnixSocketServer {
  listen(options: VerifiedUnixSocketListenOptions): Promise<void>;
  closeAndDrain(timeoutMs?: number): Promise<void>;
}

function assertInheritedPeerPolicy(policy: PeerCredentialPolicy): void {
  if (!policy || !Number.isSafeInteger(policy.uid) || policy.uid <= 0 || policy.uid > 0xffff_ffff || policy.allowRoot === true)
    throw new Error("Inherited Unix listeners require an exact expected non-root peer UID");
}

/** Proves the inherited descriptor is an already-listening AF_UNIX socket. */
export async function assertInheritedUnixListenerDescriptor(fd: number): Promise<void> {
  if (process.platform !== "linux") throw new Error("Inherited Unix listeners are supported only on linux");
  const ffi = await import("bun:ffi");
  const library = ffi.dlopen("libc.so.6", {
    getsockname: { args: ["int", "ptr", "ptr"], returns: "int" },
    getsockopt: { args: ["int", "int", "int", "ptr", "ptr"], returns: "int" },
  } as const);
  try {
    const address = new Uint8Array(128);
    const addressLength = new Uint32Array([address.byteLength]);
    if (library.symbols.getsockname(fd, ffi.ptr(address), ffi.ptr(addressLength)) !== 0 || addressLength[0] < 2)
      throw new Error("Inherited listener descriptor is not a socket");
    const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    if (new DataView(address.buffer).getUint16(0, littleEndian) !== 1)
      throw new Error("Inherited listener descriptor is not Unix-domain");
    const accepting = new Int32Array(1);
    const acceptingLength = new Uint32Array([accepting.byteLength]);
    // Linux SOL_SOCKET and SO_ACCEPTCONN.
    if (library.symbols.getsockopt(fd, 1, 30, ffi.ptr(accepting), ffi.ptr(acceptingLength)) !== 0 ||
        acceptingLength[0] !== accepting.byteLength || accepting[0] !== 1)
      throw new Error("Inherited Unix descriptor is not listening");
  } finally {
    library.close();
  }
}

/** Owns the raw server so unverified sockets cannot reach another listener. */
export function createVerifiedUnixSocketServer(
  verifier: LinuxPeerCredentialVerifier,
  policy: PeerCredentialPolicy,
  accept: (accepted: VerifiedAcceptedSocket) => void | Promise<void>,
  onServerError: (error: Error) => void = () => {},
  options: VerifiedUnixSocketServerOptions = {},
): VerifiedUnixSocketServer {
  const listenerMode = options.listenerMode ?? "owned-path-or-inherited";
  if (listenerMode !== "owned-path-or-inherited" && listenerMode !== "inherited-fd-only")
    throw new Error("Malformed verified Unix socket listener mode");
  const server = createServer();
  const gate = installVerifiedUnixSocketGate(server, verifier, policy, accept);
  let state: "idle" | "starting" | "listening" | "failed" | "closed" = "idle";
  let terminalError: Error | undefined;
  let pathLock: UnixSocketPathLock | undefined;
  server.on("error", (error) => {
    terminalError ??= error;
    state = "failed";
    gate.close();
    if (server.listening) server.close();
    try { onServerError(error); } catch {}
  });
  return Object.freeze({
    async listen(options: VerifiedUnixSocketListenOptions) {
      if (state !== "idle") throw new Error(`Verified Unix socket server cannot listen while ${state}`);
      state = "starting";
      try {
        if ("inheritedFd" in options) {
          assertInheritedPeerPolicy(policy);
          const inheritedFd = options.inheritedFd;
          if (typeof inheritedFd !== "number" || !Number.isSafeInteger(inheritedFd) || inheritedFd < 3 || inheritedFd > 0x7fff_ffff)
            throw new Error("Malformed inherited Unix listener descriptor");
          await assertInheritedUnixListenerDescriptor(inheritedFd);
          await new Promise<void>((resolveListen, rejectListen) => {
            const onError = (error: Error) => rejectListen(error);
            server.once("error", onError);
            server.listen({ fd: inheritedFd }, () => {
              server.off("error", onError);
              if (terminalError || state !== "starting") {
                rejectListen(terminalError ?? new Error("Verified Unix socket server failed while starting"));
                return;
              }
              state = "listening";
              resolveListen();
            });
          });
        } else {
          if (listenerMode === "inherited-fd-only")
            throw new Error("Verified Unix socket server requires an inherited listener descriptor");
          pathLock = options.pathLock;
          assertLivePathLock(pathLock, options.path);
          validPathPolicy(options.parentPolicy);
          validPathPolicy(options.socketPolicy);
          requireCurrentProcessOwner(options.parentPolicy);
          requireCurrentProcessOwner(options.socketPolicy);
          await validateUnixSocketParent(dirname(options.path), options.parentPolicy);
          await new Promise<void>((resolveListen, rejectListen) => {
            const onError = (error: Error) => rejectListen(error);
            server.once("error", onError);
            server.listen(options.path, async () => {
              server.off("error", onError);
              try {
                await chmod(options.path, options.socketPolicy.mode);
                await validateUnixSocketPath(options.path, options.socketPolicy);
                if (terminalError || state !== "starting")
                  throw terminalError ?? new Error("Verified Unix socket server failed while starting");
                state = "listening";
                resolveListen();
              } catch (error) {
                rejectListen(error);
              }
            });
          });
        }
      } catch (error) {
        terminalError ??= error instanceof Error ? error : new Error("Unix socket startup failed");
        state = "failed";
        gate.close();
        if (server.listening) server.close();
        await pathLock?.close();
        throw terminalError;
      }
    },
    async closeAndDrain(timeoutMs = 5_000) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
        throw new Error("Invalid verified socket drain timeout");
      state = "closed";
      const stopped = server.listening
        ? new Promise<void>((resolveClose) => server.close(() => resolveClose()))
        : Promise.resolve();
      const settled = Promise.all([gate.closeAndDrain(), stopped]);
      void settled.then(() => pathLock?.close()).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          settled,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Verified Unix socket drain timed out")), timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });
}

export interface PeerCredentialDoctorReport {
  readonly ok: boolean;
  readonly platform: string;
  readonly runtime: string;
  readonly expectedUid: number;
  readonly reason?: string;
}

/** No work occurs until called; the report intentionally omits pid/gid/uid evidence. */
export async function doctorLinuxPeerCredentials(
  socket: Socket,
  expectedUid: number,
  createVerifier: () => Promise<LinuxPeerCredentialVerifier>,
): Promise<PeerCredentialDoctorReport> {
  const runtime = typeof Bun === "undefined" ? "unsupported" : `bun-${Bun.version}`;
  const base = { platform: process.platform, runtime, expectedUid };
  let verifier: LinuxPeerCredentialVerifier | undefined;
  try {
    verifier = await createVerifier();
    verifier.verify(socket, { uid: expectedUid });
    return Object.freeze({ ok: true, ...base });
  } catch (error) {
    return Object.freeze({ ok: false, ...base, reason: error instanceof Error ? error.message : "verification failed" });
  } finally {
    verifier?.close();
  }
}
