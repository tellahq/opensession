import { describe, expect, test } from "bun:test";
import {
  applyToggleReaction,
  cleanAnchor,
  cleanReactions,
} from "./comment-threads";

describe("message reactions", () => {
  test("a second toggle by the same person takes the reaction back", () => {
    const once = applyToggleReaction({}, "e1", "👍", "Ada");
    expect(once).toEqual({ e1: { "👍": ["Ada"] } });
    const both = applyToggleReaction(once!, "e1", "👍", "Grace");
    expect(both).toEqual({ e1: { "👍": ["Ada", "Grace"] } });
    expect(applyToggleReaction(both!, "e1", "👍", "ada")).toEqual({
      e1: { "👍": ["Grace"] },
    });
    expect(applyToggleReaction(once!, "e1", "👍", "Ada")).toEqual({});
  });

  test("only the offered emoji are accepted", () => {
    expect(applyToggleReaction({}, "e1", "💩", "Ada")).toBeNull();
    expect(
      cleanReactions({
        reactions: { e1: { "💩": ["Ada"], "🎉": ["Ada", 3] } },
      }),
    ).toEqual({ e1: { "🎉": ["Ada"] } });
  });

  test("reads an old document without reactions as none", () => {
    expect(cleanReactions({ threads: [] })).toEqual({});
    expect(cleanReactions(null)).toEqual({});
  });
});

describe("whole-message anchors", () => {
  test("keep whole and the message's author", () => {
    expect(
      cleanAnchor({
        entryId: "e1",
        exact: "Ship it",
        whole: true,
        by: " Ada ",
      }),
    ).toEqual({
      entryId: "e1",
      exact: "Ship it",
      prefix: "",
      suffix: "",
      whole: true,
      by: "Ada",
    });
  });

  test("a passage anchor carries no author", () => {
    expect(cleanAnchor({ entryId: "e1", exact: "it", by: "Ada" })).toEqual({
      entryId: "e1",
      exact: "it",
      prefix: "",
      suffix: "",
    });
  });
});
