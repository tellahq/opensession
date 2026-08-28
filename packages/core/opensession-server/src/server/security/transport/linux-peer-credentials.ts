import type { Socket } from "node:net";
import { acceptedSocketDescriptor, sameAcceptedSocketDescriptor } from "./node-socket-fd";

const UCredBytes = 12;
const SockaddrStorageBytes = 128;
// Linux UAPI values. They are deliberately private to this linux-gated module.
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
const AF_UNIX = 1;
const nativeLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export interface LinuxPeerCredentials {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

export interface PeerCredentialPolicy {
  readonly uid: number;
  readonly gid?: number;
  readonly allowRoot?: boolean;
  /** Optional evidence must come from a pidfd-backed, race-free provider. */
  readonly processIdentity?: string;
}

export interface LinuxPeerCredentialBackend {
  read(fd: number): LinuxPeerCredentials;
  /** Must bind evidence to the same process through pidfd or an equivalent kernel handle. */
  readProcessIdentity?(fd: number, pid: number): string | undefined;
  close(): void;
}

export interface VerifiedPeer extends LinuxPeerCredentials {
  readonly processIdentity?: string;
}

export interface LinuxPeerCredentialVerifier {
  verify(socket: Socket, policy: PeerCredentialPolicy): VerifiedPeer;
  close(): void;
  readonly closed: boolean;
}

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

function validatePolicy(policy: PeerCredentialPolicy): void {
  if (!policy || typeof policy !== "object" || !validId(policy.uid) ||
      (policy.gid !== undefined && !validId(policy.gid)) ||
      (policy.allowRoot !== undefined && typeof policy.allowRoot !== "boolean") ||
      (policy.processIdentity !== undefined &&
        (typeof policy.processIdentity !== "string" || policy.processIdentity.length < 1 || policy.processIdentity.length > 512)))
    throw new Error("Malformed peer credential policy");
  if (policy.uid === 0 && policy.allowRoot !== true)
    throw new Error("Root peer policy requires explicit allowRoot");
}

export function decodeLinuxUcred(bytes: Uint8Array, returnedLength: number): LinuxPeerCredentials {
  if (!Number.isSafeInteger(returnedLength) || returnedLength !== UCredBytes || bytes.byteLength !== UCredBytes)
    throw new Error(`getsockopt(SO_PEERCRED) returned ${returnedLength} bytes, expected ${UCredBytes}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    pid: view.getInt32(0, nativeLittleEndian),
    uid: view.getUint32(4, nativeLittleEndian),
    gid: view.getUint32(8, nativeLittleEndian),
  };
}

function validateCredentials(value: LinuxPeerCredentials): void {
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0x7fff_ffff ||
      !validId(value.uid) || !validId(value.gid))
    throw new Error("Kernel returned malformed peer credentials");
}

export function createLinuxPeerCredentialVerifierFromBackend(
  backend: LinuxPeerCredentialBackend,
): LinuxPeerCredentialVerifier {
  if (process.platform !== "linux") throw new Error("Linux peer credentials are supported only on linux");
  let closed = false;
  return {
    get closed() { return closed; },
    verify(socket, policy) {
      if (closed) throw new Error("Peer credential verifier is closed");
      validatePolicy(policy);
      const before = acceptedSocketDescriptor(socket);
      const credentials = backend.read(before.fd);
      const after = acceptedSocketDescriptor(socket);
      if (!sameAcceptedSocketDescriptor(before, after))
        throw new Error("Peer socket identity changed during credential verification");
      validateCredentials(credentials);
      if (credentials.uid === 0 && policy.allowRoot !== true) throw new Error("Root peer rejected");
      if (credentials.uid !== policy.uid) throw new Error("Peer UID rejected");
      if (policy.gid !== undefined && credentials.gid !== policy.gid) throw new Error("Peer GID rejected");
      let processIdentity: string | undefined;
      if (policy.processIdentity !== undefined) {
        processIdentity = backend.readProcessIdentity?.(after.fd, credentials.pid);
        if (!processIdentity || processIdentity !== policy.processIdentity)
          throw new Error("Peer process identity evidence unavailable or rejected");
        if (!sameAcceptedSocketDescriptor(acceptedSocketDescriptor(socket), after))
          throw new Error("Peer socket identity changed during process identity verification");
      }
      return Object.freeze({ ...credentials, ...(processIdentity ? { processIdentity } : {}) });
    },
    close() {
      if (closed) return;
      closed = true;
      backend.close();
    },
  };
}

/** Explicitly loads libc. Importing this module never opens a dynamic library. */
export async function createLinuxPeerCredentialVerifier(
  loadFfi: () => Promise<typeof import("bun:ffi")> = () => import("bun:ffi"),
): Promise<LinuxPeerCredentialVerifier> {
  if (process.platform !== "linux") throw new Error("Linux peer credentials are supported only on linux");
  let ffi: typeof import("bun:ffi");
  try {
    ffi = await loadFfi();
  } catch (error) {
    throw new Error("Bun FFI is unavailable; peer credentials cannot be verified", { cause: error });
  }
  let library;
  try {
    library = ffi.dlopen("libc.so.6", {
      getsockopt: { args: ["int", "int", "int", "ptr", "ptr"], returns: "int" },
      getpeername: { args: ["int", "ptr", "ptr"], returns: "int" },
    } as const);
  } catch (error) {
    throw new Error("Unable to load Linux libc peer credential functions", { cause: error });
  }
  const backend: LinuxPeerCredentialBackend = {
    read(fd) {
      const address = new Uint8Array(SockaddrStorageBytes);
      const addressLength = new Uint32Array([SockaddrStorageBytes]);
      if (library.symbols.getpeername(fd, ffi.ptr(address), ffi.ptr(addressLength)) !== 0)
        throw new Error("getpeername failed for accepted socket");
      if (addressLength[0] < 2 || addressLength[0] > SockaddrStorageBytes)
        throw new Error("getpeername returned malformed address length");
      const family = new DataView(address.buffer).getUint16(0, nativeLittleEndian);
      if (family !== AF_UNIX) throw new Error("Peer socket is not Unix-domain");

      const bytes = new Uint8Array(UCredBytes);
      const length = new Uint32Array([UCredBytes]);
      if (library.symbols.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ffi.ptr(bytes), ffi.ptr(length)) !== 0)
        throw new Error("getsockopt(SO_PEERCRED) failed");
      return decodeLinuxUcred(bytes, length[0]);
    },
    close() { library.close(); },
  };
  return createLinuxPeerCredentialVerifierFromBackend(backend);
}
