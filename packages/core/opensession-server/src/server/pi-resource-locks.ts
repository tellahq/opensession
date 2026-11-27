import { resolve } from "path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ResourceLockMode = "read" | "write";

export interface ResourceKey {
  key: string;
  mode: ResourceLockMode;
}

interface Waiter {
  mode: ResourceLockMode;
  resolve: () => void;
  reject: (err: Error) => void;
  cleanup?: () => void;
}

interface LockState {
  readers: number;
  writing: boolean;
  queue: Waiter[];
}

function abortError(): Error {
  const err = new Error("Aborted while waiting for resource lock");
  err.name = "AbortError";
  return err;
}

/**
 * Normalize and sort resource keys so multi-key acquisitions always acquire
 * in a single total order (deadlock-free) and merge duplicate keys (`write`
 * dominates `read`).
 */
export function normalizeResourceKeys(
  keys: readonly ResourceKey[],
): ResourceKey[] {
  const byKey = new Map<string, ResourceLockMode>();
  for (const item of keys) {
    if (!item.key) continue;
    const prev = byKey.get(item.key);
    if (!prev || item.mode === "write") {
      byKey.set(item.key, item.mode);
    }
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, mode]) => ({ key, mode }));
}

/**
 * Fair per-resource readers-writer lock manager.
 * - Concurrent readers on the same key run in parallel.
 * - Writers acquire exclusive access on their key; different keys never block.
 * - Multi-key acquisitions lock in sorted key order to prevent deadlock.
 */
export class PiResourceLockManager {
  private readonly locks = new Map<string, LockState>();

  private getState(key: string): LockState {
    let state = this.locks.get(key);
    if (!state) {
      state = { readers: 0, writing: false, queue: [] };
      this.locks.set(key, state);
    }
    return state;
  }

  private pump(key: string, state: LockState): void {
    while (state.queue.length > 0) {
      const next = state.queue[0]!;
      if (next.mode === "read") {
        if (state.writing) break;
        state.queue.shift();
        state.readers++;
        next.cleanup?.();
        next.resolve();
      } else {
        if (state.writing || state.readers > 0) break;
        state.queue.shift();
        state.writing = true;
        next.cleanup?.();
        next.resolve();
        break;
      }
    }
    if (!state.writing && state.readers === 0 && state.queue.length === 0) {
      this.locks.delete(key);
    }
  }

  private acquireOne(
    key: string,
    mode: ResourceLockMode,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());

    const state = this.getState(key);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (mode === "read") {
        state.readers = Math.max(0, state.readers - 1);
      } else {
        state.writing = false;
      }
      this.pump(key, state);
    };

    if (mode === "read" && !state.writing && state.queue.length === 0) {
      state.readers++;
      return Promise.resolve(release);
    }
    if (
      mode === "write" &&
      !state.writing &&
      state.readers === 0 &&
      state.queue.length === 0
    ) {
      state.writing = true;
      return Promise.resolve(release);
    }

    return new Promise<() => void>((res, rej) => {
      const waiter: Waiter = {
        mode,
        resolve: () => res(release),
        reject: rej,
      };
      if (signal) {
        const onAbort = () => {
          const idx = state.queue.indexOf(waiter);
          if (idx !== -1) state.queue.splice(idx, 1);
          this.pump(key, state);
          rej(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      state.queue.push(waiter);
    });
  }

  async acquire(
    rawKeys: readonly ResourceKey[],
    signal?: AbortSignal,
  ): Promise<() => void> {
    const keys = normalizeResourceKeys(rawKeys);
    if (!keys.length) return () => {};

    const releases: Array<() => void> = [];
    try {
      for (const { key, mode } of keys) {
        releases.push(await this.acquireOne(key, mode, signal));
      }
    } catch (err) {
      for (let i = releases.length - 1; i >= 0; i--) releases[i]!();
      throw err;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (let i = releases.length - 1; i >= 0; i--) releases[i]!();
    };
  }

  async withLocks<T>(
    keys: readonly ResourceKey[],
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire(keys, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function extractPatchTargetPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match =
      /^\*\*\*\s+(?:Add File|Delete File|Update File|Move to):\s+(.+?)\s*$/.exec(
        line,
      );
    if (match?.[1]) paths.push(match[1]);
  }
  return paths;
}

export function defaultToolResourceKeys(
  toolName: string,
  params: unknown,
  cwd: string,
): ResourceKey[] {
  if (!params || typeof params !== "object") return [];
  if (toolName === "read") {
    const path = (params as { path?: unknown }).path;
    return typeof path === "string" && path.trim()
      ? [{ key: resolve(cwd, path.trim()), mode: "read" }]
      : [];
  }
  if (toolName === "edit" || toolName === "write") {
    const path = (params as { path?: unknown }).path;
    return typeof path === "string" && path.trim()
      ? [{ key: resolve(cwd, path.trim()), mode: "write" }]
      : [];
  }
  if (toolName === "apply_patch") {
    const patch =
      (params as { patch?: unknown; input?: unknown }).patch ??
      (params as { input?: unknown }).input;
    if (typeof patch !== "string") return [];
    return extractPatchTargetPaths(patch).map((p) => ({
      key: resolve(cwd, p),
      mode: "write" as const,
    }));
  }
  return [];
}

/**
 * Wrap tool definitions with fair per-resource read/write locks so concurrent
 * reads and disjoint-file edits execute in parallel while conflicting accesses
 * on the same path serialize safely.
 */
export function piResourceLockTools(
  tools: readonly ToolDefinition<any, any, any>[],
  locks: PiResourceLockManager,
  cwd: string,
  getResourceKeys: (
    toolName: string,
    params: unknown,
    cwd: string,
  ) => ResourceKey[] = defaultToolResourceKeys,
): ToolDefinition<any, any, any>[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const keys = getResourceKeys(tool.name, params, cwd);
      if (!keys.length) {
        return tool.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      return locks.withLocks(
        keys,
        () => tool.execute(toolCallId, params, signal, onUpdate, ctx),
        signal,
      );
    },
  }));
}
