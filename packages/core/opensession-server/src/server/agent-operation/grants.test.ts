import { describe, expect, test } from "bun:test";
import { encodeExecutorGrant } from "@tellahq/opensession-protocol/executor";
import {
  AgentGatewayGrantCapacityError,
  AgentGatewayGrantClockError,
  AgentGatewayGrantEntropyError,
  AgentGatewayGrantPolicyError,
  AgentGatewayGrantRegistry,
  encodeAgentGatewayPolicyHandle,
  type AgentGatewayGrantBinding,
  type AgentGatewayGrantExpectation,
} from "./grants";

const digest = (char: string) =>
  `sha256:${char.repeat(64)}` as `sha256:${string}`;
const entropy = (char: string) => char.repeat(43);

function binding(
  over: Partial<AgentGatewayGrantBinding> = {},
): AgentGatewayGrantBinding {
  return {
    operationId: "operation-1",
    kind: "model",
    fence: {
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
      generation: 3,
    },
    planHash: digest("a"),
    authorityHash: digest("b"),
    supervisorEpoch: 7,
    hostId: "host-1",
    hostGeneration: 2,
    hostIncarnation: "incarnation-1",
    descriptorDigest: digest("c"),
    payloadDigest: digest("d"),
    transcriptAnchor: {
      throughChangeSeq: 11,
      entryIds: ["input-1"],
      digest: digest("e"),
    },
    adapterId: "model-adapter",
    adapterVersion: "v1",
    deadlineMs: 10_500,
    authorityExpiresAtMs: 11_000,
    policyHandle: encodeAgentGatewayPolicyHandle("policy_handle_0001"),
    ...over,
  };
}

function expectation(
  value: AgentGatewayGrantBinding,
): AgentGatewayGrantExpectation {
  const {
    policyHandle: _policyHandle,
    deadlineMs: _deadlineMs,
    authorityExpiresAtMs: _authorityExpiresAtMs,
    ...expected
  } = value;
  return expected;
}

