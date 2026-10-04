import { readRequestTextWithinLimit } from "../shared/bounded-body";
import { agentResources } from "../agent-resources";
import { getSessionControl } from "../session-control";
import { requestUser, type RouteContext } from "./context";

export async function handleAgentResourceRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { path, req } = ctx;
  if (path === "/api/agent-resources/history" && req.method === "GET")
    return Response.json({ samples: agentResources.history.values() });
  if (path === "/api/agent-resources/stop" && req.method === "POST") {
    if (
      ctx.authUser &&
      "automation" in ctx.authUser &&
      ctx.authUser.automation === true
    )
      return Response.json(
        { error: "Only a person can stop a session here" },
        { status: 403 },
      );
    let body: { user?: unknown; sessionId?: unknown } | null;
    try {
      body = JSON.parse(await readRequestTextWithinLimit(req, 4096));
    } catch {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }
    if (!requestUser(ctx, body?.user))
      return Response.json(
        { error: "Only a person can stop a session here" },
        { status: 403 },
      );
    if (typeof body?.sessionId !== "string" || body.sessionId.length > 200)
      return Response.json({ error: "Session required" }, { status: 400 });
    return Response.json({
      ok: await getSessionControl().cancelSession(body.sessionId),
    });
  }
  if (path !== "/api/agent-resources/events" || req.method !== "GET") return;
  let cleanup = () => {};
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false;
      let unsubscribe = () => {};
      const abort = () => {
        if (ended) return;
        ended = true;
        unsubscribe();
        req.signal.removeEventListener("abort", abort);
        try {
          controller.close();
        } catch {}
      };
      cleanup = abort;
      unsubscribe = agentResources.subscribe((event) => {
        if (ended) return;
        // Slow consumers are disconnected rather than retaining an unbounded queue.
        if ((controller.desiredSize ?? 0) <= 0) {
          abort();
          return;
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      });
      req.signal.addEventListener("abort", abort, { once: true });
      if (req.signal.aborted) abort();
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
