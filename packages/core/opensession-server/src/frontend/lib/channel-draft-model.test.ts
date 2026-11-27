import { expect, test } from "bun:test";
import { decodeDrafts, draftKey } from "./channel-draft-model";

test("keys a thread's draft apart from its channel's", () => {
  expect(draftKey("C1")).toBe("C1");
  expect(draftKey("C1", "1700000000.000100")).toBe("C1:1700000000.000100");
});

test("reads stored drafts newest first and drops anything else", () => {
  const raw = JSON.stringify([
    { channelId: "C1", text: "old", at: 1, mentions: [] },
    { channelId: "C2", text: 5, at: 3, mentions: [] },
    {
      channelId: "C3",
      thread: "1.2",
      text: "new",
      at: 2,
      mentions: [["Ada", "U1"]],
    },
  ]);
  expect(decodeDrafts(raw).map((d) => d.text)).toEqual(["new", "old"]);
  expect(decodeDrafts("not json")).toEqual([]);
  expect(decodeDrafts(null)).toEqual([]);
});
