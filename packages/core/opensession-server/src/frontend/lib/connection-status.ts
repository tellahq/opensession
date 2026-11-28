import { useSyncExternalStore } from "react";

/**
 * The server connection's live status, as RestartOverlay decides it. The new
 * layout's minibar shows it in the slot above your account instead of a
 * toast, so it never lands on the composer.
 */
export type ConnectionStatus =
  | { kind: "restarting"; by: string | null }
  | { kind: "reconnecting" }
  | null;

let current: ConnectionStatus = null;
const listeners = new Set<() => void>();

export function setConnectionStatus(next: ConnectionStatus) {
  if (sameStatus(current, next)) return;
  current = next;
  for (const listener of listeners) listener();
}

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(subscribe, getStatus, getStatus);
}

/** The status as one short line: the tile's tooltip and accessible name. */
export function connectionStatusLabel(status: NonNullable<ConnectionStatus>) {
  return status.kind === "restarting"
    ? `Restarting${status.by ? ` · ${status.by}` : ""}`
    : "Connection lost · Retrying";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getStatus() {
  return current;
}

function sameStatus(a: ConnectionStatus, b: ConnectionStatus) {
  if (a === null || b === null) return a === b;
  if (a.kind === "restarting" && b.kind === "restarting") return a.by === b.by;
  return a.kind === b.kind;
}
