import { describe, expect, test } from "bun:test";
import type {
  AgentOperationDigest,
  AgentTurnSpec,
} from "@tellahq/opensession-protocol";
import type {
  AgentHostOperationCancel,
  AgentHostOperationQuery,
  AgentHostOperationRequest,
  AgentHostOperationStream,
  AgentHostOperationTransport,
  AgentTurnDriver,
  AgentTurnResult,
} from "./driver";

const digest = (character: string) =>
  `sha256:${character.repeat(64)}` as AgentOperationDigest;

const descriptor = {
  version: 1 as const,
  kind: "model" as const,
  stepId: "step-1",
  transcript: {
    throughChangeSeq: 4,
    entryIds: ["entry-1"],
    digest: digest("a"),
  },
  modelPolicyHash: digest("b"),
  adapterRequestVersion: "model-request.v1",
};

const request: AgentHostOperationRequest = {
  operationId: "operation-1",
  descriptor,
  descriptorDigest: digest("c"),
  deadlineMs: 2_000,
};
const query: AgentHostOperationQuery = {
  operationId: "operation-1",
  kind: "model",
  descriptorDigest: digest("c"),
  payloadDigest: digest("d"),
  afterStreamSeq: 3,
};
const cancel: AgentHostOperationCancel = {
  operationId: "operation-1",
  cancelId: "cancel-1",
  reason: "user",
};
const stream = (streamSeq: number): AgentHostOperationStream => ({
  operationId: "operation-1",
  streamSeq,
  encoding: "base64url+opensession-operation-v1",
  bytes: "aGVsbG8",
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class FakeTransport implements AgentHostOperationTransport {
  readonly requests: AgentHostOperationRequest[] = [];
  readonly queries: AgentHostOperationQuery[] = [];
  readonly cancellations: AgentHostOperationCancel[] = [];
  requestResult = Promise.resolve();
  queryResult = Promise.resolve();
  cancelResult = Promise.resolve();

  requestOperation(value: AgentHostOperationRequest) {
    this.requests.push(value);
    return this.requestResult;
  }

  queryOperation(value: AgentHostOperationQuery) {
    this.queries.push(value);
    return this.queryResult;
  }

  cancelOperation(value: AgentHostOperationCancel) {
    this.cancellations.push(value);
    return this.cancelResult;
  }
}

class FakeDriver implements AgentTurnDriver {
  readonly deliveries: number[] = [];
  readonly gates: ReturnType<typeof deferred>[] = [];

  async run(
    _spec: AgentTurnSpec,
    _transport: AgentHostOperationTransport,
  ): Promise<AgentTurnResult> {
    return { status: "completed" };
  }

  deliverOperationStream(value: AgentHostOperationStream) {
    this.deliveries.push(value.streamSeq);
    const gate = deferred();
    this.gates.push(gate);
    return gate.promise;
  }

  async cancel() {}
  async shutdown() {}
}

describe("Agent Host driver v5 boundary", () => {
  test("forwards exact request, query, and cancel operation intents", async () => {
    const transport = new FakeTransport();

    await transport.requestOperation(request);
    await transport.queryOperation(query);
    await transport.cancelOperation(cancel);

    expect(transport.requests).toEqual([request]);
    expect(transport.queries).toEqual([query]);
    expect(transport.cancellations).toEqual([cancel]);
  });

  test("propagates operation transport rejection without translation", async () => {
    const transport = new FakeTransport();
    const requestError = new Error("request rejected");
    const queryError = new Error("query rejected");
    const cancelError = new Error("cancel rejected");
    transport.requestResult = Promise.reject(requestError);
    transport.queryResult = Promise.reject(queryError);
    transport.cancelResult = Promise.reject(cancelError);

    expect(transport.requestOperation(request)).rejects.toBe(requestError);
    expect(transport.queryOperation(query)).rejects.toBe(queryError);
    expect(transport.cancelOperation(cancel)).rejects.toBe(cancelError);
  });

  test("opaque stream delivery applies ordering and backpressure before ACK", async () => {
    const driver = new FakeDriver();
    const acknowledgements: number[] = [];
    let delivery = Promise.resolve();
    const deliverThenAck = (value: AgentHostOperationStream) => {
      delivery = delivery.then(async () => {
        await driver.deliverOperationStream(value);
        acknowledgements.push(value.streamSeq);
      });
      return delivery;
    };

    const first = deliverThenAck(stream(1));
    const second = deliverThenAck(stream(2));
    await Promise.resolve();
    expect(driver.deliveries).toEqual([1]);
    expect(acknowledgements).toEqual([]);

    driver.gates[0]!.resolve();
    await first;
    expect(acknowledgements).toEqual([1]);
    expect(driver.deliveries).toEqual([1, 2]);

    driver.gates[1]!.resolve();
    await second;
    expect(acknowledgements).toEqual([1, 2]);
  });

  test("exposes no policy-rich v4 inputs or control methods", () => {
    const allowedKeys = new Set([
      "operationId",
      "descriptor",
      "descriptorDigest",
      "deadlineMs",
      "kind",
      "payloadDigest",
      "afterStreamSeq",
      "cancelId",
      "reason",
      "streamSeq",
      "encoding",
      "bytes",
    ]);
    const forbidden = [
      "authority",
      "prompt",
      "images",
      "model",
      "provider",
      "mcpPolicy",
      "identity",
      "credentials",
      "url",
      "headers",
      "env",
      "executorGrant",
      "accessGrant",
    ];

    for (const value of [request, query, cancel, stream(1)]) {
      expect(Object.keys(value).every((key) => allowedKeys.has(key))).toBe(true);
      for (const key of forbidden) expect(key in value).toBe(false);
    }
    expect(Object.getOwnPropertyNames(FakeTransport.prototype).sort()).toEqual([
      "cancelOperation",
      "constructor",
      "queryOperation",
      "requestOperation",
    ]);
    expect(Object.getOwnPropertyNames(FakeDriver.prototype).sort()).toEqual([
      "cancel",
      "constructor",
      "deliverOperationStream",
      "run",
      "shutdown",
    ]);
  });
});
