/**
 * Registry of agent runs living in detached run-host processes (see
 * src/runner-host/host.ts). The opensession process registers a control handle
 * here for every host it spawned or reattached to; agent-runner's busy/steer/
 * interrupt/cancel helpers consult this alongside their own in-process maps,
 * so callers (WS handlers, session-control MCP, queues) treat hosted runs
 * exactly like in-process ones.
 *
 * Kept import-free of agent-runner/host-client (they both import this) and
 * parked on globalThis so `bun --hot` reloads keep live handles reachable.
 */

import type { ImageInput } from "./run-events";

export interface HostRunControl {
  hostId: string;
  osSessionId: string;
  /** Whether the run's backend supports mid-run steering (claude yes, codex no). */
  steerable: boolean;
  /** True while the socket to the host is up (steers need a live connection). */
  connected: () => boolean;
  /** Consume a terminal receipt written after the live socket was lost. */
  reconcileTerminal?: () => boolean;

  steer: (text: string, images?: ImageInput[], steerId?: string) => boolean;
  retractSteer: (steerId: string) => Promise<boolean>;

  interruptSteer: (text: string, images?: ImageInput[]) => boolean;
  cancel: () => boolean;
}

// Keyed by every id a caller might know: bks session id, engine session id.
const hostRuns: Map<string, HostRunControl> = ((
  globalThis as any
).__hostRuns ??= new Map());

export function registerHostRun(
  keys: Array<string | undefined>,
  ctl: HostRunControl,
): void {
  for (const k of keys) if (k) hostRuns.set(k, ctl);
}

export function addHostRunKey(
  key: string | undefined,
  ctl: HostRunControl,
): void {
  if (key) hostRuns.set(key, ctl);
}

export function unregisterHostRun(ctl: HostRunControl): void {
  for (const [k, v] of hostRuns) {
    if (v === ctl || v.hostId === ctl.hostId) hostRuns.delete(k);
  }
}

export function hostRunBusy(id: string): boolean {
  const ctl = hostRuns.get(id);
  if (!ctl) return false;
  return !ctl.reconcileTerminal?.();
}

export function hostRunCount(): number {
  return new Set(hostRuns.values()).size;
}

export function hostSteer(
  id: string,
  text: string,
  images?: ImageInput[],

  steerId?: string,
): boolean {
  const ctl = hostRuns.get(id);
  if (!ctl || ctl.reconcileTerminal?.() || !ctl.steerable || !ctl.connected())
    return false;
  return ctl.steer(text, images, steerId);
}

export async function hostRetractSteer(
  ids: Array<string | null | undefined>,
  steerId: string,
): Promise<boolean> {
  const controls = new Set(
    ids.flatMap((id) => (id && hostRuns.get(id) ? [hostRuns.get(id)!] : [])),
  );
  for (const ctl of controls) {
    if (ctl.reconcileTerminal?.()) continue;
    if (ctl.steerable && ctl.connected() && (await ctl.retractSteer(steerId)))
      return true;
  }
  return false;
}

export function hostInterruptSteer(
  id: string,
  text: string,
  images?: ImageInput[],
): boolean {
  const ctl = hostRuns.get(id);
  if (!ctl || ctl.reconcileTerminal?.() || !ctl.steerable || !ctl.connected())
    return false;
  return ctl.interruptSteer(text, images);
}

export function hostCancel(id: string): boolean {
  const ctl = hostRuns.get(id);
  if (!ctl || ctl.reconcileTerminal?.()) return false;
  return ctl.cancel();
}
