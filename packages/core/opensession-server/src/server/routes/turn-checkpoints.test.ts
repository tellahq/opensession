import { expect, test } from "bun:test";
import { handleTurnCheckpointRoutes } from "./turn-checkpoints";
import type { RouteContext } from "./context";
import type { turnRevertService } from "../turn-revert";
const preview: Awaited<ReturnType<typeof turnRevertService.previewUndo>> = {
  patch: "patch",
  restorePatch: "restore",
  files: ["acme.ts"],
  currentTree: "a".repeat(40),
  canRestore: true,
  reason: null,
  canUndo: true,
  interrupted: false,
};
function fixture() {
  const calls: string[] = [];
  const service = {
    recover: async () => {},
    preview: async () => {
      calls.push("preview");
      return preview;
    },
    previewUndo: async () => {
      calls.push("preview_undo");
      return preview;
    },
    revert: async () => {
      calls.push("revert");
    },
    undo: async () => {
      calls.push("undo");
    },
    discard: async () => {
      calls.push("discard");
    },
  };
  return {
    calls,
    service,
    request: (method = "GET", body?: string, suffix = "") => {
      const req = new Request(
        `http://example.test/api/sessions/os-acme/turns/turn-1/checkpoint${suffix}`,
        {
          method,
          ...(body !== undefined
            ? { body, headers: { "Content-Type": "application/json" } }
            : {}),
        },
      );
      const url = new URL(req.url);
      return handleTurnCheckpointRoutes(
        { req, url, path: url.pathname } as RouteContext,
        service,
      );
    },
  };
}
test("checkpoint previews and every mutation use the shared service", async () => {
  const f = fixture();
  const response = (await f.request())!;
  expect(await response.json()).toEqual(preview);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  await f.request("GET", undefined, "?undo=true");
  for (const action of ["revert", "undo", "discard"])
    expect(
      (await f.request(
        "POST",
        JSON.stringify({ action, expectedTree: preview.currentTree }),
      ))!.status,
    ).toBe(200);
  expect(f.calls).toEqual([
    "preview",
    "preview_undo",
    "revert",
    "undo",
    "discard",
  ]);
});
test("invalid bodies, actions, methods and unsafe ids cannot reach mutation", async () => {
  const f = fixture();
  for (const body of [
    "null",
    "[1]",
    "{",
    '{"action":"revert"}',
    '{"action":"unknown","expectedTree":"' + preview.currentTree + '"}',
  ])
    expect((await f.request("POST", body))!.status).toBe(400);
  expect((await f.request("DELETE"))!.status).toBe(405);
  const req = new Request(
    "http://example.test/api/sessions/os-acme/turns/%ff/checkpoint",
  );
  const url = new URL(req.url);
  expect(
    (await handleTurnCheckpointRoutes(
      { req, url, path: url.pathname } as RouteContext,
      f.service,
    ))!.status,
  ).toBe(400);
  expect(f.calls).toEqual([]);
});
test("service refusal is visible and never reported as successful restore", async () => {
  const f = fixture();
  f.service.revert = async () => {
    throw new Error("A sibling is active");
  };
  const response = (await f.request(
    "POST",
    JSON.stringify({ action: "revert", expectedTree: preview.currentTree }),
  ))!;
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "A sibling is active" });
});
