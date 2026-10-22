import { expect, test } from "bun:test";
import { linkedMessageId, messageLinkHash } from "./message-link";

test("a message hash round-trips any entry id", () => {
  for (const id of ["entry-1", "a/b#c d", "0194f0e2-7c1a"])
    expect(linkedMessageId(messageLinkHash(id))).toBe(id);
});

test("other hashes name no message", () => {
  expect(linkedMessageId("")).toBeNull();
  expect(linkedMessageId("#section")).toBeNull();
  expect(linkedMessageId("#message-")).toBeNull();
  expect(linkedMessageId("#message-%E0%A4%A")).toBeNull();
});
