import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import { importApplicationCatalog } from "./catalog-documents";
import {
  addMention,
  clearAllMentions,
  clearMention,
  listMentions,
  mentionPreview,
  notifyMentions,
  recordMentions,
} from "./mentions";
import { teamFirstNames } from "./people";

// The catalog mirrors every document into the legacy directory and the boot
// import reads from it, so the scratch root stays in place for the whole
// file. `bun test` runs each file in its own process (test-unit-isolated.sh).
const SCRATCH = mkdtempSync(join(tmpdir(), "mentions-"));
const saved = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = SCRATCH;

afterAll(() => {
  if (saved === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = saved;
  rmSync(SCRATCH, { recursive: true, force: true });
});

let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
beforeEach(() => {
  rmSync(join(SCRATCH, ".opensession-mentions"), {
    recursive: true,
    force: true,
  });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

function mention(sessionId: string, by = "Grant") {
  return { sessionId, by, source: "note" as const, preview: "look at this" };
}

/** A per-person file as the flat-file store wrote it, before the catalog. */
function seedLegacy(person: string, mentions: unknown[]): void {
  const dir = join(SCRATCH, ".opensession-mentions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${person}.json`), JSON.stringify({ mentions }));
}

describe("mentions", () => {
  test("records per person and lists them back", async () => {
    await addMention("Kent", mention("os-a"));
    await addMention("Michiel", mention("os-b"));
    expect((await listMentions("Kent")).map((m) => m.sessionId)).toEqual([
      "os-a",
    ]);
    expect((await listMentions("Michiel")).map((m) => m.sessionId)).toEqual([
      "os-b",
    ]);
    expect(await listMentions("Nobody")).toEqual([]);
  });

  test("is keyed case-insensitively, so a display name and a key agree", async () => {
    await addMention("Kent", mention("os-case"));
    expect((await listMentions("kent")).map((m) => m.sessionId)).toContain(
      "os-case",
    );
  });

  test("a second mention in one session replaces the first: one row, one badge", async () => {
    await addMention("Ren", {
      ...mention("os-dup", "Grant"),
      preview: "first",
    });
    await addMention("Ren", {
      ...mention("os-dup", "Kent"),
      preview: "second",
    });
    const all = (await listMentions("Ren")).filter(
      (m) => m.sessionId === "os-dup",
    );
    expect(all).toHaveLength(1);
    expect(all[0]!.by).toBe("Kent");
    expect(all[0]!.preview).toBe("second");
  });

  test("clearing one session leaves the others", async () => {
    await addMention("Ada", mention("os-1"));
    await addMention("Ada", mention("os-2"));
    expect(await clearMention("Ada", "os-1")).toBe(true);
    expect((await listMentions("Ada")).map((m) => m.sessionId)).toEqual([
      "os-2",
    ]);
    // Clearing what isn't there is a no-op, not an error: opening a session
    // you were never tagged in takes this path on every mount.
    expect(await clearMention("Ada", "os-1")).toBe(false);
    await clearAllMentions("Ada");
    expect(await listMentions("Ada")).toEqual([]);
  });

  test("a person key that could escape the namespace is refused", async () => {
    expect(await addMention("../../etc/passwd", mention("os-x"))).toBeNull();
    expect(await listMentions("../../etc/passwd")).toEqual([]);
    expect(await clearMention("../../etc/passwd", "os-x")).toBe(false);
  });

  test("keeps the newest 200 per person", async () => {
    for (let i = 0; i < 205; i++)
      await addMention("Kent", { ...mention(`os-${i}`), ts: i });
    const all = await listMentions("Kent");
    expect(all).toHaveLength(200);
    expect(all[0]!.sessionId).toBe("os-5");
    expect(all.at(-1)!.sessionId).toBe("os-204");
  });

  // The flat-file store wrote `<person>.json` lowercased; the boot import
  // keys the catalog row by that stem, which is the key the reader uses.
  test("reads mentions imported from a legacy file", async () => {
    seedLegacy("kent", [
      { ...mention("os-legacy"), ts: 1 },
      // A row missing what a badge needs is dropped rather than rendered.
      { sessionId: "os-broken", by: "Grant", ts: 2 },
    ]);
    await importApplicationCatalog();
    expect((await listMentions("Kent")).map((m) => m.sessionId)).toEqual([
      "os-legacy",
    ]);
    await addMention("Kent", mention("os-after"));
    expect((await listMentions("Kent")).map((m) => m.sessionId)).toEqual([
      "os-legacy",
      "os-after",
    ]);
  });

  test("does not read a legacy file that was never imported", async () => {
    seedLegacy("kent", [{ ...mention("os-legacy"), ts: 1 }]);
    expect(await listMentions("Kent")).toEqual([]);
  });

  // Every append is a compare-and-set on the person's row, so mentions from
  // several sessions at once cannot overwrite each other.
  test("concurrent mentions all survive", async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `os-${i}`);
    await Promise.all(ids.map((id) => addMention("Kent", mention(id))));
    expect((await listMentions("Kent")).map((m) => m.sessionId).sort()).toEqual(
      [...ids].sort(),
    );
  });

  test("a clear racing an append drops only its own session", async () => {
    await addMention("Kent", mention("os-old"));
    await Promise.all([
      clearMention("Kent", "os-old"),
      addMention("Kent", mention("os-new")),
      addMention("Kent", mention("os-newer")),
    ]);
    expect((await listMentions("Kent")).map((m) => m.sessionId).sort()).toEqual(
      ["os-new", "os-newer"],
    );
  });

  test("recordMentions never records the sender's own name", async () => {
    // The roster comes from the instance identity config, so assert the
    // shape rather than specific teammates: a sender's own name is dropped,
    // and text with no "@" does no work at all.
    const sender = "Kent";
    expect(
      await recordMentions(`@${sender} look`, sender, "os-self", "note"),
    ).toEqual([]);
    expect(
      await recordMentions("nobody tagged", sender, "os-none", "prompt"),
    ).toEqual([]);
    expect((await listMentions(sender)).map((m) => m.sessionId)).not.toContain(
      "os-self",
    );
  });

  test("notifyMentions records what it announces", async () => {
    // The surfaces (a note, a prompt, a new session's opening message) all
    // call this one function, so the badge is what proves it ran: with no
    // clients and no push subscriptions the other two legs are no-ops.
    const team = teamFirstNames();
    // A portable instance can have an empty roster; nothing to tag then.
    if (team.length < 2) return;
    const [person, sender] = team;
    expect(
      await notifyMentions(
        `@${person} take a look`,
        sender,
        "os-notify",
        "prompt",
        "a session",
      ),
    ).toEqual([person]);
    const stored = (await listMentions(person)).find(
      (m) => m.sessionId === "os-notify",
    );
    expect(stored?.by).toBe(sender);
    expect(stored?.source).toBe("prompt");
    expect(
      await notifyMentions(
        "nobody tagged",
        sender,
        "os-quiet",
        "note",
        "a session note",
      ),
    ).toEqual([]);
  });

  test("preview is capped with an ellipsis, short text untouched", () => {
    expect(mentionPreview("short")).toBe("short");
    const long = mentionPreview("x".repeat(300));
    expect(long).toHaveLength(140);
    expect(long.endsWith("…")).toBe(true);
  });
});
