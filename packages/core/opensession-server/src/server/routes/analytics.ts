/**
 * Analytics route: the Analytics view's aggregated numbers (sessions, tokens,
 * models, PRs) over a date range. Read-only over the audit log, session store
 * and gh — see src/server/analytics.ts.
 */

import type { RouteContext } from "./context";
import { buildHomeStats, getAnalytics } from "../analytics";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function handleAnalyticsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;
  if (req.method !== "GET") return undefined;
  // Compact today/7d numbers for the Home overview strip.
  if (path === "/api/analytics/home")
    return Response.json(await buildHomeStats());
  if (path !== "/api/analytics") return undefined;

  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 29 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const from = url.searchParams.get("from") || defaultFrom;
  const to = url.searchParams.get("to") || today;
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    return Response.json({ error: "invalid date range" }, { status: 400 });
  }
  // Hard cap: a year of day rollups per request is plenty.
  if (utcDays(from, to) > 366) {
    return Response.json(
      { error: "range too large (max 366 days)" },
      { status: 400 },
    );
  }
  // Served through the stale-while-revalidate summary cache — see analytics.ts.
  return Response.json(await getAnalytics(from, to > today ? today : to));
}

function utcDays(from: string, to: string): number {
  return (
    Math.round(
      (new Date(`${to}T00:00:00Z`).getTime() -
        new Date(`${from}T00:00:00Z`).getTime()) /
        86_400_000,
    ) + 1
  );
}
