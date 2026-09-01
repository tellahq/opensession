import { describe, expect, test } from "bun:test";
import {
  classifyRuntimeComponents,
  classifyRuntimeImpact,
  releaseRuntimePaths,
} from "./release-impact";

const gatewayPath =
  "packages/core/opensession-server/src/server/routes/system.ts";
const sharedPath =
  "packages/core/opensession-server/src/server/runtime-generation.ts";

function closures() {
  return {
    gateway: new Set([gatewayPath, sharedPath]),
    supervisor: new Set<string>(),
    kernel: new Set([sharedPath]),
    executor: new Set([sharedPath]),
  };
}

describe("generated release impact", () => {
  test("uses a warm gateway handoff only for gateway-exclusive imports", () => {
    expect(classifyRuntimeImpact([gatewayPath], closures())).toBe(
      "gateway-handoff",
    );
  });

  test("restarts the stable supervisor when its own runtime changes", () => {
    const supervisor =
      "packages/core/opensession-server/src/server/gateway-supervisor.ts";
    const graph = closures();
    graph.supervisor.add(supervisor);
    expect(classifyRuntimeImpact([supervisor], graph)).toBe(
      "supervisor-restart",
    );
    const proxy =
      "packages/core/opensession-server/src/server/gateway-tcp-proxy.ts";
    graph.supervisor.add(proxy);
    expect(classifyRuntimeImpact([proxy], graph)).toBe("supervisor-restart");
    expect(classifyRuntimeImpact([supervisor, sharedPath], graph)).toBe(
      "coordinated-supervisor-restart",
    );
  });

  test("coordinates shared, protocol, dependency, and unknown runtime changes", () => {
    for (const path of [
      sharedPath,
      "packages/core/protocol/src/session.ts",
      "bun.lock",
      "unknown.ts",
    ]) {
      expect(classifyRuntimeImpact([path], closures())).toBe("coordinated");
    }
  });

  test("deployment support and tests never restart protocol peers", () => {
    expect(
      releaseRuntimePaths([
        "docs/gateway-handoffs.md",
        "scripts/release-impact.ts",
        "scripts/release-impact.test.ts",
        "packages/core/opensession-server/src/frontend/App.tsx",
      ]),
    ).toEqual([]);
  });

  test("identifies peers independently so unchanged services stay running", () => {
    const kernelOnly =
      "packages/core/opensession-server/src/session-kernel-only.ts";
    const executorOnly =
      "packages/core/opensession-server/src/executor-only.ts";
    const graph = closures();
    graph.kernel.add(kernelOnly);
    graph.executor.add(executorOnly);
    expect(classifyRuntimeComponents([kernelOnly], graph)).toEqual({
      gateway: true,
      supervisor: false,
      kernel: true,
      executor: false,
    });
    expect(classifyRuntimeComponents([executorOnly], graph)).toEqual({
      gateway: true,
      supervisor: false,
      kernel: false,
      executor: true,
    });
  });
});
