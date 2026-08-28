import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOperationOutcomeV1 } from "@tellahq/opensession-protocol/agent-operation";
import { TranscriptStore, TRANSCRIPT_DESTINATION_MAX_ENTRIES } from "../transcript-store";
import type { TranscriptEntry } from "../types";
import type { AgentGatewayAdapterResult } from "./gateway";
import type { AgentOperationIdentity, AgentOperationTerminalReservation } from "./ledger";
import {
  AgentOperationTranscriptFacade,
  AgentTranscriptReservationAuthenticationError,
  type AgentTranscriptRenderResult,
} from "./transcript-facade";

const digest = (c: string) => `sha256:${c.repeat(64)}` as const;
const freeze = <T>(value: T): Readonly<T> => Object.freeze(value);

function identity(kind: "model" | "mcp" = "model"): AgentOperationIdentity {
  const descriptor = kind === "model"
    ? { version: 1, kind, model: "claude", maxOutputTokens: 100, inputDigest: digest("1") }
    : { version: 1, kind, serverId: "server", toolName: "tool", argumentsDigest: digest("2") };
  return freeze({
    operationId: "operation-1", kind,
    fence: freeze({ sessionId: "session-1", runId: "run-1", turnId: "turn-1", generation: 1 }),
    planHash: digest("3"), authorityHash: digest("4"), supervisorEpoch: 1,
    hostId: "host-1", hostGeneration: 1, hostIncarnation: "incarnation-1",
    transcriptAnchor: freeze({ throughChangeSeq: 0, entryIds: freeze([] as string[]), digest: digest("5") }),
    ...(kind === "mcp" ? { toolUseEntryId: "call-1" } : {}),
    descriptor: freeze(descriptor) as unknown as AgentOperationIdentity["descriptor"],
    descriptorDigest: digest("6"), payloadDigest: digest("7"), adapterId: "adapter", adapterVersion: "1",
  });
}

const reservation = freeze({
  reservationId: `reservation:${"a".repeat(64)}`,
  reason: "timeout_ambiguous" as const,
  reservedAtMs: 10,
});

function adapter(outcome: AgentOperationOutcomeV1 = freeze({ status: "succeeded", code: "ok" }), transcript: unknown = freeze({ private: "provider-secret" })): AgentGatewayAdapterResult {
  return freeze({ outcome: freeze(outcome), transcript, providerRequestRef: "provider-secret-request" });
}

function entry(id: string, type: TranscriptEntry["type"] = "assistant", content = "hello"): Readonly<TranscriptEntry> {
  return freeze({ id, type, content, timestamp: "2026-08-23T00:00:00.000Z" });
}

function rendered(entries: readonly Readonly<TranscriptEntry>[], pending?: readonly string[]): AgentTranscriptRenderResult {
  return freeze({ entries: freeze([...entries]), ...(pending === undefined ? {} : { pendingToolUseEntryIds: freeze([...pending]) }) });
}

function fixture(kind: "model" | "mcp" = "model") {
  const dir = mkdtempSync(join(tmpdir(), "agent-transcript-facade-"));
  const path = join(dir, "transcripts.db");
  const store = new TranscriptStore(path);
  const who = identity(kind);
  let renders = 0;
  let commits = 0;
  const renderer = async (): Promise<AgentTranscriptRenderResult> => {
    renders++;
    return kind === "model"
      ? rendered([entry("answer"), entry("pending", "tool_use", "call")], ["pending"])
      : rendered([entry("tool-result", "tool_result", "done")]);
  };
  const facadeFor = (
    target: TranscriptStore,
    authenticate: (identity: Readonly<AgentOperationIdentity>, reservation: Readonly<AgentOperationTerminalReservation>) => Promise<Readonly<AgentOperationTerminalReservation> | undefined> = async (_i, r) => r,
  ) => new AgentOperationTranscriptFacade({
    store: {
      commitTranscriptDestinationAppendReceipt(input) { commits++; return target.commitTranscriptDestinationAppendReceipt(input); },
      validateAgentTranscriptReceiptRef(input) { return target.validateAgentTranscriptReceiptRef(input); },
    },
    render: renderer,
    authenticateReservation: authenticate,
  });
  return { dir, path, store, who, facade: facadeFor(store), facadeFor, counts: () => ({ renders, commits }) };
}

