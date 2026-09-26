/**
 * Wait for Boat to finish restoring a machine's disk.
 *
 * A restored Boat machine serves its home through a FUSE layer that fetches
 * each file on first read while it copies the disk in (about a minute for
 * tella-fusion). A process started meanwhile keeps FUSE-backed working
 * directories and handles for its whole life, so a dev server started
 * during the restore stays several times slower until it restarts.
 *
 * Boat's `sandbox.hydrated` webhook (boat-webhook.ts) ends the wait the
 * moment the copy is final. The machine itself is the source of truth: it
 * is asked once up front (a machine that was never lazily restored returns
 * at once) and again at a slow interval, in case a delivery is lost.
 */
import type { Sandbox } from "./provider";
import { BOX_HOME_HYDRATION_PROBE } from "./adapters/box";

type Waiter = () => void;
const waiters = new Map<string, Set<Waiter>>();

/** Boat reported the machine's restore complete. */
export function noteBoxHydrated(sandboxId: string): void {
  const pending = waiters.get(sandboxId);
  if (!pending) return;
  waiters.delete(sandboxId);
  for (const wake of pending) wake();
}

function hydratedSignal(
  sandboxId: string,
  ms: number,
): { promise: Promise<void>; cancel: () => void } {
  let wake!: Waiter;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    wake = resolve;
    timer = setTimeout(resolve, ms);
  });
  const set = waiters.get(sandboxId) ?? new Set<Waiter>();
  set.add(wake);
  waiters.set(sandboxId, set);
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
      set.delete(wake);
      if (!set.size && waiters.get(sandboxId) === set)
        waiters.delete(sandboxId);
    },
  };
}

async function restoring(sandbox: Sandbox): Promise<boolean> {
  try {
    const probe = await sandbox.exec(["bash", "-c", BOX_HOME_HYDRATION_PROBE], {
      timeoutMs: 30_000,
    });
    return probe.stdout.trim() === "hydrating";
  } catch {
    // Unknown is not a reason to hold a Portal back.
    return false;
  }
}

/**
 * Boat's restore can lose a file it fetched on demand while the disk copy
 * was running: `DIRECT-WRITE FAILED .bun/bin/bun: rename into place: No
 * such file or directory` left a machine without the bun binary its dev
 * server, Portal relay, and workload identity client all run on. Reinstall
 * it rather than start a Portal that exits at once.
 */
const REPAIR_BUN =
  'test -x "$HOME/.bun/bin/bun" && exit 0; echo missing; ' +
  "curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1; " +
  'test -x "$HOME/.bun/bin/bun" && echo repaired';

async function repairLostFiles(sandbox: Sandbox): Promise<void> {
  try {
    const result = await sandbox.exec(["bash", "-c", REPAIR_BUN], {
      timeoutMs: 300_000,
    });
    const out = result.stdout.trim();
    if (out)
      console.warn(
        `[sandbox:boat] ${sandbox.id}: bun binary lost in the disk restore; ${out.includes("repaired") ? "reinstalled" : "reinstall failed"}`,
      );
  } catch {}
}

/** Resolves once the machine's disk is fully restored, or after `maxMs`.
 * Returns how long it waited. */
export async function waitForBoxHydration(
  sandbox: Sandbox,
  options: { maxMs?: number; recheckMs?: number } = {},
): Promise<number> {
  const maxMs = options.maxMs ?? 150_000;
  const recheckMs = options.recheckMs ?? 15_000;
  const started = Date.now();
  while (await restoring(sandbox)) {
    const left = maxMs - (Date.now() - started);
    if (left <= 0) {
      console.warn(
        `[sandbox:boat] ${sandbox.id}: disk restore still running after ${Math.round(maxMs / 1000)}s; starting anyway`,
      );
      break;
    }
    const signal = hydratedSignal(sandbox.id, Math.min(recheckMs, left));
    try {
      await signal.promise;
    } finally {
      signal.cancel();
    }
  }
  await repairLostFiles(sandbox);
  const waited = Date.now() - started;
  if (waited > 1_000)
    console.log(
      `[sandbox:boat] ${sandbox.id}: waited ${Math.round(waited / 1000)}s for the disk restore`,
    );
  return waited;
}
