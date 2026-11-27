import { expect, test } from "bun:test";
import type { ChannelMessage } from "./api/slack-channels";
import { layoutMessages, toggledReactions } from "./channel-messages";

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