function cleanup(f: ReturnType<typeof fixture>) {
  try { f.store.close(); } catch {}
  rmSync(f.dir, { recursive: true, force: true });
}

describe("Agent operation transcript destination facade", () => {
  test("renders model and MCP terminals with canonical receipts and exact kernel evidence", async () => {
    const model = fixture("model");
    try {
      const first = await model.facade.appendTerminal(model.who, adapter());
      expect(first.refs).toHaveLength(1);
      expect(first.refs[0]?.entryIds).toEqual(["answer", "pending"]);
      expect(first.kernelTerminal).toEqual({
        outputDigest: first.refs[0]?.requestDigest,
        outcomeCode: "ok",
        transcriptRefs: first.refs,
        pendingToolUseEntryIds: ["pending"],
      });
      expect(Object.isFrozen(first.refs)).toBe(true);
    } finally { cleanup(model); }

    const mcp = fixture("mcp");
    try {
      const terminal = await mcp.facade.appendTerminal(mcp.who, adapter(freeze({ status: "failed", code: "provider_error", outputDigest: digest("e") })));
      expect(terminal.kernelTerminal).toEqual({ outputDigest: digest("e"), outcomeCode: "provider_error", transcriptRefs: terminal.refs });
      expect("pendingToolUseEntryIds" in terminal.kernelTerminal).toBe(false);
    } finally { cleanup(mcp); }
  });

  test("commits exactly once across retries and store restart", async () => {
    const f = fixture();
    try {
      const first = await f.facade.appendTerminal(f.who, adapter());
      const retry = await f.facade.appendTerminal(f.who, adapter());
      expect(retry).toEqual(first);
      expect(f.counts()).toEqual({ renders: 1, commits: 1 });
      f.store.close();
      const reopened = new TranscriptStore(f.path);
      const restarted = f.facadeFor(reopened);
      const replay = await restarted.appendTerminal(f.who, adapter());
      expect(replay).toEqual(first);
      expect(reopened.countEvents("session-1")).toBe(2);
      expect(f.counts()).toEqual({ renders: 2, commits: 2 });
      reopened.close();
    } finally { cleanup(f); }
  });

  test("uses reservation-derived append identity and authenticates before any callback", async () => {
    const f = fixture();
    try {
      const good = await f.facade.appendIndeterminate(f.who, reservation, adapter(freeze({ status: "failed", code: reservation.reason }) as unknown as AgentOperationOutcomeV1));
      expect(good.refs[0]?.appendId).toMatch(/^agent-indeterminate:[a-f0-9]{64}$/);
      expect(good.refs[0]?.appendId).not.toContain(f.who.operationId);
      const forged = freeze({ ...reservation, reservationId: `reservation:${"b".repeat(64)}` });
      const before = f.counts();
      const rejecting = f.facadeFor(f.store, async () => undefined);
      await expect(rejecting.appendIndeterminate(f.who, forged, adapter())).rejects.toBeInstanceOf(AgentTranscriptReservationAuthenticationError);
      expect(f.counts()).toEqual(before);
    } finally { cleanup(f); }
  });

  test("replays supplied proof before rendering and rejects anchor or append mismatch", async () => {
    const f = fixture();
    try {
      const first = await f.facade.appendTerminal(f.who, adapter());
      const freshFacade = f.facadeFor(f.store);
      const replay = await freshFacade.appendTerminal(f.who, adapter(), { receipt: first.refs[0]!, pendingToolUseEntryIds: freeze(["pending"]) });
      expect(replay).toEqual(first);
      expect(f.counts()).toEqual({ renders: 1, commits: 1 });
      await expect(freshFacade.appendTerminal(f.who, adapter(), { receipt: freeze({ ...first.refs[0]!, appendId: "forged" }), pendingToolUseEntryIds: freeze(["pending"]) })).rejects.toThrow(/identity mismatch/);
      const wrongAnchor = freeze({ ...f.who, transcriptAnchor: freeze({ ...f.who.transcriptAnchor, digest: digest("9") }) });
      await expect(freshFacade.appendTerminal(wrongAnchor, adapter(), { receipt: first.refs[0]!, pendingToolUseEntryIds: freeze(["pending"]) })).rejects.toThrow();
    } finally { cleanup(f); }
  });

  test("keeps receipts valid after unrelated history and fails closed on referenced tamper, deletion, or order corruption", async () => {
    const f = fixture();
    try {
      const first = await f.facade.appendTerminal(f.who, adapter());
      f.store.commitTranscriptDestinationAppend({
        sessionId: "session-1", runId: "other-run", turnId: "other-turn", generation: 1, appendId: "unrelated",
        entries: [{ ...entry("later"), content: "later" }],
      });
      const fresh = f.facadeFor(f.store);
      await expect(fresh.appendTerminal(f.who, adapter(), { receipt: first.refs[0]!, pendingToolUseEntryIds: freeze(["pending"]) })).resolves.toEqual(first);

      const db = new Database(f.path);
      db.run("UPDATE transcript_events SET change_seq = change_seq + 50 WHERE session_id = ? AND uuid = ?", ["session-1", "answer"]);
      db.close();
      await expect(fresh.appendTerminal(f.who, adapter(), { receipt: first.refs[0]!, pendingToolUseEntryIds: freeze(["pending"]) })).rejects.toThrow();

      const f2 = fixture();
      try {
        const receipt = (await f2.facade.appendTerminal(f2.who, adapter())).refs[0]!;
        const deleteDb = new Database(f2.path);
        deleteDb.run("DELETE FROM transcript_events WHERE session_id = ? AND uuid = ?", ["session-1", "answer"]);
        deleteDb.close();
        await expect(f2.facadeFor(f2.store).appendTerminal(f2.who, adapter(), { receipt, pendingToolUseEntryIds: freeze(["pending"]) })).rejects.toThrow();
      } finally { cleanup(f2); }
    } finally { cleanup(f); }
  });

  test("rejects duplicate IDs, mutable or over-bound renderer evidence without destination mutation", async () => {
    const f = fixture();
    try {
      const cases: AgentTranscriptRenderResult[] = [
        rendered([entry("same"), entry("same")], []),
        freeze({ entries: [entry("mutable-array")] as readonly Readonly<TranscriptEntry>[], pendingToolUseEntryIds: freeze([]) }),
        rendered(Array.from({ length: TRANSCRIPT_DESTINATION_MAX_ENTRIES + 1 }, (_, i) => entry(`e-${i}`)), []),
      ];
      for (const evidence of cases) {
        const facade = new AgentOperationTranscriptFacade({ store: f.store, render: async () => evidence, authenticateReservation: async (_i, r) => r });
        await expect(facade.appendTerminal(f.who, adapter())).rejects.toThrow();
      }
      expect(f.store.countEvents("session-1")).toBe(0);
    } finally { cleanup(f); }
  });

  test("never persists provider-private material", async () => {
    const f = fixture();
    try {
      await f.facade.appendTerminal(f.who, adapter(undefined, freeze({ apiKey: "sk-provider-secret", raw: "provider-secret-body" })));
      f.store.close();
      const bytes = await Bun.file(f.path).text();
      expect(bytes).not.toContain("sk-provider-secret");
      expect(bytes).not.toContain("provider-secret-body");
      expect(bytes).not.toContain("provider-secret-request");
    } finally { cleanup(f); }
  });
});
