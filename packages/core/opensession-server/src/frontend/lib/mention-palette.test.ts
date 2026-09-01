import { describe, expect, test } from "bun:test";
import {
  actionMentionSuggestions,
  groupMentionSuggestions,
  mergeMentionSuggestions,
  mentionCategory,
} from "./mention-palette";

describe("mention palette", () => {
  test("keeps people, tools, workspaces, sessions, actions, and files in palette order", () => {
    const rows = mergeMentionSuggestions(
      [
        { display: "README.md", insert: "README.md" },
        { display: "Slack", insert: "slack", kind: "tool" },
        {
          display: "Release work",
          insert: "workspace:ws-release",
          kind: "workspace",
        },
        {
          display: "Release follow-up",
          insert: "session:os-1",
          kind: "session",
        },
      ],
      [
        { display: "Kent", insert: "Kent", kind: "person" },
        { display: "Add files", insert: "files", kind: "action" },
      ],
    );

    expect(rows.map(mentionCategory)).toEqual([
      "People",
      "Tools",
      "Workspaces",
      "Sessions",
      "Actions",
      "Files",
    ]);
  });

  test("deduplicates local people from fetched results without moving them", () => {
    const rows = mergeMentionSuggestions(
      [{ display: "Kent", insert: "Kent", kind: "person" }],
      [
        { display: "README.md", insert: "README.md" },
        { display: "Kent de Bruin", insert: "Kent", kind: "person" },
      ],
    );

    expect(rows).toEqual([
      { display: "Kent", insert: "Kent", kind: "person" },
      { display: "README.md", insert: "README.md" },
    ]);
  });

  test("groups retain global keyboard indices", () => {
    const groups = groupMentionSuggestions([
      { display: "Kent", insert: "Kent", kind: "person" },
      { display: "Linear", insert: "linear", kind: "tool" },
    ]);

    expect(
      groups.map((group) => [group.category, group.items[0]?.index]),
    ).toEqual([
      ["People", 0],
      ["Tools", 1],
    ]);
  });

  test("actions match labels and keywords", () => {
    const run = () => {};
    expect(
      actionMentionSuggestions("upload", [
        {
          id: "files",
          label: "Add files and folders",
          keywords: ["attach", "upload"],
          run,
        },
        { id: "goal", label: "Set session goal", run },
      ]),
    ).toEqual([
      {
        display: "Add files and folders",
        insert: "files",
        kind: "action",
        sub: undefined,
        action: run,
        icon: undefined,
      },
    ]);
  });
});
