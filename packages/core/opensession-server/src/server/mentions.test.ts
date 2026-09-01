import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same shape as session-notes.test.ts: the store's directory is resolved at
// module load (stateDir), so the scratch namespace has to be in place before
// the import. `bun test` shares one process across files, so the env is
// restored immediately afterwards.
const SCRATCH = mkdtempSync(join(tmpdir(), "mentions-"));
const saved = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = SCRATCH;
const {
  addMention,
  clearAllMentions,
  clearMention,
  listMentions,
  mentionPreview,
  notifyMentions,
  recordMentions,
} = await import("./mentions");
const { teamFirstNames } = await import("./people");
if (saved === undefined) delete process.env.OPENSESSION_STATE_DIR;
else process.env.OPENSESSION_STATE_DIR = saved;

function mention(sessionId: string, by = "Grant") {
  return { sessionId, by, source: "note" as const, preview: "look at this" };
}

describe("mentions", () => {
  test("records per person and lists them back", () => {
    addMention("Kent", mention("os-a"));
    addMention("Michiel", mention("os-b"));
    expect(listMentions("Kent").map((m) => m.sessionId)).toEqual(["os-a"]);
    expect(listMentions("Michiel").map((m) => m.sessionId)).toEqual(["os-b"]);
    expect(listMentions("Nobody")).toEqual([]);
  });

  test("is keyed case-insensitively, so a display name and a key agree", () => {
    addMention("Kent", mention("os-case"));
    expect(listMentions("kent").map((m) => m.sessionId)).toContain("os-case");
  });

  test("a second mention in one session replaces the first — one row, one badge", () => {
    addMention("Ren", { ...mention("os-dup", "Grant"), preview: "first" });
    addMention("Ren", { ...mention("os-dup", "Kent"), preview: "second" });
    const all = listMentions("Ren").filter((m) => m.sessionId === "os-dup");
    expect(all).toHaveLength(1);
    expect(all[0]!.by).toBe("Kent");
    expect(all[0]!.preview).toBe("second");
  });

  test("clearing one session leaves the others", () => {
    addMention("Ada", mention("os-1"));
    addMention("Ada", mention("os-2"));
    expect(clearMention("Ada", "os-1")).toBe(true);
    expect(listMentions("Ada").map((m) => m.sessionId)).toEqual(["os-2"]);
    // Clearing what isn't there is a no-op, not an error: opening a session
    // you were never tagged in takes this path on every mount.
    expect(clearMention("Ada", "os-1")).toBe(false);
    clearAllMentions("Ada");
    expect(listMentions("Ada")).toEqual([]);
  });

  test("a person key that could escape the directory is refused", () => {
    expect(addMention("../../etc/passwd", mention("os-x"))).toBeNull();
    expect(listMentions("../../etc/passwd")).toEqual([]);
  });

  test("recordMentions never records the sender's own name", () => {
    // The roster comes from the instance identity config, so assert the
    // shape rather than specific teammates: a sender's own name is dropped,
    // and text with no "@" does no work at all.
    const sender = "Kent";
    expect(
      recordMentions(`@${sender} look`, sender, "os-self", "note"),
    ).toEqual([]);
    expect(
      recordMentions("nobody tagged", sender, "os-none", "prompt"),
    ).toEqual([]);
    expect(listMentions(sender).map((m) => m.sessionId)).not.toContain(
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
    const stored = listMentions(person).find(
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
