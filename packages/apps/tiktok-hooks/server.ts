/**
 * Dashboard for the TikTok hooks store. Reads the SQLite file that hooks.py
 * writes, serves the opening frames, and lets a person override a hook's kind.
 * Published on Open Session via publish_app; the /d/<name> prefix is stripped.
 */
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;

type HookRow = {
  id: string;
  url: string;
  creator: string;
  title: string;
  hook: string;
  transcript: string;
  language: string | null;
  kind: string | null;
  kind_reason: string | null;
  source: string;
  saved_at: string;
};

type FailureRow = {
  id: string;
  url: string;
  error: string;
  attempts: number;
  last_attempt_at: string;
};

type DashboardOptions = { homeDir?: string; port?: number };

async function createDashboard({
  homeDir = process.env.TIKTOK_HOOKS_HOME ??
    join(homedir(), ".local/share/tiktok-hooks"),
  port = Number(process.env.PORT || 3000),
}: DashboardOptions) {
  const kinds: Record<string, { label: string }> = await Bun.file(
    join(root, "kinds.json"),
  ).json();

  const schema = await Bun.file(join(root, "schema.sql")).text();

  await mkdir(homeDir, { recursive: true });

  const db = new Database(join(homeDir, "hooks.sqlite"), { create: true });

  db.run("PRAGMA journal_mode=WAL");

  db.run(schema);

  const listHooks = db.query<HookRow, []>(
    `SELECT id, url, creator, title, hook, transcript, language, kind, kind_reason, source, saved_at
   FROM hooks ORDER BY saved_at DESC`,
  );

  const setKind = db.query(
    `UPDATE hooks SET kind = $kind, kind_reason = $reason, classified_at = $at WHERE id = $id`,
  );

  const listFailures = db.query<FailureRow, []>(
    `SELECT id, url, error, attempts, last_attempt_at FROM failures ORDER BY last_attempt_at DESC`,
  );

  type ApiPayload =
    | { kinds: typeof kinds; hooks: HookRow[]; failures: FailureRow[] }
    | { id: string; kind: string }
    | { error: string };

  const json = (payload: ApiPayload, status = 200) =>
    Response.json(payload, {
      status,
      headers: { "cache-control": "no-store" },
    });

  type KindPatch = { kind: string };

  async function parseKindPatch(request: Request): Promise<KindPatch | null> {
    const body: unknown = await request.json().catch(() => null);

    if (typeof body !== "object" || body === null || !("kind" in body))
      return null;

    const kind = body.kind;

    return typeof kind === "string" && Object.hasOwn(kinds, kind)
      ? { kind }
      : null;
  }

  async function patchKind(id: string, request: Request): Promise<Response> {
    const patch = await parseKindPatch(request);

    if (!patch) return json({ error: "unknown kind" }, 400);

    const changed = setKind.run({
      $kind: patch.kind,
      $reason: "Set by hand in the dashboard",
      $at: new Date().toISOString(),
      $id: id,
    }).changes;

    return changed
      ? json({ id, kind: patch.kind })
      : json({ error: "no such hook" }, 404);
  }

  async function serveFrame(id: string): Promise<Response> {
    const frame = Bun.file(join(homeDir, "frames", `${id}.jpg`));

    if (!(await frame.exists()))
      return new Response("no frame", { status: 404 });

    return new Response(frame, {
      headers: { "cache-control": "public, max-age=86400" },
    });
  }

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/d\/[^/]+/, "") || "/";

      if (path === "/" || path === "/index.html") {
        return new Response(Bun.file(join(root, "index.html")), {
          headers: { "cache-control": "no-store" },
        });
      }

      if (path === "/api/hooks" && request.method === "GET") {
        return json({
          kinds,
          hooks: listHooks.all(),
          failures: listFailures.all(),
        });
      }

      const kindMatch = path.match(/^\/api\/hooks\/(\d+)$/);

      if (kindMatch && request.method === "PATCH")
        return patchKind(kindMatch[1], request);

      const frameMatch = path.match(/^\/frames\/(\d+)\.jpg$/);

      if (frameMatch) return serveFrame(frameMatch[1]);

      return new Response("not found", { status: 404 });
    },
  });

  return {
    server,
    close() {
      server.stop(true);
      db.close();
      dashboard = undefined;
    },
  };
}

let dashboard: ReturnType<typeof createDashboard> | undefined;

export function startDashboard(options: DashboardOptions = {}) {
  return (dashboard ??= createDashboard(options).catch((error: unknown) => {
    dashboard = undefined;
    throw error;
  }));
}

if (import.meta.main) await startDashboard();
