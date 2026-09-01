import { readFileSync } from "fs";

export type LinuxProcessIdentity = {
  pid: number;
  bootId: string;
  startTicks: string;
};

export function linuxProcessStartTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return fields[19];
  } catch {
    return undefined;
  }
}

export function linuxBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

export function processIdentity(
  pid = process.pid,
): LinuxProcessIdentity | undefined {
  const bootId = linuxBootId();
  const startTicks = linuxProcessStartTicks(pid);
  return bootId && startTicks ? { pid, bootId, startTicks } : undefined;
}

export function sameProcess(
  identity: Partial<LinuxProcessIdentity>,
): boolean | undefined {
  if (!identity.pid || !identity.bootId || !identity.startTicks)
    return undefined;
  const current = processIdentity(identity.pid);
  return current
    ? current.bootId === identity.bootId &&
        current.startTicks === identity.startTicks
    : undefined;
}
