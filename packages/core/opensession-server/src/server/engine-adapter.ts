import { acpDriver } from "./acp-runtime";
import type { EngineCapabilities } from "@tellahq/opensession-protocol/engine";
import type { RunAgentOpts, EngineRunner } from "./agent-runner";
import type { ImageInput, StreamEvent } from "./run-events";
import {
  runPi,
  isPiSessionBusy,
  activePiRunCount,
  steerPiRun,
  retractPiSteer,
  cancelPiRun,
} from "./pi-runner";
import { PI_CAPABILITIES } from "./engine-capabilities";

/** A resume uses opts.sessionId. Adapters must reject an unsupported cursor,
 * never silently turn a resume into an empty conversation. */
export interface EngineAdapter {
  readonly kind: string;
  readonly capabilities: Readonly<EngineCapabilities>;
  run: EngineRunner;
  busy(id: string): boolean;
  activeCount(): number;
  steer(
    id: string,
    text: string,
    images?: ImageInput[],
    steerId?: string,
  ): boolean;
  retract(id: string, steerId: string): boolean;
  cancel(id: string): boolean;
}

const piAdapter: EngineAdapter = {
  kind: "pi",
  capabilities: PI_CAPABILITIES,
  run: runPi,
  busy: isPiSessionBusy,
  activeCount: activePiRunCount,
  steer: steerPiRun,
  retract: retractPiSteer,
  cancel: cancelPiRun,
};

/** Registration is explicit and has no process, socket or timer side effects. */
export class EngineRegistry {
  private readonly adapters = new Map<string, EngineAdapter>();
  register(adapter: EngineAdapter): void {
    if (this.adapters.has(adapter.kind))
      throw new Error(`Engine already registered: ${adapter.kind}`);
    this.adapters.set(adapter.kind, adapter);
  }
  get(kind: string): EngineAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`Unknown engine: ${kind}`);
    return adapter;
  }
  busy(id: string): boolean {
    return [...this.adapters.values()].some((adapter) => adapter.busy(id));
  }
  activeCount(): number {
    return [...this.adapters.values()].reduce(
      (n, adapter) => n + adapter.activeCount(),
      0,
    );
  }
  steer(
    id: string,
    text: string,
    images?: ImageInput[],
    steerId?: string,
  ): boolean {
    return [...this.adapters.values()].some(
      (adapter) =>
        adapter.capabilities.supportsSteering &&
        adapter.steer(id, text, images, steerId),
    );
  }
  retract(id: string, steerId: string): boolean {
    return [...this.adapters.values()].some(
      (adapter) =>
        adapter.capabilities.supportsSteering && adapter.retract(id, steerId),
    );
  }
  cancel(id: string): boolean {
    let cancelled = false;
    for (const adapter of this.adapters.values()) {
      if (adapter.capabilities.supportsInterrupt && adapter.cancel(id))
        cancelled = true;
    }
    return cancelled;
  }
  async *run(
    kind: string,
    opts: RunAgentOpts,
    model: string,
  ): AsyncGenerator<StreamEvent> {
    const adapter = this.get(kind);
    for await (const event of adapter.run(opts, model)) {
      yield event.type === "init"
        ? {
            ...event,
            engineKind: kind,
            engineCapabilities:
              event.engineCapabilities ?? adapter.capabilities,
          }
        : event;
    }
  }
}

export const engines = new EngineRegistry();
engines.register(piAdapter);

engines.register(acpDriver);
