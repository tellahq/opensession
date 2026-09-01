/**
 * Reports routes: the Reports view's list/history/raw-HTML surface over the
 * reports store (src/server/reports.ts), plus the one write — starting a
 * session per task. Publishing itself happens through the opensession-report
 * MCP tool inside automation runs, never over HTTP.
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import {
  listReportGroups,
  listReports,
  listReportsForSession,
  readReportAsset,
  readReportHtml,
} from "../reports";
import { adaptReportHtml } from "../report-theme";
import { assetMime } from "../session-assets";
import {
  fanOutPrompt,
  ReportSessionsError,
  startReportSessions,
} from "../report-sessions";

export { fanOutPrompt };

export async function handleReportsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  // Start one session per selected task, each in its own workspace on its own
  // isolated worktree. Sequential on purpose: every create takes the repo's
  // git lock to add a worktree, and a caller who just asked for twenty of
  // them gets a stampede otherwise. Partial failure is reported per task
  // rather than failing the batch — nineteen started sessions should not be
  // thrown away because one branch name collided.
  const fanOut = path.match(/^\/api\/reports\/([^/]+)\/([^/]+)\/sessions$/);
  if (fanOut && req.method === "POST") {
    const automationId = decodeURIComponent(fanOut[1]);
    const reportId = decodeURIComponent(fanOut[2]);
    const body = (await req.json().catch(() => null)) as {
      tasks?: unknown;
      user?: unknown;
    } | null;
    const tasks = Array.isArray(body?.tasks)
      ? body.tasks.filter((index): index is number => Number.isInteger(index))
      : undefined;
    try {
      const sessions = await startReportSessions({
        automationId,
        reportId,
        tasks,
        user: requestUser(ctx, body?.user),
      });
      return Response.json({ sessions });
    } catch (error) {
      if (error instanceof ReportSessionsError)
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      throw error;
    }
  }

  if (req.method !== "GET") return undefined;

  // One row per automation that has published reports (latest + count).
  if (path === "/api/reports") {
    return Response.json({ groups: listReportGroups() });
  }

  // The reports published by one run, powering its right-sidebar Reports tab.
  const sessionMatch = path.match(/^\/api\/reports\/session\/([^/]+)$/);
  if (sessionMatch) {
    return Response.json({
      reports: listReportsForSession(decodeURIComponent(sessionMatch[1])),
    });
  }

  // The rendered report itself — served as a document for the detail iframe.
  // `sandbox` keeps agent-authored HTML inert (no scripts, no top navigation)
  // while allow-same-origin lets it be styled/read normally.
  //
  // `?theme=dark` asks for the document in the app's dark scheme. Because the
  // report cannot run scripts, that has to happen here: adaptReportHtml
  // (src/server/report-theme.ts) serves it already dark rather than letting a
  // white page paint first and be corrected afterwards. Without the parameter
  // the response is the document as the agent published it.
  const rawMatch = path.match(/^\/api\/reports\/([^/]+)\/([^/]+)\/raw$/);
  if (rawMatch) {
    const stored = readReportHtml(
      decodeURIComponent(rawMatch[1]),
      decodeURIComponent(rawMatch[2]),
    );
    if (stored === null)
      return new Response("Report not found", { status: 404 });
    const html = adaptReportHtml(
      stored,
      ctx.url.searchParams.get("theme") === "dark" ? "dark" : "light",
    );
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "sandbox allow-same-origin",
      },
    });
  }

  // Durable files referenced by report HTML as assets/<path>.
  const assetMatch = path.match(
    /^\/api\/reports\/([^/]+)\/([^/]+)\/assets\/(.+)$/,
  );
  if (assetMatch) {
    const asset = readReportAsset(
      decodeURIComponent(assetMatch[1]),
      decodeURIComponent(assetMatch[2]),
      decodeURIComponent(assetMatch[3]),
    );
    if (!asset) return new Response("Report asset not found", { status: 404 });
    const file = Bun.file(asset.path);
    return new Response(file, {
      headers: {
        "Content-Type": assetMime(asset.rel),
        "Content-Length": String(file.size),
        "Cache-Control": "no-store",
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // A group's history, newest first.
  const groupMatch = path.match(/^\/api\/reports\/([^/]+)$/);
  if (groupMatch) {
    return Response.json({
      reports: listReports(decodeURIComponent(groupMatch[1])),
    });
  }

  return undefined;
}
