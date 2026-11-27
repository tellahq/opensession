import { expect, test } from "bun:test";
import type { Conversation } from "./api/slack-channels";
import {
  decodeHidden,
  decodeSections,
  movedChannel,
  sidebarGroups,
  type ChannelSection,
} from "./channel-section-model";

const rows: Conversation[] = [
  { id: "C1", name: "chat", kind: "channel" },
  { id: "C2", name: "proj-desktop", kind: "channel" },
  { id: "C3", name: "random", kind: "channel" },
  { id: "D1", name: "Grace", kind: "dm" },
];

test("sections come first in their own order, the rest under the built-ins", () => {
  const sections: ChannelSection[] = [
    { id: "start", name: "Start", channels: ["C1", "D1", "CGONE"] },
    { id: "projects", name: "Projects", emoji: "💡", channels: ["C2"] },
  ];
  const groups = sidebarGroups(rows, sections);
  expect(groups.map((g) => [g.title, g.rows.map((r) => r.id)])).toEqual([
    ["Start", ["C1", "D1"]],
    ["Projects", ["C2"]],
    ["Channels", ["C3"]],
    ["Direct messages", []],
    ["Hidden", []],
  ]);
  expect(groups[1]!.emoji).toBe("💡");
});

test("moving a conversation takes it out of its old section", () => {
  const sections: ChannelSection[] = [
    { id: "a", name: "A", channels: ["C1", "C2"] },
    { id: "b", name: "B", channels: [] },
  ];
  expect(movedChannel(sections, "C1", "b")).toEqual([
    { id: "a", name: "A", channels: ["C2"] },
    { id: "b", name: "B", channels: ["C1"] },
  ]);
  expect(movedChannel(sections, "C2", null)[0]!.channels).toEqual(["C1"]);
});

test("reads only well-formed sections", () => {
  expect(decodeSections("nope")).toBeNull();
  expect(
    decodeSections(
      JSON.stringify([{ id: "a", name: "A", channels: ["C1"] }, { id: 3 }]),
    ),
  ).toEqual([{ id: "a", name: "A", channels: ["C1"] }]);
});

test("hidden conversations fold under Hidden, unless open or a DM with news", () => {
  const sections: ChannelSection[] = [
    { id: "start", name: "Start", channels: ["C1"] },
  ];
  const all: Conversation[] = [
    ...rows,
    { id: "D2", name: "Alan", kind: "dm", unread: true },
  ];
  const hidden = new Set(["C1", "C3", "D1", "D2"]);
  const groups = sidebarGroups(all, sections, hidden, "C3");
  expect(groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
    ["start", []],
    ["channels", ["C2", "C3"]],
    ["direct", ["D2"]],
    ["hidden", ["C1", "D1"]],
  ]);
});

test("reads a stored hidden list", () => {
  expect(decodeHidden('["C1", 2, "D1"]')).toEqual(["C1", "D1"]);
  expect(decodeHidden("{}")).toBe(null);
  expect(decodeHidden(null)).toBe(null);
});
