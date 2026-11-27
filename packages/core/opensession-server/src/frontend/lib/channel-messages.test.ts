import { describe, expect, test } from "bun:test";
import type { ChannelMessage } from "./api/slack-channels";
import {
  layoutMessages,
  peopleLine,
  shortWhen,
  toggledReactions,
} from "./channel-messages";

const at = (date: string, user = "UADA"): ChannelMessage => ({
  ts: String(new Date(date).getTime() / 1000),
  userId: user,
  userName: user,
  text: "hi",
  isBot: false,
});

test("groups a run from one person and divides days", () => {
  const items = layoutMessages(
    [
      at("2026-11-26T10:00:00"),
      at("2026-11-26T10:02:00"),
      at("2026-11-26T10:30:00"),
      at("2026-11-26T10:31:00", "UGRACE"),
      at("2026-11-27T09:00:00", "UGRACE"),
    ],
    new Date("2026-11-27T12:00:00"),
  );
  expect(
    items.map((item) =>
      item.kind === "day" ? item.label : item.head ? "head" : "follow",
    ),
  ).toEqual(["Yesterday", "head", "follow", "head", "head", "Today", "head"]);
});

test("toggles the person's own reaction", () => {
  const message = {
    ...at("2026-11-27T09:00:00"),
    reactions: [{ name: "eyes", count: 1, emoji: "👀" }],
  };
  expect(toggledReactions(message, "eyes")).toEqual([
    { name: "eyes", count: 2, emoji: "👀", mine: true },
  ]);
  const mine = {
    ...message,
    reactions: [{ name: "eyes", count: 1, mine: true }],
  };
  expect(toggledReactions(mine, "eyes")).toEqual([]);
  expect(toggledReactions(message, "+1", "👍").at(-1)).toEqual({
    name: "+1",
    count: 1,
    emoji: "👍",
    mine: true,
  });
});

test("names who is in a thread, briefly", () => {
  expect(peopleLine(["Ada", "Ada", "Grace"])).toBe("Ada and Grace");
  expect(peopleLine(["Ada", "Grace", "Alan"])).toBe("Ada, Grace and Alan");
  expect(peopleLine(["Ada", "Grace", "Alan", "Linus"])).toBe(
    "Ada, Grace and 2 others",
  );
});

test("a list row's time: today's clock, then Yesterday, then the date", () => {
  const now = new Date(2026, 10, 27, 15, 0);
  expect(shortWhen(new Date(2026, 10, 26, 9, 0), now)).toBe("Yesterday");
  expect(shortWhen(new Date(2026, 10, 27, 9, 5), now)).toMatch(/9.05/);
  expect(shortWhen(new Date(2025, 0, 3), now)).toMatch(/2025/);
});

describe("editing your own messages", () => {
  const base = { userName: "You", isBot: false };
  test("Up edits the latest message that is yours", async () => {
    const { lastEditable } = await import("./channel-messages");
    const messages = [
      { ...base, ts: "1.0", text: "one", mine: true, source: "one" },
      { ...base, ts: "2.0", text: "two", mine: true, source: "two" },
      { ...base, ts: "3.0", text: "theirs", userName: "Ada" },
    ];
    expect(lastEditable(messages)?.ts).toBe("2.0");
    expect(lastEditable(messages.slice(2))).toBeUndefined();
  });
});
