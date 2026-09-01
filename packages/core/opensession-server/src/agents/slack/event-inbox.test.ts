import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SlackEventInbox,
  type SlackEventInboxDependencies,
} from "./event-inbox";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup(patch: Partial<SlackEventInboxDependencies> = {}): {
  dir: string;
  store: string;
  handled: string[];
  processed: Set<string>;
  deps: SlackEventInboxDependencies;
} {
  const dir = mkdtempSync(join(tmpdir(), "opensession-slack-event-inbox-"));
  scratch.push(dir);
  const handled: string[] = [];
  const processed = new Set<string>();
  const deps: SlackEventInboxDependencies = {
    handleDirectMessage: async (event) => {
      handled.push(`dm:${event.ts}`);
    },
    handleMention: async (event) => {
      handled.push(`mention:${event.ts}`);
    },
    isProcessed: (id) => processed.has(id),
    markProcessed: (id) => {
      processed.add(id);
    },
    ...patch,
  };
  return {
    dir,
    store: join(dir, "event-inbox.json"),
    handled,
    processed,
    deps,
  };
}

function event(ts = "1787752607.643009") {
  return {
    type: "app_mention",
    channel: "C0A77HH0XPT",
    ts,
    thread_ts: "1787285297.117399",
    user: "U0866D7PCCU",
    text: "<@U0A7T08405R> check?",
  };
}

describe("SlackEventInbox", () => {
  test("persists a mention before processing starts", async () => {
    const { store, handled, processed, deps } = setup();
    const inbox = new SlackEventInbox(store, deps);

    expect(inbox.enqueue("mention", event())).toBe("enqueued");
    expect(handled).toEqual([]);
    expect(JSON.parse(readFileSync(store, "utf8"))).toMatchObject([
      {
        id: "C0A77HH0XPT-1787752607.643009",
        kind: "mention",
        attempts: 0,
      },
    ]);
    expect(statSync(store).mode & 0o777).toBe(0o600);

    await inbox.start();
    expect(handled).toEqual(["mention:1787752607.643009"]);
    expect(processed.has("C0A77HH0XPT-1787752607.643009")).toBe(true);
    expect(JSON.parse(readFileSync(store, "utf8"))).toEqual([]);
  });

  test("replays an unfinished event in a new process", async () => {
    const { store, handled, deps } = setup();
    const first = new SlackEventInbox(store, deps);
    first.enqueue("mention", event());

    const replay = new SlackEventInbox(store, deps);
    expect(replay.pendingCount()).toBe(1);
    await replay.start();

    expect(handled).toEqual(["mention:1787752607.643009"]);
    expect(replay.pendingCount()).toBe(0);
  });

  test("keeps a failed event durable for a later retry", async () => {
    const setupState = setup({
      handleMention: async () => {
        throw new Error("classifier unavailable");
      },
    });
    const first = new SlackEventInbox(setupState.store, setupState.deps, {
      retryDelayMs: 60_000,
    });
    first.enqueue("mention", event());
    await first.start();
    first.stop();

    expect(JSON.parse(readFileSync(setupState.store, "utf8"))).toMatchObject([
      {
        id: "C0A77HH0XPT-1787752607.643009",
        attempts: 1,
        lastError: "classifier unavailable",
      },
    ]);

    const recovered: string[] = [];
    const replay = new SlackEventInbox(setupState.store, {
      ...setupState.deps,
      handleMention: async (value) => {
        recovered.push(value.ts);
      },
    });
    await replay.start();
    expect(recovered).toEqual(["1787752607.643009"]);
    expect(JSON.parse(readFileSync(setupState.store, "utf8"))).toEqual([]);
  });

  test("deduplicates retries while an event is pending", () => {
    const { store, deps } = setup();
    const inbox = new SlackEventInbox(store, deps);
    expect(inbox.enqueue("direct_message", event("1.1"))).toBe("enqueued");
    expect(inbox.enqueue("direct_message", event("1.1"))).toBe("pending");
    expect(inbox.pendingCount()).toBe(1);
  });

  test("cleans up a stale inbox record already marked processed", async () => {
    const { store, handled, processed, deps } = setup();
    const first = new SlackEventInbox(store, deps);
    first.enqueue("mention", event());
    processed.add("C0A77HH0XPT-1787752607.643009");

    const replay = new SlackEventInbox(store, deps);
    await replay.start();
    expect(handled).toEqual([]);
    expect(JSON.parse(readFileSync(store, "utf8"))).toEqual([]);
  });
});
