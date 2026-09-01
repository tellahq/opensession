/**
 * Session team notes HTTP surface (see src/server/session-notes.ts for the
 * store): list a session's notes, and post one.
 *
 * Registered BEFORE handleSessionsRoutes in routes/index.ts, like the assets
 * and git surfaces: the /notes suffix lives inside the /api/sessions/:id path
 * family, and the generic session routes must never swallow it.
 */

import { requestUser, type RouteContext } from "./context";
import {
  addSessionNote,
  deleteSessionNote,
  editSessionNote,
  isValidNoteSession,
  listSessionNotes,
  sessionNoteActivity,
} from "../session-notes";
import { notifyMentions } from "../mentions";
import { broadcastToAll } from "../ws-hub";
import { removeStagedImages, stageInlineImages } from "../uploads";

export async function handleSessionNotesRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;

  // Latest note per session — what an unread indicator keys off.
  if (path === "/api/session-notes/activity" && req.method === "GET")
    return Response.json({ sessions: sessionNoteActivity() });

  // One note: PATCH edits it, DELETE removes it — author-only, enforced in
  // the store. Matched BEFORE the collection route below, which would
  // otherwise not match anyway, but keeping the specific path first is the
  // habit this file's ordering depends on.
  const oneMatch = path.match(/^\/api\/sessions\/([^/]+)\/notes\/([^/]+)$/);
  if (oneMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const sessionId = decodeURIComponent(oneMatch[1]!);
    if (!isValidNoteSession(sessionId))
      return Response.json({ error: "invalid session" }, { status: 400 });
    return handleNoteMutation(ctx, sessionId, decodeURIComponent(oneMatch[2]!));
  }

  const match = path.match(/^\/api\/sessions\/([^/]+)\/notes$/);
  if (!match) return undefined;
  const sessionId = decodeURIComponent(match[1]!);
  if (!isValidNoteSession(sessionId))
    return Response.json({ error: "invalid session" }, { status: 400 });

  if (req.method === "GET") {
    const limit = Number(url.searchParams.get("limit")) || 200;
    return Response.json({ notes: listSessionNotes(sessionId, limit) });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    const text = typeof body?.text === "string" ? body.text : "";
    if (!user)
      return Response.json({ error: "user required" }, { status: 400 });
    let images: string[];
    try {
      images = stageInlineImages(sessionId, body?.images, "session-notes");
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "invalid images" },
        { status: 400 },
      );
    }
    if (!text.trim() && images.length === 0)
      return Response.json(
        { error: "user and note content required" },
        { status: 400 },
      );
    let note;
    try {
      note = addSessionNote(sessionId, user, text, images);
    } catch (error) {
      removeStagedImages(images);
      throw error;
    }
    if (!note) {
      removeStagedImages(images);
      return Response.json(
        { error: "user and note content required" },
        { status: 400 },
      );
    }
    // Everyone gets it live: clients watching this session render it, and
    // the rest can use the same event for an unread indicator.
    broadcastToAll({ type: "session_note", sessionId, note });
    // @-mentions ping the tagged teammate's devices (works app-closed) and
    // leave a durable badge on their sidebar row, which survives a
    // notification they never saw.
    await notifyMentions(note.text, user, sessionId, "note", "a session note");
    return Response.json({ note });
  }

  return undefined;
}

/** PATCH/DELETE on one note. Split out because both share the author gate. */
async function handleNoteMutation(
  ctx: RouteContext,
  sessionId: string,
  noteId: string,
): Promise<Response> {
  const { req } = ctx;
  const body =
    req.method === "PATCH" ? await req.json().catch(() => null) : null;
  const user = requestUser(ctx, body?.user ?? ctx.url.searchParams.get("user"));
  if (!user) return Response.json({ error: "user required" }, { status: 400 });
  const result =
    req.method === "PATCH"
      ? editSessionNote(
          sessionId,
          noteId,
          typeof body?.text === "string" ? body.text : "",
          user,
        )
      : deleteSessionNote(sessionId, noteId, user);
  if (!result.ok)
    return Response.json(
      {
        error:
          result.reason === "not_author"
            ? "only the author can change a note"
            : "note not found",
      },
      { status: result.reason === "not_author" ? 403 : 404 },
    );
  broadcastToAll(
    req.method === "PATCH"
      ? { type: "session_note", sessionId, note: result.note }
      : { type: "session_note_deleted", sessionId, noteId },
  );
  return Response.json({ note: result.note });
}
