import { describe, expect, test } from "bun:test";
import type { KernelActorServiceCall } from "./actor-protocol";
import { isPrioritySessionActorRequest } from "./actor-routing";

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
