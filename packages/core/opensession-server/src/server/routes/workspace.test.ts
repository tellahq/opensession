import { expect, test } from "bun:test";
import type { RouteContext } from "./context";
import {
  archiveWorkspaceMemberSessions,
  deleteWorkspaceMemberSessions,
} from "./workspace";

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

test("every new-session response carries the workspace PR projection", async () => {
  const source = await Bun.file(
    new URL("./workspace.ts", import.meta.url),
  ).text();
  const route = source.slice(
    source.indexOf("/new-session$/"),
    source.indexOf("/promote$/"),
  );
  // The existing tab and the freshly created one.
  expect(route.match(/await sessionDetail\(/g)).toHaveLength(2);
  expect(route).not.toContain("session: existing }");
  expect(route).not.toContain("session: (await findSessionAsync(bksId))");
});

test("workspace archive sends every member through the session archive route and keeps going past a failure", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const result = await archiveWorkspaceMemberSessions(
    workspaceDeleteContext(),
    ["own", "review/1", "gone", "busy", "worker"],
    async (ctx) => {
      requests.push({
        path: ctx.path,
        method: ctx.req.method,
        body: await ctx.req.json(),
      });
      if (ctx.path.includes("gone"))
        return Response.json({ error: "gone" }, { status: 404 });
      if (ctx.path.includes("busy"))
        return Response.json({ error: "busy" }, { status: 500 });
      return Response.json({ ok: true });
    },
  );

  expect(requests.map((r) => r.path)).toEqual([
    "/api/sessions/own/archive",
    "/api/sessions/review%2F1/archive",
    "/api/sessions/gone/archive",
    "/api/sessions/busy/archive",
    "/api/sessions/worker/archive",
  ]);
  expect(requests.every((r) => r.method === "POST")).toBe(true);
  expect(requests.every((r) => (r.body as any).archived === true)).toBe(true);
  expect(result).toEqual({
    archived: ["own", "review/1", "worker"],
    failed: ["busy"],
  });
});
