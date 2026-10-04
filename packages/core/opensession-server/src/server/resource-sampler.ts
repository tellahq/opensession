/** Runs only in a dedicated child. No process arguments or environment are emitted. */
import { readFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import type { ResourceProcess } from "../shared/agent-resources";

export function parseProcessTime(value: string): number {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = clock.split(":").map(Number);
  return (
    (Number(days) * 86400 +
      (parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1])) *
    1000
  );
}

export function startResourceSampler(): void {
  let previous: { total: number; idle: number } | undefined;
  function sample() {
    const result = Bun.spawnSync(
      ["ps", "-axo", "pid=,ppid=,rss=,time=,lstart="],
      {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    if (result.exitCode !== 0) throw new Error("Process sampler unavailable");
    const processes: ResourceProcess[] = [];
    for (const line of result.stdout.toString().trim().split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      let start = match[5];
      const bornAt = Date.parse(match[5]);
      let cpuMs = parseProcessTime(match[4]);
      if (process.platform === "linux") {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const fields = stat
            .slice(stat.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/);
          start = fields[19];
          // Linux USER_HZ is 100 on supported platforms.
          cpuMs = (Number(fields[11]) + Number(fields[12])) * 10;
        } catch {
          continue;
        }
      }
      if (processes.length >= 20_000)
        throw new Error("Process sample too large");
      processes.push({
        pid,
        ppid: Number(match[2]),
        rss: Number(match[3]) * 1024,
        start,
        bornAt,
        cpuMs,
      });
    }
    const times = cpus().reduce(
      (acc, core) => ({
        total: acc.total + Object.values(core.times).reduce((a, b) => a + b, 0),
        idle: acc.idle + core.times.idle,
      }),
      { total: 0, idle: 0 },
    );
    const delta = previous ? times.total - previous.total : 0;
    const cpu =
      previous && delta > 0
        ? (1 - (times.idle - previous.idle) / delta) * 100
        : null;
    previous = times;
    console.log(
      JSON.stringify({
        at: Date.now(),
        host: {
          cpu,
          usedMemory: totalmem() - freemem(),
          totalMemory: totalmem(),
        },
        processes,
      }),
    );
  }
  // A failure exits only this child. The gateway publishes unavailable.
  sample();
  setInterval(sample, 2000);
}
if (import.meta.main) startResourceSampler();
