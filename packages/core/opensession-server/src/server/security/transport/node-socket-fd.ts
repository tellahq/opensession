import { fstatSync } from "node:fs";
import type { Socket } from "node:net";

export interface AcceptedSocketDescriptor {
  readonly fd: number;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

/** The only adapter allowed to inspect Bun's private node:net handle. */
export function acceptedSocketDescriptor(socket: Socket): AcceptedSocketDescriptor {
  if (!socket || typeof socket !== "object" || socket.destroyed || socket.pending)
    throw new Error("Peer socket is not an open accepted socket");
  const candidate = socket as Socket & { _handle?: { fd?: unknown } };
  const fd = candidate._handle?.fd;
  if (!Number.isSafeInteger(fd) || (fd as number) < 0)
    throw new Error("Unsupported runtime: accepted node:net socket has no valid _handle.fd");
  let stat;
  try {
    stat = fstatSync(fd as number);
  } catch (error) {
    throw new Error("Accepted socket fd is closed or unavailable", { cause: error });
  }
  if (!stat.isSocket()) throw new Error("Accepted socket fd does not identify a socket");
  return Object.freeze({ fd: fd as number, dev: stat.dev, ino: stat.ino });
}

export function sameAcceptedSocketDescriptor(left: AcceptedSocketDescriptor, right: AcceptedSocketDescriptor): boolean {
  return left.fd === right.fd && left.dev === right.dev && left.ino === right.ino;
}