describe("Agent gateway dispatch grant registry", () => {
  test("authorizes repeat dispatch and query use only for the exact binding", () => {
    let now = 10_000;
    const registry = new AgentGatewayGrantRegistry({
      now: () => now,
      entropy: () => entropy("A"),
    });
    const exact = binding();
    const grant = registry.issue(exact);
    const first = registry.authorize(grant, expectation(exact));
    expect(first).toMatchObject({ authorized: true });
    if (!first.authorized) throw new Error("expected authorization");
    expect(first.evidence).toMatchObject({
      ...exact,
      issuedAtMs: 10_000,
    });
    expect(first.evidence.grantHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(first.evidence)).not.toContain(grant);
    expect(registry.evidence()[0]).not.toHaveProperty("policyHandle");
    expect(JSON.stringify(registry.evidence())).not.toContain(
      exact.policyHandle,
    );
    expect(Object.isFrozen(first.evidence)).toBe(true);
    expect(Object.isFrozen(first.evidence.fence)).toBe(true);
    expect(Object.isFrozen(first.evidence.transcriptAnchor)).toBe(true);
    expect(Object.isFrozen(first.evidence.transcriptAnchor.entryIds)).toBe(
      true,
    );
    now = 10_499;
    expect(registry.authorize(grant, expectation(exact))).toMatchObject({
      authorized: true,
    });
  });

  test("rejects every exact identity crossover without revoking the grant", () => {
    const registry = new AgentGatewayGrantRegistry({
      now: () => 10_000,
      entropy: () => entropy("B"),
    });
    const exact = binding();
    const grant = registry.issue(exact);
    const expected = expectation(exact);
    const mismatches: AgentGatewayGrantExpectation[] = [
      { ...expected, operationId: "operation-2" },
      { ...expected, kind: "mcp", toolUseEntryId: "tool-use-1" },
      { ...expected, fence: { ...expected.fence, sessionId: "session-2" } },
      { ...expected, fence: { ...expected.fence, runId: "run-2" } },
      { ...expected, fence: { ...expected.fence, turnId: "turn-2" } },
      { ...expected, fence: { ...expected.fence, generation: 4 } },
      { ...expected, planHash: digest("f") },
      { ...expected, authorityHash: digest("f") },
      { ...expected, supervisorEpoch: 8 },
      { ...expected, hostId: "host-2" },
      { ...expected, hostGeneration: 3 },
      { ...expected, hostIncarnation: "incarnation-2" },
      { ...expected, descriptorDigest: digest("f") },
      { ...expected, payloadDigest: digest("f") },
      {
        ...expected,
        transcriptAnchor: {
          ...expected.transcriptAnchor,
          throughChangeSeq: 12,
        },
      },
      {
        ...expected,
        transcriptAnchor: {
          ...expected.transcriptAnchor,
          entryIds: ["input-2"],
        },
      },
      { ...expected, adapterId: "other-adapter" },
      { ...expected, adapterVersion: "v2" },
    ];
    for (const mismatch of mismatches)
      expect(registry.authorize(grant, mismatch)).toEqual({
        authorized: false,
        reason: "identity_mismatch",
      });
    expect(registry.authorize(grant, expected)).toMatchObject({
      authorized: true,
    });
  });

  test("accepts the canonical generation-zero fence boundary", () => {
    const registry = new AgentGatewayGrantRegistry({
      now: () => 10_000,
      entropy: () => entropy("0"),
    });
    const exact = binding({ fence: { ...binding().fence, generation: 0 } });
    const grant = registry.issue(exact);
    expect(registry.authorize(grant, expectation(exact))).toMatchObject({
      authorized: true,
    });
  });

  test("binds MCP tool-use identity and rejects runtime-domain crossover", () => {
    const registry = new AgentGatewayGrantRegistry({
      now: () => 10_000,
      entropy: () => entropy("C"),
    });
    const exact = binding({ kind: "mcp", toolUseEntryId: "tool-entry-1" });
    const grant = registry.issue(exact);
    expect(registry.authorize(grant, expectation(exact))).toMatchObject({
      authorized: true,
    });
    expect(
      registry.authorize(grant, {
        ...expectation(exact),
        toolUseEntryId: "tool-entry-2",
      }),
    ).toEqual({ authorized: false, reason: "identity_mismatch" });
    expect(
      registry.authorize(encodeExecutorGrant(entropy("X")), expectation(exact)),
    ).toEqual({ authorized: false, reason: "invalid_grant" });
  });

  test("expires at the exact deadline and prunes capacity without a timer", () => {
    let now = 10_000;
    let next = 0;
    const registry = new AgentGatewayGrantRegistry({
      now: () => now,
      capacity: 1,
      entropy: () => entropy(next++ === 0 ? "D" : "E"),
    });
    const firstBinding = binding();
    const first = registry.issue(firstBinding);
    expect(() =>
      registry.issue(binding({ operationId: "operation-2" })),
    ).toThrow(AgentGatewayGrantCapacityError);
    now = firstBinding.deadlineMs;
    expect(registry.authorize(first, expectation(firstBinding))).toEqual({
      authorized: false,
      reason: "expired",
    });
    expect(registry.size).toBe(0);
    expect(
      registry.issue(binding({ operationId: "operation-2", deadlineMs: 10_700 })),
    ).toBeString();
  });

  test("fails closed and clears grants when the clock moves backwards", () => {
    let now = 10_000;
    const registry = new AgentGatewayGrantRegistry({
      now: () => now,
      entropy: () => entropy("Z"),
    });
    registry.issue(binding());
    now--;
    expect(() => registry.evidence()).toThrow(AgentGatewayGrantClockError);
    now++;
    expect(registry.size).toBe(0);
  });

  test("rejects invalid TTL and authority expiry before allocation", () => {
    const registry = new AgentGatewayGrantRegistry({
      now: () => 10_000,
      entropy: () => entropy("F"),
      maxTtlMs: 500,
    });
    for (const invalid of [
      binding({ deadlineMs: 10_000 }),
      binding({ deadlineMs: 10_501 }),
      binding({ deadlineMs: 10_500, authorityExpiresAtMs: 10_499 }),
    ])
      expect(() => registry.issue(invalid)).toThrow(
        AgentGatewayGrantPolicyError,
      );
    expect(registry.size).toBe(0);
  });

  test("rejects accessors, Proxies, unknown keys and malformed anchors", () => {
    const registry = new AgentGatewayGrantRegistry({
      now: () => 10_000,
      entropy: () => entropy("G"),
    });
    const exact = binding();
    const accessor = { ...exact };
    Object.defineProperty(accessor, "deadlineMs", {
      enumerable: true,
      get: () => 10_500,
    });
    for (const invalid of [
      accessor,
      new Proxy(exact, {}),
      { ...exact, unknown: true },
      {
        ...exact,
        transcriptAnchor: {
          ...exact.transcriptAnchor,
          entryIds: ["input-1", "input-1"],
        },
      },
    ])
      expect(() => registry.issue(invalid as AgentGatewayGrantBinding)).toThrow(
        TypeError,
      );
    expect(registry.size).toBe(0);
  });

  test("fails closed after bounded entropy collisions", () => {
    const registry = new AgentGatewayGrantRegistry({
      now: () => 10_000,
      capacity: 2,
      entropy: () => entropy("H"),
    });
    registry.issue(binding());
    expect(() =>
      registry.issue(binding({ operationId: "operation-2" })),
    ).toThrow(AgentGatewayGrantEntropyError);
    expect(registry.size).toBe(1);
  });

  test("revokes exact grants, sessions and Host incarnations", () => {
    let next = 0;
    const values = ["I", "J", "K", "L"];
    const registry = new AgentGatewayGrantRegistry({
      now: () => 10_000,
      entropy: () => entropy(values[next++]!),
    });
    const one = binding();
    const two = binding({ operationId: "operation-2" });
    const three = binding({
      operationId: "operation-3",
      fence: { ...binding().fence, sessionId: "session-2" },
    });
    const four = binding({
      operationId: "operation-4",
      fence: { ...binding().fence, sessionId: "session-3" },
      hostIncarnation: "incarnation-2",
    });
    const oneGrant = registry.issue(one);
    registry.issue(two);
    registry.issue(three);
    registry.issue(four);
    expect(registry.revoke(oneGrant)).toBe(true);
    expect(registry.revokeSession("session-1")).toBe(1);
    expect(registry.revokeHost("host-1", "incarnation-1")).toBe(1);
    expect(registry.revokeHost("host-1")).toBe(1);
    expect(registry.size).toBe(0);
  });
});
