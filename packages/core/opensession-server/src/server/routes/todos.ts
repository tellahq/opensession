/**
 * Todos + Desk routes: the Desk overlay's HTTP surface — the per-user todo
 * list (src/server/todos.ts) and the get-or-create standing Desk session
 * (src/server/desk.ts).
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import { clearDesk, ensureDeskSession } from "../desk";
import { buildDeskState } from "../desk-state";
import { findSessionAsync } from "../session-cache";
import { addTodo, listTodos, updateTodo, type TodoStatus } from "../todos";

const STATUSES = new Set(["open", "done", "dropped", "all"]);

export async function handleTodosRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;

  if (path === "/api/todos" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user"));
    const status = url.searchParams.get("status") || "open";
    if (!STATUSES.has(status))
      return Response.json(
        { error: `bad status "${status}"` },
        { status: 400 },
      );
    return Response.json({
      todos: listTodos({
        user: user || undefined,
        status: status as TodoStatus | "all",
      }),
    });
  }

  if (path === "/api/todos" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim())
      return Response.json(
        { error: "expected { text: string }" },
        { status: 400 },
      );
    const user = requestUser(ctx, body.user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    try {
      const todo = addTodo({
        user,
        text: body.text,
        note: typeof body.note === "string" ? body.note : undefined,
        due: typeof body.due === "string" ? body.due : undefined,
        remindAt: typeof body.remindAt === "string" ? body.remindAt : undefined,
        source: { kind: "manual", by: user },
      });
      return Response.json({ todo });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 400 });
    }
  }

  const patchMatch = path.match(/^\/api\/todos\/(todo-[A-Za-z0-9-]+)$/);
  if (patchMatch && req.method === "PATCH") {
    const body = await req.json().catch(() => null);
    if (!body)
      return Response.json({ error: "expected a JSON body" }, { status: 400 });
    if (body.status !== undefined && !STATUSES.has(body.status))
      return Response.json(
        { error: `bad status "${body.status}"` },
        { status: 400 },
      );
    try {
      const todo = updateTodo(
        patchMatch[1],
        {
          status: body.status as TodoStatus | undefined,
          text: typeof body.text === "string" ? body.text : undefined,
          note:
            body.note === null || typeof body.note === "string"
              ? body.note
              : undefined,
          due:
            body.due === null || typeof body.due === "string"
              ? body.due
              : undefined,
          remindAt:
            body.remindAt === null || typeof body.remindAt === "string"
              ? body.remindAt
              : undefined,
        },
        requestUser(ctx, body.user) || undefined,
      );
      return Response.json({ todo });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 400 });
    }
  }

  if (path === "/api/desk/ensure" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    const { sessionId, clearedAt } = ensureDeskSession(user);
    return Response.json({
      sessionId,
      clearedAt: clearedAt ?? null,
      session: (await findSessionAsync(sessionId)) ?? null,
    });
  }

  // The Desk's default screen: the user's own work, bucketed into what's
  // waiting on them, what's running, and what finished unread (desk-state.ts).
  if (path === "/api/desk/state" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user"));
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    return Response.json(buildDeskState(user));
  }

  // Hide the transcript before now in the overlay (display marker only — the full
  // transcript stays in the expanded session view).
  if (path === "/api/desk/clear" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    return Response.json(clearDesk(user));
  }

  return undefined;
}
