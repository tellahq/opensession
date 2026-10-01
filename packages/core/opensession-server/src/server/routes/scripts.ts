/**
 * A session's script runs (script-runs.ts), for the cards in the session.
 *
 *   GET  /api/scripts?sessionId=           -> { runs }
 *   GET  /api/scripts/:id?sessionId=       -> { run } with the output tail
 *   POST /api/scripts/:id/stop             { sessionId }
 */
import type { RouteContext } from "./context";
import { readRequestTextWithinLimit } from "../shared/bounded-body";
import {
  listScriptRuns,
  readLogTail,
  getScriptRun,
  stopScriptRun,
  summarizeScriptRun,
} from "../script-runs";

/** Enough to follow a run in the card without shipping the whole log. */
const CARD_TAIL_BYTES = 16 * 1024;

const reply = (data: object, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function handleScriptRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { path, req } = ctx;
  if (path !== "/api/scripts" && !path.startsWith("/api/scripts/"))
    return undefined;
  if (path === "/api/scripts" && req.method === "GET") {
    const sessionId = ctx.url.searchParams.get("sessionId") || "";
    return reply({ runs: sessionId ? await listScriptRuns(sessionId) : [] });
  }
  const match = path.match(/^\/api\/scripts\/(sr-[a-f0-9-]{36})(\/stop)?$/);
  if (!match) return reply({ error: "Not found" }, 404);
  const id = match[1]!;

  if (!match[2] && req.method === "GET") {
    const run = await getScriptRun(
      id,
      ctx.url.searchParams.get("sessionId") || "",
    );
    if (!run) return reply({ error: "Not found" }, 404);
    return reply({
      run: {
        ...summarizeScriptRun(run),
        outputTail: await readLogTail(run.logPath, CARD_TAIL_BYTES),
      },
    });
  }

  if (match[2] && req.method === "POST") {
    const identity = ctx.authUser as
      | { automation?: boolean }
      | null
      | undefined;
    if (identity?.automation === true)
      return reply({ error: "Only a person can stop a script here" }, 403);
    let body: { sessionId?: unknown };
    try {
      body = JSON.parse(await readRequestTextWithinLimit(req, 4 * 1024));
    } catch {
      return reply({ error: "Invalid request" }, 400);
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const result = await stopScriptRun(id, sessionId);
    if ("error" in result) return reply({ error: result.error }, 409);
    return reply({ run: result.run });
  }
  return reply({ error: "Not found" }, 404);
}
