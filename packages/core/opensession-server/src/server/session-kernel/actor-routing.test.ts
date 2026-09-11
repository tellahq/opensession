import { describe, expect, test } from "bun:test";
import type { KernelActorServiceCall } from "./actor-protocol";
import {
  isPrioritySessionActorRequest,
  isReadReducer,
  sessionActorReducerRoute,
} from "./actor-routing";
import type { CatalogDocumentRequest } from "./catalog-document-protocol";

function websocketCommand(
  command: string,
  extraIdentity: Record<string, unknown> = {},
): KernelActorServiceCall {
  return {
    t: "call",
    rpcId: crypto.randomUUID(),
    outputBytes: 1_024,
    request: {
      t: "reduce",
      command: {
        kind: "gateway",
        commandId: crypto.randomUUID(),
        request: {
          op: "request",
          sessionId: "routing-test-session",
          requestId: crypto.randomUUID(),
          operation: "websocket_command",
          identity: { command, ...extraIdentity },
        },
      },
    },
  };
}

describe("session actor priority routing", () => {
  test("reserves capacity for every interactive run-control command", () => {
    for (const command of [
      "cancel",
      "steer",
      "interrupt_prompt",
      "steer_queued_prompt",
      "interrupt_queued_prompt",
    ]) {
      expect(isPrioritySessionActorRequest(websocketCommand(command))).toBe(
        true,
      );
    }
  });

  test("lets a steer-mode prompt opt into control priority", () => {
    expect(isPrioritySessionActorRequest(websocketCommand("prompt"))).toBe(
      false,
    );
    expect(
      isPrioritySessionActorRequest(
        websocketCommand("prompt", { priority: true }),
      ),
    ).toBe(true);
  });
});

describe("catalog document routing", () => {
  const command = (request: CatalogDocumentRequest) =>
    ({
      kind: "catalog_document",
      commandId: crypto.randomUUID(),
      request,
    }) as const;

  test("reads use the catalog read pool and never name a session", () => {
    const reads: CatalogDocumentRequest[] = [
      { op: "get", namespace: "workspace", key: "a" },
      { op: "get_many", namespace: "workspace", keys: ["a", "b"] },
      { op: "page", namespace: "workspace", afterKey: "", limit: 10 },
      { op: "import_complete", namespace: "workspace" },
    ];
    for (const request of reads) {
      expect(isReadReducer(command(request))).toBe(true);
      expect(sessionActorReducerRoute(command(request))).toEqual({
        scope: "catalog_read",
      });
    }
  });

  test("mutations serialize on the catalog slot without the global barrier", () => {
    const mutations: CatalogDocumentRequest[] = [
      {
        op: "put",
        namespace: "workspace",
        key: "a",
        expectedRev: null,
        value: "v",
        requestId: "r",
      },
      { op: "seed", namespace: "workspace", rows: [{ key: "a", value: "v" }] },
      { op: "mark_import_complete", namespace: "workspace" },
    ];
    for (const request of mutations) {
      expect(isReadReducer(command(request))).toBe(false);
      expect(sessionActorReducerRoute(command(request))).toEqual({
        scope: "central_write",
      });
    }
  });
});
