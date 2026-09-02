import { expect, test } from "bun:test";
import {
  registerTranscriptVirtualNavigation,
  scrollToVirtualTranscriptEntry,
} from "./transcript-virtual-navigation";

test("virtual transcript navigation is scoped to one scroll container", () => {
  const first: HTMLElement = Object.create(null);
  const second: HTMLElement = Object.create(null);
  const seen: string[] = [];
  const unregister = registerTranscriptVirtualNavigation(first, {
    scrollToEntry(entryId) {
      seen.push(entryId);
      return true;
    },
  });

  expect(scrollToVirtualTranscriptEntry(first, "message-1")).toBe(true);
  expect(scrollToVirtualTranscriptEntry(second, "message-1")).toBe(false);
  expect(seen).toEqual(["message-1"]);

  unregister();
  expect(scrollToVirtualTranscriptEntry(first, "message-2")).toBe(false);
});
