import type { RouteContext } from "./context";
import { turnRevertService } from "../turn-revert";
import { turnCheckpointRef } from "../turn-workspace-checkpoint";

export async function handleTurnCheckpointRoutes(
  { req, url, path }: RouteContext,
  service = turnRevertService,
): Promise<Response | undefined> {
  const match = path.match(
    /^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/checkpoint$/,
  );
  if (!match) return undefined;
  let sessionId: string;
  let turnId: string;
  try {
    sessionId = decodeURIComponent(match[1]!);
    turnId = decodeURIComponent(match[2]!);
    turnCheckpointRef(sessionId, turnId, "before");
  } catch {
    return Response.json({ error: "Invalid turn" }, { status: 400 });
  }
  try {
    if (req.method === "GET")
      return Response.json(
        url.searchParams.get("undo") === "true"
          ? await service.previewUndo(sessionId)
          : await service.preview(sessionId, turnId),
        { headers: { "Cache-Control": "private, no-store" } },
      );
    if (req.method !== "POST")
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    let body: { action?: unknown; expectedTree?: unknown };
    try {
      const value: unknown = await req.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid checkpoint body");
      body = value;
    } catch {
      return Response.json(
        { error: "Invalid checkpoint body" },
        { status: 400 },
      );
    }
    if (body.action === "discard") {
      await service.discard(sessionId);
    } else {
      if (
        typeof body.expectedTree !== "string" ||
        !/^[a-f0-9]{40,64}$/.test(body.expectedTree)
      )
        return Response.json(
          { error: "Review the restore preview first" },
          { status: 400 },
        );
      if (body.action === "revert")
        await service.revert(sessionId, turnId, body.expectedTree);
      else if (body.action === "undo")
        await service.undo(sessionId, body.expectedTree);
      else
        return Response.json(
          { error: "Invalid checkpoint action" },
          { status: 400 },
        );
    }
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Workspace revert failed",
      },
      { status: 409 },
    );
  }
}
