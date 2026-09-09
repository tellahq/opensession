import { readFile } from "node:fs/promises";

/** An unused host Portal gets one quiet half-hour, including after gateway boot. */
export const PORTAL_IDLE_MS = 30 * 60_000;

/** Request timestamps are process-local. Rediscovery grants a fresh idle window
 * rather than killing a browser's Portal using a pre-restart timestamp. */
export class HostPortalActivity {
  private readonly ports = new Map<
    number,
    { generation: string; lastUsedAt: number }
  >();

  observe(port: number, generation: string, now: number): void {
    if (this.ports.get(port)?.generation !== generation)
      this.ports.set(port, { generation, lastUsedAt: now });
  }

  touch(port: number, now = Date.now()): void {
    const entry = this.ports.get(port);
    if (entry) entry.lastUsedAt = now;
  }

  idle(port: number, generation: string, now: number): boolean {
    const entry = this.ports.get(port);
    return (
      entry?.generation === generation &&
      now - entry.lastUsedAt >= PORTAL_IDLE_MS
    );
  }

  retain(ports: ReadonlySet<number>): void {
    for (const port of this.ports.keys())
      if (!ports.has(port)) this.ports.delete(port);
  }
}

export const hostPortalActivity = new HostPortalActivity();

/** /proc reports server-side local ports too, so an established WebSocket
 * protects an open preview even when no further HTTP auth probes arrive. */
export function establishedPorts(tables: readonly string[]): Set<number> {
  const ports = new Set<number>();
  for (const table of tables) {
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== "01") continue;
      const port = Number.parseInt(fields[1]?.split(":")[1] ?? "", 16);
      if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
    }
  }
  return ports;
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

export async function activeHostPortalPorts(): Promise<Set<number> | null> {
  if (process.platform !== "linux") return null;
  try {
    const tables = await Promise.all([
      optionalFile("/proc/net/tcp"),
      optionalFile("/proc/net/tcp6"),
    ]);
    const available = tables.filter((table) => table !== undefined);
    return available.length ? establishedPorts(available) : null;
  } catch {
    // No connection evidence means no idle termination. Archive/orphan cleanup
    // does not depend on this probe and still runs.
    return null;
  }
}

export function portalCapacityProblem(input: {
  meminfo: string;
  pressure?: string;
  current?: string;
  high?: string;
}): string | null {
  const total = Number(input.meminfo.match(/^MemTotal:\s+(\d+)/m)?.[1]);
  const available = Number(input.meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
  if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0)
    return "host memory availability could not be measured";
  // Leave at least 2 GiB and 5% of RAM for the control plane and OS.
  if (available < Math.max(2 * 1024 * 1024, total * 0.05))
    return "host memory is nearly full";
  const fullStall = Number(
    input.pressure?.match(/^full\s+avg10=([\d.]+)/m)?.[1],
  );
  if (fullStall >= 10) return "the host is stalled reclaiming memory";
  const current = Number(input.current?.trim());
  const high = Number(input.high?.trim());
  // Stop admitting more previews before the shared soft limit starts reclaim.
  if (
    Number.isFinite(current) &&
    Number.isFinite(high) &&
    high > 0 &&
    current >= high * 0.9
  )
    return "the preview memory budget is nearly full";
  return null;
}

let capacityProbe: (() => Promise<void>) | null = null;

/** Unit tests spawn real Portals; the live host's memory pressure must not
 * decide whether they pass. */
export function _setHostPortalCapacityProbeForTests(
  probe: (() => Promise<void>) | null,
): void {
  capacityProbe = probe;
}

export async function assertHostPortalCapacity(): Promise<void> {
  if (capacityProbe) return capacityProbe();
  if (process.platform !== "linux") return;
  const uid = process.getuid?.() ?? 1000;
  const slice = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/opensession.slice`;
  const [meminfo, pressure, current, high] = await Promise.all([
    readFile("/proc/meminfo", "utf8"),
    optionalFile("/proc/pressure/memory"),
    optionalFile(`${slice}/memory.current`),
    optionalFile(`${slice}/memory.high`),
  ]);
  const problem = portalCapacityProblem({ meminfo, pressure, current, high });
  if (problem)
    throw new Error(
      `Cannot start Portal: ${problem}. Stop an unused Portal and try again.`,
    );
}
