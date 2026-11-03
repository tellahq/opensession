import { readFile } from "node:fs/promises";

export type LinuxProcessIdentity = {
  pid: number;
  bootId: string;
  startTicks: string;
};

export async function linuxProcessStartTicks(
  pid: number,
): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return fields[19];
  } catch {
    return undefined;
  }
}

let bootId: Promise<string | undefined> | undefined;

/** The kernel boot id. It cannot change while this process runs, so it is
 * read once. */
export function linuxBootId(): Promise<string | undefined> {
  bootId ??= readFile("/proc/sys/kernel/random/boot_id", "utf8").then(
    (text) => text.trim(),
    () => undefined,
  );
  return bootId;
}

export async function processIdentity(
  pid = process.pid,
): Promise<LinuxProcessIdentity | undefined> {
  const [bootId, startTicks] = await Promise.all([
    linuxBootId(),
    linuxProcessStartTicks(pid),
  ]);
  return bootId && startTicks ? { pid, bootId, startTicks } : undefined;
}

export async function sameProcess(
  identity: Partial<LinuxProcessIdentity>,
): Promise<boolean | undefined> {
  if (!identity.pid || !identity.bootId || !identity.startTicks)
    return undefined;
  const current = await processIdentity(identity.pid);
  return current
    ? current.bootId === identity.bootId &&
        current.startTicks === identity.startTicks
    : undefined;
}
