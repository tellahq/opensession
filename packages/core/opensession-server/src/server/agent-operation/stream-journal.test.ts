import { describe, expect, test } from "bun:test";
import {
  AgentOperationStreamJournal,
  AgentOperationStreamRecoveryRequiredError,
} from "./stream-journal";

describe("AgentOperationStreamJournal", () => {
  test("publication remains blocked until exact cumulative acknowledgement", async () => {
    const journal = new AgentOperationStreamJournal();
    let done = false;
    const publishing = journal.publish({ delta: "safe" }).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    const iterator = journal.replay(0)[Symbol.asyncIterator]();
    expect(new TextDecoder().decode((await iterator.next()).value)).toBe(
      '{"delta":"safe"}\n',
    );
    journal.acknowledge(1);
    await publishing;
    expect(done).toBe(true);
    await journal.close();
    expect((await iterator.next()).done).toBe(true);
  });
  test("rejects cursor gaps after acknowledged frames are retired", async () => {
    const journal = new AgentOperationStreamJournal();
    const publishing = journal.publish({ delta: "x" });
    journal.acknowledge(1);
    await publishing;
    expect(() => journal.replay(0)).toThrow(
      AgentOperationStreamRecoveryRequiredError,
    );
  });
  test("enforces 48 KiB chunks without retaining content in diagnostics", async () => {
    const journal = new AgentOperationStreamJournal();
    await expect(
      journal.publish({ secret: "x".repeat(49 * 1024) }),
    ).rejects.toBeInstanceOf(AgentOperationStreamRecoveryRequiredError);
    expect(
      JSON.stringify({ bytes: journal.bytes, frames: journal.frameCount }),
    ).not.toContain("secret");
  });
  test("enforces bounded capacity until real consumption ACK retires frames", async () => {
    const journal = new AgentOperationStreamJournal();
    const blocked = Array.from({ length: 128 }, (_, index) =>
      journal.publish({ index }),
    );
    expect(journal.frameCount).toBe(128);
    await expect(journal.publish({ overflow: true })).rejects.toThrow(
      "journal is full",
    );
    const iterator = journal.replay(0)[Symbol.asyncIterator]();
    for (let index = 0; index < 128; index++)
      expect((await iterator.next()).done).toBe(false);
    journal.acknowledge(128);
    await Promise.all(blocked);
    expect(journal.frameCount).toBe(0);
    await journal.close();
    expect((await iterator.next()).done).toBe(true);
  });

  test("close waits for consumption ACK while failure is bounded and redacts diagnostics", async () => {
    const journal = new AgentOperationStreamJournal();
    const publishing = journal.publish({ delta: "x" });
    let closed = false;
    const closing = journal.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    journal.acknowledge(1);
    await Promise.all([publishing, closing]);
    expect(closed).toBe(true);

    const failed = new AgentOperationStreamJournal();
    const blocked = failed.publish({ secret: "payload-secret" });
    await failed.fail(new Error("credential-secret"));
    await expect(blocked).rejects.toThrow("operation stream is closed");
    const iterator = failed.replay(0)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    try {
      await iterator.next();
      throw new Error("expected replay failure");
    } catch (error) {
      expect(String(error)).not.toContain("credential-secret");
      expect(String(error)).not.toContain("payload-secret");
    }
  });
});
