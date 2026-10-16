/**
 * `opensession memory`: report the running gateway's memory, or ask it to
 * write a heap snapshot (`--snapshot`). Talks to this box's own server with
 * the machine identity from the owner-only web-sessions store, the only
 * caller the server accepts for these routes when sign-in is on.
 */
import { localServerOrigin } from "./connect";
import { localAutomationToken } from "./local-auth";
import { bold, dim, fail, heading, info, ok } from "./ui";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

type StructureValue = number | Record<string, number> | { error: string };

/** One line per structure, the largest first, so growth stands out. */
export function formatStructures(
  structures: Record<string, StructureValue>,
): string[] {
  const weight = (value: StructureValue): number => {
    if (typeof value === "number") return value;
    if ("error" in value) return -1;
    const numbers = Object.values(value).filter(
      (n): n is number => typeof n === "number",
    );
    return numbers.length ? Math.max(...numbers) : 0;
  };
  return Object.entries(structures)
    .sort((a, b) => weight(b[1]) - weight(a[1]) || a[0].localeCompare(b[0]))
    .map(([name, value]) => {
      if (typeof value === "number") return `${name}  ${value}`;
      if ("error" in value) return `${name}  error: ${value.error}`;
      const parts = Object.entries(value).map(([k, v]) => `${k}=${v}`);
      return `${name}  ${parts.join(" ")}`;
    });
}

async function call(path: string, init?: RequestInit): Promise<any> {
  let token: string | undefined;
  try {
    token = localAutomationToken() || undefined;
  } catch {
    token = undefined;
  }
  const response = await fetch(`${await localServerOrigin()}${path}`, {
    ...init,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    // A snapshot of a multi-GB heap takes a while to walk and write.
    signal: AbortSignal.timeout(init?.method === "POST" ? 600_000 : 30_000),
  });
  const body = await response.json().catch(() => ({}) as any);
  if (!response.ok)
    throw new Error(body?.error || `server returned ${response.status}`);
  return body;
}

export async function memory(options: {
  json: boolean;
  snapshot: boolean;
}): Promise<number> {
  try {
    if (options.snapshot) {
      info(dim("writing a heap snapshot; the server pauses while it runs"));
      const result = await call("/api/system/memory/heap-snapshot", {
        method: "POST",
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      ok(`heap snapshot written (${formatBytes(result.bytes)})`);
      info(`  ${result.path}`);
      info(dim("  open it in Chrome DevTools → Memory → Load profile"));
      return 0;
    }
    const report = await call("/api/system/memory");
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    heading("Gateway memory");
    const p = report.process ?? {};
    info(
      `rss ${bold(formatBytes(p.rss))}  heap used ${formatBytes(p.heapUsed)} of ${formatBytes(p.heapTotal)}  external ${formatBytes(p.external)}  array buffers ${formatBytes(p.arrayBuffers)}`,
    );
    const h = report.heap ?? {};
    info(
      `js heap ${formatBytes(h.heapSize)} (capacity ${formatBytes(h.heapCapacity)}, extra ${formatBytes(h.extraMemorySize)})  ${h.objectCount} objects, ${h.protectedObjectCount} protected`,
    );
    const m = report.allocator?.mimalloc;
    if (m)
      info(
        `allocator committed ${formatBytes(m.committedBytes)} (peak ${formatBytes(m.committedPeakBytes)}), ${m.threads} threads`,
      );
    info(
      dim(`pid ${report.pid}, up ${Math.round(report.uptimeSeconds / 60)} min`),
    );
    heading("Long-lived structures");
    for (const line of formatStructures(report.structures ?? {})) info(line);
    heading("Heap object types");
    for (const [type, count] of Object.entries(h.objectTypeCounts ?? {}).slice(
      0,
      15,
    ))
      info(`${type}  ${count}`);
    info(
      dim(
        "\n`opensession memory --json` for everything, --snapshot for a heap snapshot",
      ),
    );
    return 0;
  } catch (error) {
    fail("could not read gateway memory", (error as Error).message);
    info(dim("  run this on the server box as the service user"));
    return 1;
  }
}
