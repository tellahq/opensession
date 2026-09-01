/**
 * Goals (long-running, self-pacing missions): CRUD, run-now, pause/resume.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { runGoal, runningGoals } from "../goal-runner";
import {
  createGoal,
  deleteGoal,
  getGoal,
  listGoals,
  resumeGoal,
  updateGoal,
} from "../goals";
import { existsSync, readFileSync } from "fs";

export async function handleGoalsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // ── Goals (long-running, self-pacing missions) ──
  if (path === "/api/goals" && req.method === "GET") {
    const list = listGoals().map((g) => ({
      ...g,
      isRunning: runningGoals.has(g.id),
    }));
    return Response.json(list);
  }

  if (path === "/api/goals" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const result = createGoal(body);
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }

  // Specific sub-routes must precede the bare /:id matcher.
  const goalRunMatch = path.match(/^\/api\/goals\/([^/]+)\/run$/);
  if (goalRunMatch && req.method === "POST") {
    const goal = getGoal(goalRunMatch[1]);
    if (!goal) return Response.json({ error: "Not found" }, { status: 404 });
    if (runningGoals.has(goal.id)) {
      return Response.json({ error: "Already running" }, { status: 409 });
    }
    // Fire a wake now; the session shows up in the list once it boots.
    void runGoal(goal);
    return Response.json({ ok: true });
  }

  const goalResumeMatch = path.match(/^\/api\/goals\/([^/]+)\/resume$/);
  if (goalResumeMatch && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const result = resumeGoal(goalResumeMatch[1], body?.when);
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }

  const goalPauseMatch = path.match(/^\/api\/goals\/([^/]+)\/pause$/);
  if (goalPauseMatch && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const result = updateGoal(goalPauseMatch[1], {
      status: "paused",
      pauseReason: body?.reason?.trim() || "Paused from the UI",
    });
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }

  const goalMatch = path.match(/^\/api\/goals\/([^/]+)$/);
  if (goalMatch && req.method === "GET") {
    const goal = getGoal(goalMatch[1]);
    if (!goal) return Response.json({ error: "Not found" }, { status: 404 });
    let ledger = "";
    try {
      if (existsSync(goal.stateFile))
        ledger = readFileSync(goal.stateFile, "utf-8");
    } catch {}
    return Response.json({
      ...goal,
      ledger,
      isRunning: runningGoals.has(goal.id),
    });
  }

  if (goalMatch && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const result = updateGoal(goalMatch[1], body);
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }

  if (goalMatch && req.method === "DELETE") {
    return deleteGoal(goalMatch[1])
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  return undefined;
}
