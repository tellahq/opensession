import type {
  AgentResourceSample,
  ResourceProcess,
  ResourceRoot,
} from "../shared/agent-resources";

/** Nearest known ancestor wins. A recycled root PID never adopts a new tree. */
export class ResourceAttribution {
  private identities = new Map<string, string>();
  private previous = new Map<number, ResourceProcess>();
  private previousAt?: number;

  sample(
    at: number,
    host: AgentResourceSample["host"],
    processes: ResourceProcess[],
    roots: ResourceRoot[],
  ): AgentResourceSample {
    const byPid = new Map(processes.map((p) => [p.pid, p]));
    const liveKeys = new Set<string>();
    const owners = new Map<number, AgentResourceSample["runs"][number]>();
    for (const root of roots) {
      const key = `${root.kind}:${root.runId}:${root.pid}`;
      liveKeys.add(key);
      const process = byPid.get(root.pid);
      if (!process) continue;
      // Stale persisted roots must not claim processes born after their launch.
      if (
        root.startedAt !== undefined &&
        process.bornAt !== undefined &&
        process.bornAt > root.startedAt + 1000
      )
        continue;
      const identity = root.start ?? this.identities.get(key) ?? process.start;
      this.identities.set(key, identity);
      if (process.start !== identity) continue;
      owners.set(root.pid, {
        ...root,
        start: identity,
        cpu: 0,
        rss: 0,
        processes: 0,
      });
    }
    for (const key of this.identities.keys())
      if (!liveKeys.has(key)) this.identities.delete(key);
    const elapsed = this.previousAt === undefined ? 0 : at - this.previousAt;
    for (const process of processes) {
      let cursor = process.pid;
      const visited = new Set<number>();
      while (cursor > 0 && !visited.has(cursor)) {
        visited.add(cursor);
        const owner = owners.get(cursor);
        if (owner) {
          owner.rss += process.rss;
          owner.processes++;
          const prev = this.previous.get(process.pid);
          if (elapsed > 0 && prev?.start === process.start)
            owner.cpu +=
              (Math.max(0, process.cpuMs - prev.cpuMs) / elapsed) * 100;
          break;
        }
        cursor = byPid.get(cursor)?.ppid ?? 0;
      }
    }
    this.previous = byPid;
    this.previousAt = at;
    return {
      at,
      host,
      runs: [...owners.values()].sort((a, b) => b.cpu - a.cpu || b.rss - a.rss),
    };
  }
}

/** Independent age, count and encoded-byte limits. No disk persistence. */
export class ResourceHistory {
  private entries: Array<{ sample: AgentResourceSample; bytes: number }> = [];
  private bytes = 0;
  constructor(
    private maxAge = 120_000,
    private maxCount = 60,
    private maxBytes = 1_048_576,
  ) {}
  add(sample: AgentResourceSample): void {
    const bytes = new TextEncoder().encode(JSON.stringify(sample)).byteLength;
    this.entries.push({ sample, bytes });
    this.bytes += bytes;
    this.prune(sample.at);
  }
  values(now = Date.now()): AgentResourceSample[] {
    this.prune(now);
    return this.entries.map((e) => e.sample);
  }
  private prune(now: number): void {
    while (
      this.entries.length &&
      (this.entries[0].sample.at < now - this.maxAge ||
        this.entries.length > this.maxCount ||
        this.bytes > this.maxBytes)
    )
      this.bytes -= this.entries.shift()!.bytes;
  }
}
