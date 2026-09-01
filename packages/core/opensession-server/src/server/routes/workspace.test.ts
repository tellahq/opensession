import { expect, test } from "bun:test";
import type { RouteContext } from "./context";
import { deleteWorkspaceMemberSessions } from "./workspace";

function workspaceDeleteContext(): RouteContext {
  const url = new URL("http://localhost/api/workspaces/ws-1?worktree=true");
  return {
    req: new Request(url, { method: "DELETE" }),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
  };
}

test("workspace deletion sends every member through session deletion without worktree cleanup", async () => {
  const requests: RouteContext[] = [];
  const failure = await deleteWorkspaceMemberSessions(
    workspaceDeleteContext(),
    ["session/one", "session two"],
    async (ctx) => {
      requests.push(ctx);
      return Response.json({ ok: true });
    },
  );

  expect(failure).toBeUndefined();
  expect(requests.map((ctx) => ctx.path)).toEqual([
    "/api/sessions/session%2Fone",
    "/api/sessions/session%20two",
  ]);
  expect(requests.every((ctx) => ctx.req.method === "DELETE")).toBe(true);
  expect(requests.every((ctx) => ctx.url.search === "")).toBe(true);
});

test("workspace deletion ignores a raced 404 but stops on another session failure", async () => {
  let calls = 0;
  const failure = await deleteWorkspaceMemberSessions(
    workspaceDeleteContext(),
    ["gone", "busy", "not-reached"],
    async () => {
      calls += 1;
      if (calls === 1) return Response.json({ error: "gone" }, { status: 404 });
      return Response.json({ error: "busy" }, { status: 409 });
    },
  );

  expect(calls).toBe(2);
  expect(failure?.status).toBe(409);
});
