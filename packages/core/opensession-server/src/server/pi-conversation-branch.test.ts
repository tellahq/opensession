import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { branchPiConversationText } from "./pi-conversation-branch";

const engineId = "01900000-0000-7000-8000-000000000001";
const newId = "01900000-0000-7000-8000-000000000002";
const header = {
  type: "session",
  version: 3,
  id: engineId,
  cwd: "/tmp/acme",
  timestamp: "2026-01-01T00:00:00Z",
};
const before = {
  type: "message",
  id: "before",
  parentId: null,
  timestamp: "2026-01-01T00:00:00Z",
  message: { role: "user", content: "Before the target turn", timestamp: 0 },
};
const after = {
  type: "message",
  id: "after",
  parentId: "before",
  timestamp: "2026-01-01T00:00:01Z",
  message: { role: "user", content: "Target turn", timestamp: 1 },
};
const text =
  [header, before, after].map((row) => JSON.stringify(row)).join("\n") + "\n";
test("a durable native branch has the exact earlier context and a different engine id", () => {
  const branched = branchPiConversationText(
    text,
    { engineId, file: "old.jsonl", leafId: "before" },
    newId,
  );
  expect(branched).toContain("Before the target turn");
  expect(branched).not.toContain("Target turn");
  const entries = branched
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const manager = SessionManager.inMemory("/tmp/acme", undefined, entries);
  expect(manager.getSessionId()).toBe(newId);
  expect(manager.getLeafId()).toBe("before");
  expect(manager.buildContextEntries()).toHaveLength(1);
  expect(text).toContain("Target turn");
});
test("rewinding the first turn keeps only the new header", () => {
  const branched = branchPiConversationText(
    text,
    { engineId, file: "old.jsonl", leafId: null },
    newId,
  );
  expect(branched.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(branched).id).toBe(newId);
});
test("unknown native format, wrong engine and missing leaf refuse branching", () => {
  expect(() =>
    branchPiConversationText(
      text,
      { engineId, file: "old.jsonl", leafId: "missing" },
      newId,
    ),
  ).toThrow("entry is missing");
  expect(() =>
    branchPiConversationText(
      text,
      { engineId: "other", file: "old.jsonl", leafId: null },
      newId,
    ),
  ).toThrow("cannot be rewound");
  expect(() =>
    branchPiConversationText(
      text.replace('"version":3', '"version":4'),
      { engineId, file: "old.jsonl", leafId: null },
      newId,
    ),
  ).toThrow("cannot be rewound");
});
