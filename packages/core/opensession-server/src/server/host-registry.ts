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
 *
 * Every lookup here is a pure read of cached handle state: no filesystem,
 * database, or subprocess I/O. Busy/steer checks run on the gateway thread
 * (WS handlers, journal probes, admission counters), so terminal evidence
 * that only exists on disk is observed by the HostHandle itself
 * (`observeOfflineTerminal`, its disconnect loop) and reflected through
 * `ended()` plus unregistration.
 */

import type { ImageInput } from "./run-events";

export interface HostRunControl {
  hostId: string;
  osSessionId: string;
  /** Whether the run's backend supports mid-run steering (claude yes, codex no). */
  steerable: boolean;
  /** Targeted async metadata read, never a fleet scan. */
  resourceRoot?: () => Promise<
    import("../shared/agent-resources").ResourceRoot | null
  >;
  /** True while the socket to the host is up (steers need a live connection). */
  connected: () => boolean;
  /** Cached: true once the handle finished or was abandoned. Never does I/O. */
  ended: () => boolean;

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
  return !!ctl && !ctl.ended();
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
  if (!ctl || ctl.ended() || !ctl.steerable || !ctl.connected()) return false;
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
    if (ctl.ended()) continue;
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
  if (!ctl || ctl.ended() || !ctl.steerable || !ctl.connected()) return false;
  return ctl.interruptSteer(text, images);
}

export function hostCancel(id: string): boolean {
  const ctl = hostRuns.get(id);
  if (!ctl || ctl.ended()) return false;
  return ctl.cancel();
}

export async function hostResourceRoots(): Promise<
  import("../shared/agent-resources").ResourceRoot[]
> {
  const controls = [...new Set(hostRuns.values())].filter(
    (ctl) => !ctl.ended(),
  );
  const roots = await Promise.all(
    controls.map((ctl) => ctl.resourceRoot?.().catch(() => null)),
  );
  return roots.filter(
    (root): root is import("../shared/agent-resources").ResourceRoot => !!root,
  );
}
