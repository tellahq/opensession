import { expect, test } from "bun:test";
import { FinalReplyText } from "./final-reply";

test("keeps only the text after the last tool call", () => {
  const reply = new FinalReplyText();
  reply.text("Checking the logs.");
  reply.toolUse();
  reply.text("Looking at the flag timeout next.");
  reply.toolUse();
  reply.text("The error was a flag ");
  reply.text("lookup timeout.");
  expect(reply.value).toBe("The error was a flag lookup timeout.");
});

test("falls back to the last stretch of text when the turn ends on a tool", () => {
  const reply = new FinalReplyText();
  reply.text("Narration.");
  reply.toolUse();
  reply.text("The answer.\n");
  reply.toolUse();
  reply.toolUse();
  expect(reply.value).toBe("The answer.");
});

test("is empty for a turn without text", () => {
  const reply = new FinalReplyText();
  reply.toolUse();
  expect(reply.value).toBe("");
});
