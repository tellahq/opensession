import { describe, expect, test } from "bun:test";
import {
  conversationKind,
  groupMessageName,
  isUnread,
  visibleConversations,
  type SlackConversation,
} from "./conversations";

describe("Slack conversations for the Channels place", () => {
  test("names a group message after its people", () => {
    expect(groupMessageName("mpdm-ada--grace--kent-1")).toBe(
      "ada, grace, kent",
    );
  });

  test("tells the kinds apart", () => {
    expect(conversationKind({ is_im: true })).toBe("dm");
    expect(conversationKind({ is_mpim: true, is_private: true })).toBe("group");
    expect(conversationKind({ is_private: true })).toBe("private");
    expect(conversationKind({})).toBe("channel");
  });

  test("a channel is unread past its read cursor, a DM by its count", () => {
    const at = 0;
    expect(
      isUnread("channel", { at, lastRead: "10.0", latestTs: "11.0" }),
    ).toBe(true);
    expect(
      isUnread("channel", { at, lastRead: "11.0", latestTs: "11.0" }),
    ).toBe(false);
    expect(isUnread("dm", { at, unreadCount: 2, latestTs: "1.0" })).toBe(true);
    expect(isUnread("dm", { at, unreadCount: 0, latestTs: "9.0" })).toBe(false);
    expect(isUnread("channel", undefined)).toBeUndefined();
  });

  test("lists channels by name, then recent or open DMs newest first", () => {
    const now = 1_800_000_000 * 1000;
    const rows: SlackConversation[] = [
      { id: "C2", name: "zeta", kind: "channel" },
      { id: "C1", name: "alpha", kind: "private" },
      { id: "D1", name: "Ada", kind: "dm" },
      { id: "D2", name: "Grace", kind: "dm" },
      { id: "D3", name: "Old", kind: "dm" },
      { id: "D4", name: "Unknown", kind: "dm" },
    ];
    const states = new Map([
      ["D1", { at: 0, latestTs: String(1_800_000_000 - 3600) }],
      ["D2", { at: 0, latestTs: String(1_800_000_000 - 60), unreadCount: 1 }],
      ["D3", { at: 0, latestTs: "1.0", isOpen: false }],
    ]);
    const shown = visibleConversations(rows, states, now);
    expect(shown.map((row) => row.id)).toEqual(["C1", "C2", "D2", "D1"]);
    expect(shown.find((row) => row.id === "D2")?.unreadCount).toBe(1);
  });
});
