import { expect, test } from "bun:test";
import type { SearchResult } from "./api/slack-channels";
import { groupSearchResults } from "./channel-search";

const result = (channelId: string, ts: string): SearchResult => ({
  channelId,
  channelName: channelId,
  isDirect: false,
  message: { ts, userName: "Ada", text: "hi", isBot: false },
});

test("groups results by conversation, in the order the best match came", () => {
  const groups = groupSearchResults([
    result("C2", "3.0"),
    result("C1", "2.0"),
    result("C2", "1.0"),
  ]);
  expect(groups.map((g) => g.channelId)).toEqual(["C2", "C1"]);
  expect(groups[0]!.results.map((r) => r.message.ts)).toEqual(["3.0", "1.0"]);
});
