import { describe, expect, test } from "bun:test";
import {
  AgentHostGenerationSupervisor,
  type AgentHostAdmissionStorage,
  type AgentHostGenerationIdentity,
  type AgentHostGenerationManifest,
  type AgentHostSystemdController,
  type AgentHostTurnFence,
  type AgentHostTurnPinStorage,
  type AgentHostTurnReceiptVerifier,
  type PersistedAdmission,
  type PersistedTurnPin,
  type PersistedTurnPins,
} from "./generation-supervisor";

const digest = (character: string) => character.repeat(64);
const terminalReceipt = "terminal-receipt";
const deletionReceipt = "deletion-receipt";

class Clock {
  constructor(public value = 1_000) {}
  nowMs() {
    return this.value;
  }
}

class AdmissionStorage implements AgentHostAdmissionStorage {
  value: unknown = { version: 1, revision: 0, active: null };
  async read() {
    return structuredClone(this.value);
  }
  async compareAndSwap(expectedRevision: number, next: PersistedAdmission) {
    const current = this.value as PersistedAdmission;
    if (current.revision !== expectedRevision) return false;
    this.value = structuredClone(next);
    return true;
  }
}

class PinStorage implements AgentHostTurnPinStorage {
  value: unknown = { version: 1, revision: 0, pins: [] };
  failCas = false;
  throwAfterCommit = false;
  async read() {
    return structuredClone(this.value);
  }
  async compareAndSwap(expectedRevision: number, next: PersistedTurnPins) {
    const current = this.value as PersistedTurnPins;
    if (this.failCas || current.revision !== expectedRevision) return false;
    this.value = structuredClone(next);
    if (this.throwAfterCommit) {
      this.throwAfterCommit = false;
      throw new Error("simulated process crash after durable CAS");
    }
    return true;
  }
}

class ReceiptVerifier implements AgentHostTurnReceiptVerifier {
  async verifyTerminalReceipt(
    receipt: unknown,
    expectedPin: Readonly<PersistedTurnPin>,
  ): Promise<unknown | false> {
    if (receipt === "ambiguous-receipt")
      throw new Error("receipt authority unavailable");
    if (receipt === "cross-fence-receipt")
      return {
        kind: "terminal",
        receiptId: "cross-fence-receipt",
        pin: {
          ...expectedPin,
          fence: { ...expectedPin.fence, runId: "different-run" },
        },
      };
    if (receipt === "cross-generation-receipt")
      return {
        kind: "terminal",
        receiptId: "cross-generation-receipt",
        pin: {
          ...expectedPin,
          fence: {
            ...expectedPin.fence,
            generation: expectedPin.fence.generation + 1,
          },
        },
      };
    if (receipt !== terminalReceipt) return false;
    return { kind: "terminal", receiptId: terminalReceipt, pin: expectedPin };
  }

  async verifySessionDeletionReceipt(
    receipt: unknown,
    expectedSessionId: string,
    expectedPins: readonly Readonly<PersistedTurnPin>[],
  ): Promise<unknown | false> {
    if (receipt === "ambiguous-receipt")
      throw new Error("receipt authority unavailable");
    if (receipt === "cross-session-receipt")
      return {
        kind: "session-deletion",
        receiptId: "cross-session-receipt",
        sessionId: "different-session",
        pins: expectedPins,
      };
    if (receipt === "cross-generation-deletion")
      return {
        kind: "session-deletion",
        receiptId: "cross-generation-deletion",
        sessionId: expectedSessionId,
        pins: expectedPins.map((pin, index) =>
          index === 0
            ? {
                ...pin,
                fence: { ...pin.fence, generation: pin.fence.generation + 1 },
              }
            : pin,
        ),
      };
    if (receipt !== deletionReceipt) return false;
    return {
      kind: "session-deletion",
      receiptId: deletionReceipt,
      sessionId: expectedSessionId,
      pins: expectedPins,
    };
  }
}

class Controller implements AgentHostSystemdController {
  starts: AgentHostGenerationManifest[] = [];
  stops: AgentHostGenerationIdentity[] = [];
  async startGeneration(manifest: AgentHostGenerationManifest) {
    this.starts.push(manifest);
  }
  async stopGeneration(identity: AgentHostGenerationIdentity) {
    this.stops.push(identity);
  }
}

function manifest(
  generation: number,
  overrides: Partial<AgentHostGenerationManifest> = {},
): AgentHostGenerationManifest {
  return {
    hostId: "agent-host",
    generation,
    incarnation: `incarnation-${generation}`,
    releaseDigest: digest(String(generation % 10)),
    protocolDigest: digest("a"),
    keyringDigest: digest("b"),
    recoveryLedgerId: `ledger-${generation}`,
    bornAtMs: 1_000,
    deadlineMs: 10_000,
    ...overrides,
  };
}

