/**
 * What a Sandbox keeps while it sleeps, per provider. Every provider keeps
 * the disk (files, installed tools, the checkout); none keeps memory, so
 * running processes (dev servers, Terminal shells, Desktop apps) start again
 * when it wakes. Shown in the Sandbox badge, the Portals panel and
 * Workspace → Sandboxes so nobody expects a dev server to survive a sleep.
 */
export interface SandboxSleepKeeps {
  memory: boolean;
  disk: boolean;
}

const KEEPS = new Map<string, SandboxSleepKeeps>([
  ["daytona", { memory: false, disk: true }],
  ["box", { memory: false, disk: true }],
  ["tart", { memory: false, disk: true }],
  ["usecomputer", { memory: false, disk: true }],
  ["modal", { memory: false, disk: true }],
]);

export function sandboxSleepKeeps(provider: string): SandboxSleepKeeps {
  return KEEPS.get(provider) ?? { memory: false, disk: true };
}

/** One sentence on what a sleeping Sandbox keeps. */
export function sandboxSleepSummary(provider: string): string {
  const keeps = sandboxSleepKeeps(provider);
  if (keeps.memory && keeps.disk)
    return "Keeps files and running processes while asleep.";
  if (keeps.disk)
    return "Keeps files while asleep. Running processes start again on wake.";
  return "Starts fresh after sleeping.";
}

/** "Sleeps in 12 min" for an idle deadline, or null when unknown or past. */
export function sleepsInLabel(
  sleepsAt: string | undefined,
  now = Date.now(),
): string | null {
  if (!sleepsAt) return null;
  const ms = Date.parse(sleepsAt) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 60_000) return "Sleeps in under a minute if unused";
  return `Sleeps in ${Math.ceil(ms / 60_000)} min if unused`;
}
