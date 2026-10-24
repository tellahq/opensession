/**
 * The durable part of managed-machine state: reservations, and the outcome
 * of the last start or stop. Everything else (poll results, idle evidence)
 * is rebuilt by polling after a restart.
 *
 * One small JSON file, read once asynchronously and written through an
 * ordered async queue. The gateway is the only writer.
 */

import { readFile } from "fs/promises";
import { statePath } from "../paths";
import { writeJsonAtomicAsync } from "../shared/atomic-write";

export type Reservation = {
  reason: string;
  reservedBy?: string;
  sessionId?: string;
  expiresAt: string;
};

export type MachineAction = {
  kind: "start" | "stop";
  at: string;
  by?: string;
  via: "user" | "agent" | "idle";
  /** Absent while the command runs. */
  ok?: boolean;
  error?: string;
};

export type MachineRecord = {
  reservation?: Reservation;
  lastAction?: MachineAction;
};

type State = {
  loaded?: Promise<void>;
  records: Map<string, MachineRecord>;
  writing: Promise<void>;
};
const g = globalThis as Record<string, unknown>;
const state: State = (g.__opensessionManagedMachineStore ??= {
  records: new Map(),
  writing: Promise.resolve(),
}) as State;

function path(): string {
  return statePath(".opensession-managed-machines.json");
}

export function loadMachineStore(): Promise<void> {
  state.loaded ??= (async () => {
    let text = "";
    try {
      text = await readFile(path(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!text.trim()) return;
    const parsed = JSON.parse(text) as {
      machines?: Record<string, MachineRecord>;
    };
    for (const [id, record] of Object.entries(parsed.machines ?? {}))
      if (record && typeof record === "object") state.records.set(id, record);
  })();
  return state.loaded;
}

export function machineRecord(id: string): MachineRecord {
  return state.records.get(id) ?? {};
}

/** Update one record and queue a write. Resolves once it is on disk. */
export function patchMachineRecord(
  id: string,
  patch: Partial<MachineRecord>,
): Promise<void> {
  const next: MachineRecord = { ...machineRecord(id), ...patch };
  for (const key of Object.keys(patch) as Array<keyof MachineRecord>)
    if (patch[key] === undefined) delete next[key];
  state.records.set(id, next);
  state.writing = state.writing
    .catch(() => {})
    .then(() =>
      writeJsonAtomicAsync(path(), {
        machines: Object.fromEntries(state.records),
      }),
    );
  return state.writing;
}

export function resetMachineStoreForTests(): void {
  state.loaded = undefined;
  state.records.clear();
  state.writing = Promise.resolve();
}
