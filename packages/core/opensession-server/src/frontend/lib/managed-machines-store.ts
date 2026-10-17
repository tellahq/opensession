/**
 * Managed machines as an external store. The first subscriber starts a
 * refresh every 15 s and the last one to leave stops it, so the poll's
 * lifetime belongs to the subscription, not to a component effect. Read it
 * with `useManagedMachines()`.
 */

import { useSyncExternalStore } from "react";
import {
  fetchManagedMachines,
  managedMachineAction,
  type ManagedMachine,
} from "./api/runners";

export type ManagedMachinesSnapshot = {
  machines: ManagedMachine[];
  /** When the snapshot was taken; relative times are computed from it. */
  at: number;
};

const REFRESH_MS = 15_000;
const EMPTY: ManagedMachinesSnapshot = { machines: [], at: 0 };

let snapshot = EMPTY;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function publish(next: ManagedMachinesSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export async function refreshManagedMachines(): Promise<void> {
  const data = await fetchManagedMachines().catch(() => undefined);
  if (data) publish({ machines: data.machines, at: Date.now() });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    void refreshManagedMachines();
    timer = setInterval(() => void refreshManagedMachines(), REFRESH_MS);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): ManagedMachinesSnapshot {
  return snapshot;
}

export function useManagedMachines(): ManagedMachinesSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Run an action and fold the returned machine into the snapshot. Throws
 * the server's error for the caller to show. */
export async function runManagedMachineAction(
  id: string,
  action: "start" | "stop",
): Promise<void> {
  const next = await managedMachineAction(id, action);
  if (next)
    publish({
      machines: snapshot.machines.map((item) =>
        item.id === next.id ? next : item,
      ),
      at: Date.now(),
    });
}