function turn(
  turnId: string,
  overrides: Partial<AgentHostTurnFence> = {},
): AgentHostTurnFence {
  return {
    sessionId: "session-1",
    runId: "run-1",
    turnId,
    generation: 1,
    ...overrides,
  };
}

function supervisor(
  clock = new Clock(),
  admission = new AdmissionStorage(),
  pins = new PinStorage(),
  controller = new Controller(),
  verifier = new ReceiptVerifier(),
) {
  return new AgentHostGenerationSupervisor(
    clock,
    admission,
    controller,
    pins,
    verifier,
  );
}

async function ready(
  authority: AgentHostGenerationSupervisor,
  value: AgentHostGenerationManifest,
) {
  await authority.stage(value);
  authority.markEligible(value);
}

async function readyAndRecover(
  authority: AgentHostGenerationSupervisor,
  ...values: AgentHostGenerationManifest[]
) {
  for (const value of values) await ready(authority, value);
  await authority.recoverAdmission();
}

describe("AgentHostGenerationSupervisor durable turn ownership", () => {
  test("is import-inert and validates immutable generation and turn fences", async () => {
    const admission = new AdmissionStorage();
    const pins = new PinStorage();
    const controller = new Controller();
    const authority = supervisor(new Clock(), admission, pins, controller);
    expect(controller.starts).toEqual([]);
    expect(await pins.read()).toEqual({ version: 1, revision: 0, pins: [] });

    await expect(
      authority.stage(manifest(1, { releaseDigest: "bad" })),
    ).rejects.toThrow("Invalid Agent Host generation manifest");
    const blue = manifest(1);
    await readyAndRecover(authority, blue);
    await authority.promote(blue);
    await expect(
      authority.admitNewTurn({
        sessionId: "session",
        runId: "run",
        turnId: "",
        generation: 1,
      }),
    ).rejects.toThrow("Invalid Agent Host turn fence");
    await expect(
      authority.admitNewTurn(
        turn("unsafe", { generation: Number.MAX_SAFE_INTEGER + 1 }),
      ),
    ).rejects.toThrow("Invalid Agent Host turn fence");
  });

  test("restart mid-turn reconstructs blue ownership while new admissions use green", async () => {
    const admission = new AdmissionStorage();
    const pins = new PinStorage();
    const clock = new Clock();
    const blue = manifest(1);
    const green = manifest(2);
    const blueTurn = turn("turn-blue");

    const first = supervisor(clock, admission, pins);
    await readyAndRecover(first, blue, green);
    await first.promote(blue);
    expect((await first.admitNewTurn(blueTurn)).generation).toBe(1);
    await first.promote(green);

    const restarted = supervisor(clock, admission, pins);
    await readyAndRecover(restarted, blue, green);
    expect(restarted.targetForExistingTurn(blueTurn, blue).generation).toBe(1);
    expect((await restarted.admitNewTurn(turn("turn-green"))).generation).toBe(
      2,
    );
    expect(() => restarted.targetForExistingTurn(blueTurn, green)).toThrow(
      "Stale",
    );
    expect(
      (pins.value as PersistedTurnPins).pins.map((pin) => [
        pin.generationDigest,
        pin.generationEpoch,
      ]),
    ).toEqual([
      [blue.releaseDigest, 1],
      [green.releaseDigest, 2],
    ]);
  });

  test("same logical turn IDs in different run generations remain distinct", async () => {
    const admission = new AdmissionStorage();
    const pins = new PinStorage();
    const blue = manifest(1);
    const green = manifest(2);
    const firstGeneration = turn("reused", { generation: 41 });
    const nextGeneration = turn("reused", { generation: 42 });
    const authority = supervisor(new Clock(), admission, pins);
    await readyAndRecover(authority, blue, green);
    await authority.promote(blue);
    expect((await authority.admitNewTurn(firstGeneration)).generation).toBe(1);
    await authority.promote(green);
    expect((await authority.admitNewTurn(nextGeneration)).generation).toBe(2);

    expect(
      authority.targetForExistingTurn(firstGeneration, blue).generation,
    ).toBe(1);
    expect(
      authority.targetForExistingTurn(nextGeneration, green).generation,
    ).toBe(2);
    expect(() => authority.targetForExistingTurn(nextGeneration, blue)).toThrow(
      "Stale",
    );
    expect((pins.value as PersistedTurnPins).pins).toHaveLength(2);

    const restarted = supervisor(new Clock(), admission, pins);
    await readyAndRecover(restarted, blue, green);
    expect(
      restarted.targetForExistingTurn(firstGeneration, blue).generation,
    ).toBe(1);
    expect(
      restarted.targetForExistingTurn(nextGeneration, green).generation,
    ).toBe(2);
  });

  test("terminal evidence releases exactly one turn and permits retirement", async () => {
    const controller = new Controller();
    const authority = supervisor(
      new Clock(),
      new AdmissionStorage(),
      new PinStorage(),
      controller,
    );
    const blue = manifest(1);
    const green = manifest(2);
    const owned = turn("owned");
    await readyAndRecover(authority, blue, green);
    await authority.promote(blue);
    await authority.admitNewTurn(owned);
    await authority.promote(green);
    await expect(authority.retire(blue)).rejects.toThrow("owned");
    expect(await authority.releaseTurn(owned, blue, terminalReceipt)).toBe(
      true,
    );
    await authority.retire(blue);
    expect(controller.stops).toEqual([blue]);
  });

  test("forged, cross-fence, stale, and ambiguous receipts never release", async () => {
    const authority = supervisor();
    const blue = manifest(1);
    const owned = turn("receipt-fenced");
    await readyAndRecover(authority, blue);
    await authority.promote(blue);
    await authority.admitNewTurn(owned);

    const failures: readonly unknown[] = [
      {
        authenticated: true,
        durable: true,
        evidenceId: "caller-asserted",
      },
      "cross-fence-receipt",
      "cross-generation-receipt",
      "stale-receipt",
      "ambiguous-receipt",
    ];
    for (const receipt of failures) {
      await expect(
        authority.releaseTurn(owned, blue, receipt),
      ).rejects.toThrow();
      expect(authority.targetForExistingTurn(owned, blue).generation).toBe(1);
    }
  });

  test("authenticated durable session deletion releases all session pins only", async () => {
    const authority = supervisor();
    const blue = manifest(1);
    await readyAndRecover(authority, blue);
    await authority.promote(blue);
    await authority.admitNewTurn(turn("one"));
    await authority.admitNewTurn(turn("two"));
    await authority.admitNewTurn(
      turn("other", { sessionId: "session-2", runId: "run-2" }),
    );
    for (const receipt of [
      { authenticated: true, durable: true },
      "cross-session-receipt",
      "cross-generation-deletion",
      "stale-receipt",
      "ambiguous-receipt",
    ]) {
      await expect(
        authority.releaseSessionTurns("session-1", receipt),
      ).rejects.toThrow();
      expect(
        authority.targetForExistingTurn(turn("one"), blue).generation,
      ).toBe(1);
    }
    expect(
      await authority.releaseSessionTurns("session-1", deletionReceipt),
    ).toBe(2);
    expect(() => authority.targetForExistingTurn(turn("one"), blue)).toThrow(
      "Stale",
    );
    expect(
      authority.targetForExistingTurn(
        turn("other", { sessionId: "session-2", runId: "run-2" }),
        blue,
      ).generation,
    ).toBe(1);
  });

  test("terminal and deletion receipts cannot cross reused run generations", async () => {
    const authority = supervisor();
    const blue = manifest(1);
    const firstGeneration = turn("same", { generation: 7 });
    const nextGeneration = turn("same", { generation: 8 });
    await readyAndRecover(authority, blue);
    await authority.promote(blue);
    await authority.admitNewTurn(firstGeneration);
    await authority.admitNewTurn(nextGeneration);

    await expect(
      authority.releaseTurn(firstGeneration, blue, "cross-generation-receipt"),
    ).rejects.toThrow("terminal receipt verification failed");
    expect(
      authority.targetForExistingTurn(nextGeneration, blue).generation,
    ).toBe(1);
    await expect(
      authority.releaseSessionTurns("session-1", "cross-generation-deletion"),
    ).rejects.toThrow("deletion receipt verification failed");
    expect(
      authority.targetForExistingTurn(firstGeneration, blue).generation,
    ).toBe(1);
    expect(
      authority.targetForExistingTurn(nextGeneration, blue).generation,
    ).toBe(1);
  });

  test("a crash after durable pin CAS is recovered without reassignment", async () => {
    const admission = new AdmissionStorage();
    const pins = new PinStorage();
    const blue = manifest(1);
    const owned = turn("crash");
    const first = supervisor(new Clock(), admission, pins);
    await readyAndRecover(first, blue);
    await first.promote(blue);
    pins.throwAfterCommit = true;
    await expect(first.admitNewTurn(owned)).rejects.toThrow(
      "simulated process crash",
    );

    const restarted = supervisor(new Clock(), admission, pins);
    await readyAndRecover(restarted, blue);
    expect(restarted.targetForExistingTurn(owned, blue).generation).toBe(1);
    expect((await restarted.admitNewTurn(owned)).generation).toBe(1);
  });

  test("pin CAS races choose one exact generation and losers fail closed", async () => {
    const admission = new AdmissionStorage();
    const pins = new PinStorage();
    const blue = manifest(1);
    const left = supervisor(new Clock(), admission, pins);
    const right = supervisor(new Clock(), admission, pins);
    await readyAndRecover(left, blue);
    await readyAndRecover(right, blue);
    await left.promote(blue);
    await right.recoverAdmission();

    const firstGeneration = turn("race", { generation: 1 });
    const nextGeneration = turn("race", { generation: 2 });
    const results = await Promise.allSettled([
      left.admitNewTurn(firstGeneration),
      right.admitNewTurn(nextGeneration),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const persisted = pins.value as PersistedTurnPins;
    expect(persisted.pins).toHaveLength(1);
    expect([1, 2]).toContain(persisted.pins[0]!.fence.generation);

    const restarted = supervisor(new Clock(), admission, pins);
    await readyAndRecover(restarted, blue);
    await restarted.admitNewTurn(firstGeneration);
    await restarted.admitNewTurn(nextGeneration);
    expect((pins.value as PersistedTurnPins).pins).toHaveLength(2);
  });

  test("24h deadline reports blocked/indeterminate and never retires or reassigns", async () => {
    const clock = new Clock();
    const deadline = 1_000 + 24 * 60 * 60 * 1_000;
    const blue = manifest(1, { deadlineMs: deadline });
    const green = manifest(2, { deadlineMs: deadline });
    const authority = supervisor(clock);
    const owned = turn("indeterminate");
    await readyAndRecover(authority, blue, green);
    await authority.promote(blue);
    await authority.admitNewTurn(owned);
    await authority.promote(green);
    clock.value = deadline;

    expect(authority.snapshot(blue)?.state).toBe("blocked");
    expect(authority.targetForExistingTurn(owned, blue).generation).toBe(1);
    await expect(authority.retire(blue)).rejects.toThrow("owned");
    expect(
      authority.deletionBroadcastTargets().map((item) => item.generation),
    ).toContain(1);
  });

  test("tamper, stale generation, and session/run crossover fail closed", async () => {
    const admission = new AdmissionStorage();
    const pins = new PinStorage();
    const blue = manifest(1);
    const owned = turn("owned");
    const first = supervisor(new Clock(), admission, pins);
    await readyAndRecover(first, blue);
    await first.promote(blue);
    await first.admitNewTurn(owned);

    expect(() =>
      first.targetForExistingTurn({ ...owned, runId: "other-run" }, blue),
    ).toThrow("Stale");
    expect(() =>
      first.targetForExistingTurn(owned, { ...blue, incarnation: "stale" }),
    ).toThrow("Stale");
    expect(() =>
      first.targetForExistingTurn(owned, {
        ...blue,
        keyringDigest: digest("c"),
      }),
    ).toThrow("Stale");

    const persisted = pins.value as PersistedTurnPins;
    pins.value = {
      ...persisted,
      pins: [{ ...persisted.pins[0], generationDigest: digest("f") }],
    };
    const tampered = supervisor(new Clock(), admission, pins);
    await ready(tampered, blue);
    await expect(tampered.recoverAdmission()).rejects.toThrow(
      "Invalid persisted Agent Host turn pins",
    );
    await expect(tampered.admitNewTurn(turn("closed"))).rejects.toThrow(
      "admission is closed",
    );

    pins.value = {
      ...persisted,
      pins: [
        {
          ...persisted.pins[0],
          generation: {
            ...persisted.pins[0]!.generation,
            keyringDigest: digest("c"),
          },
        },
      ],
    };
    const staleKey = supervisor(new Clock(), admission, pins);
    await ready(staleKey, blue);
    await expect(staleKey.recoverAdmission()).rejects.toThrow(
      "turn generation is unavailable",
    );

    pins.value = {
      ...persisted,
      pins: [{ ...persisted.pins[0], generationEpoch: 99 }],
    };
    const staleEpoch = supervisor(new Clock(), admission, pins);
    await ready(staleEpoch, blue);
    await expect(staleEpoch.recoverAdmission()).rejects.toThrow(
      "Invalid persisted Agent Host turn pins",
    );

    const { generation: _staleGeneration, ...threeFieldFence } =
      persisted.pins[0]!.fence;
    pins.value = {
      ...persisted,
      pins: [{ ...persisted.pins[0], fence: threeFieldFence }],
    };
    const legacyPin = supervisor(new Clock(), admission, pins);
    await ready(legacyPin, blue);
    await expect(legacyPin.recoverAdmission()).rejects.toThrow(
      "Invalid persisted Agent Host turn pins",
    );
  });
});
