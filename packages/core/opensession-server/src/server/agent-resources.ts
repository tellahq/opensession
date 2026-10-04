import { fileURLToPath } from "node:url";
import type {
  AgentResourceEvent,
  AgentResourceSample,
  ResourceProcess,
  ResourceRoot,
} from "../shared/agent-resources";
import { isCompiledBinary } from "../runner-host/exe";
import { ResourceAttribution, ResourceHistory } from "./resource-attribution";
import { hostResourceRoots } from "./host-registry";
import { scriptResourceRoots } from "./script-runs";
import { terminalResourceRoots } from "./terminals";
import { portalResourceRoots } from "./portal-supervisor";

interface Sampler {
  stop(): void;
}
type Listen = (event: AgentResourceEvent) => void;
type RawSample = {
  at: number;
  host: AgentResourceSample["host"];
  processes: ResourceProcess[];
};

/** No import-time effects. First watcher starts a child; the last stops it. */
export class AgentResources {
  private listeners = new Set<Listen>();
  private sampler?: Sampler;
  private generation = 0;
  private attribution = new ResourceAttribution();
  readonly history = new ResourceHistory();
  constructor(
    private roots: () => Promise<ResourceRoot[]>,
    private launch: (
      sample: (value: RawSample) => Promise<void>,
      failed: () => void,
    ) => Sampler = launchSampler,
  ) {}
  subscribe(listener: Listen): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      const generation = ++this.generation;
      this.attribution = new ResourceAttribution();
      try {
        this.sampler = this.launch(
          async (value) => {
            const roots = await this.roots();
            if (generation !== this.generation || !this.listeners.size) return;
            const sample = this.attribution.sample(
              value.at,
              value.host,
              value.processes,
              roots,
            );
            this.history.add(sample);
            this.emit({ status: "ready", sample });
          },
          () => {
            if (generation === this.generation)
              this.emit({ status: "unavailable" });
          },
        );
      } catch {
        listener({ status: "unavailable" });
      }
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        ++this.generation;
        this.sampler?.stop();
        this.sampler = undefined;
      }
    };
  }
  private emit(event: AgentResourceEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

function launchSampler(
  sample: (value: RawSample) => Promise<void>,
  failed: () => void,
): Sampler {
  const argv = isCompiledBinary()
    ? [process.execPath, "resource-sampler"]
    : [
        process.execPath,
        "--smol",
        fileURLToPath(new URL("./resource-sampler.ts", import.meta.url)),
      ];
  const child = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  let stopped = false;
  void (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 4_194_304) throw new Error("Sample too large");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const raw = JSON.parse(line) as RawSample;
          if (
            !Number.isFinite(raw.at) ||
            !Array.isArray(raw.processes) ||
            raw.processes.length > 20_000
          )
            throw new Error("Invalid sample");
          await sample(raw);
        }
      }
    } catch {
      child.kill();
    } finally {
      reader.releaseLock();
      if (!stopped) failed();
    }
  })();
  return {
    stop() {
      stopped = true;
      child.kill();
    },
  };
}

export const agentResources = new AgentResources(async () => [
  ...(await hostResourceRoots()),
  ...(await scriptResourceRoots()),
  ...portalResourceRoots(),
  ...terminalResourceRoots(),
]);
