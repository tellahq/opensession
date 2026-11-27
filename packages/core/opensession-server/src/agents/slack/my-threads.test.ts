import { expect, test } from "bun:test";
import { searchedMessage, threadCandidates, threadTsOf } from "./my-threads";

test("reads the thread a reply is in off its permalink", () => {
  expect(
    threadTsOf(
      "https://acme.slack.com/archives/C1/p1700000100000200?thread_ts=1700000000.000100&cid=C1",
    ),
  ).toBe("1700000000.000100");
  expect(
    threadTsOf("https://acme.slack.com/archives/C1/p1700000100000200"),
  ).toBe(undefined);
  expect(threadTsOf(undefined)).toBe(undefined);
});

test("a top-level message is not a reply in its own thread", () => {
  const message = searchedMessage({
    channel: { id: "C1", name: "design" },
    ts: "1700000000.000100",
    text: "hi",
    permalink:
      "https://acme.slack.com/archives/C1/p1700000000000100?thread_ts=1700000000.000100",
  });
  expect(message?.threadTs).toBe(undefined);
  expect(searchedMessage({ ts: "1" })).toBe(null);
});

test("lists each thread once, replies before your own top-level posts", () => {
  const sent = [
    { channelId: "C1", channelName: "a", isDirect: false, ts: "5", text: "" },
    {
      channelId: "C1",
      channelName: "a",
      isDirect: false,
      ts: "4",
      threadTs: "1",
      text: "",
    },
    {
      channelId: "C1",
      channelName: "a",
      isDirect: false,
      ts: "3",
      threadTs: "1",
      text: "",
    },
    {
      channelId: "C2",
      channelName: "b",
      isDirect: false,
      ts: "2",
      threadTs: "1",
      text: "",
    },
  ];
  expect(threadCandidates(sent).map((c) => `${c.channelId}:${c.ts}`)).toEqual([
    "C1:1",
    "C2:1",
    "C1:5",
  ]);
});
