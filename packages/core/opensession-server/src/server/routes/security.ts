/**
 * Security scans (deepsec) and scan profiles.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import { createAutomation } from "../automations";
import {
  buildInteractivePrompt,
  buildScanPrompt,
  createProfile,
  createScanRecord,
  deleteProfile,
  deleteScan,
  executeScan,
  getProfile,
  listProfiles,
  listScans,
  scannableRepos,
  updateProfile,
} from "../security";
import { invalidateSessionsCache } from "../session-cache";
import { getSessionControl } from "../session-control";
import { getRepo } from "../worktree";

export async function handleSecurityRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // ── Security (deepsec scans + profiles) ──
  if (path === "/api/security" && req.method === "GET") {
    return Response.json({
      scans: listScans(),
      profiles: listProfiles(),
      repos: scannableRepos().map((r) => ({
        id: r.id,
        defaultBranch: r.defaultBranch,
      })),
    });
  }

  if (path === "/api/security/scans" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const allIds = scannableRepos().map((r) => r.id);
    const repos: string[] =
      body.repos === "all"
        ? allIds
        : Array.isArray(body.repos)
          ? body.repos.filter(
              (r: unknown): r is string =>
                typeof r === "string" && allIds.includes(r),
            )
          : [];
    if (!repos.length)
      return Response.json(
        { error: "Pick at least one repository" },
        { status: 400 },
      );
    const createdBy =
      typeof body.createdBy === "string" && body.createdBy.trim()
        ? body.createdBy.trim()
        : "Anonymous";
    const profile =
      typeof body.profileId === "string" && body.profileId
        ? getProfile(body.profileId)
        : null;
    const instructions =
      typeof body.instructions === "string" ? body.instructions : undefined;
    const recurrence =
      body.recurrence === "daily" || body.recurrence === "weekly"
        ? body.recurrence
        : null;

    // Recurring scans become repo-scoped automations (single source of
    // scheduling truth).
    if (recurrence) {
      if (repos.length !== 1)
        return Response.json(
          { error: "Recurring scans support one repository at a time" },
          { status: 400 },
        );
      const result = createAutomation({
        name: `deepsec ${recurrence} scan — ${profile?.name || "custom"}`,
        prompt: buildScanPrompt(getRepo(repos[0]), profile, instructions),
        schedule: recurrence === "daily" ? "0 13 * * *" : "0 8 * * 0",
        mode: "code",
        repo: repos[0],
        createdBy,
        mcpServers: [],
      });
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json({ automation: result });
    }

    // Interactive: one repo-scoped collaborative session that tailors the
    // threat model with the user before scanning.
    if (body.interactive) {
      if (repos.length !== 1)
        return Response.json(
          { error: "Interactive scans support one repository at a time" },
          { status: 400 },
        );
      const branch = `deepsec-interactive-${new Date()
        .toISOString()
        .slice(0, 16)
        .replace(/[-T:]/g, "")}`;
      const { id } = await getSessionControl().createSession({
        prompt: buildInteractivePrompt(
          getRepo(repos[0]),
          profile,
          instructions,
        ),
        branch,
        mode: "code",
        repo: repos[0],
        user: createdBy,
      });
      const scan = createScanRecord({
        repos,
        profileId: profile?.id,
        instructions,
        interactive: true,
        createdBy,
        sessionId: id,
      });
      return Response.json({ scan, sessionId: id });
    }

    const scan = createScanRecord({
      repos,
      profileId: profile?.id,
      instructions,
      createdBy,
    });
    void executeScan(scan, {
      onSessionCreated: () => {
        invalidateSessionsCache();
      },
    });
    return Response.json({ scan });
  }

  const scanMatch = path.match(/^\/api\/security\/scans\/([^/]+)$/);
  if (scanMatch && req.method === "DELETE") {
    return deleteScan(scanMatch[1])
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  if (path === "/api/security/profiles" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const result = createProfile(body);
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }

  const profileMatch = path.match(/^\/api\/security\/profiles\/([^/]+)$/);
  if (profileMatch && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const result = updateProfile(profileMatch[1], body);
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result);
  }

  if (profileMatch && req.method === "DELETE") {
    return deleteProfile(profileMatch[1])
      ? Response.json({ ok: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  return undefined;
}
