import { expect, test } from "bun:test";
import {
  canonicalCommandPayload,
  sessionIdForRequest,
} from "./session-request-id";

test("create request ids are stable inside an authenticated actor scope", () => {
  expect(sessionIdForRequest("ada", "request")).toBe(
    sessionIdForRequest("ada", "request"),
  );
  expect(sessionIdForRequest("ada", "request")).not.toBe(
    sessionIdForRequest("grace", "request"),
  );
  expect(sessionIdForRequest("ada", "request")).toMatch(/^bks-[0-9a-f-]{36}$/);
});

test("create payload identity ignores object key order", () => {
  expect(
    canonicalCommandPayload({ requestId: "r", prompt: "p", mode: "ask" }),
  ).toBe(canonicalCommandPayload({ mode: "ask", prompt: "p", requestId: "r" }));
});
