/**
 * Comment threads HTTP surface (store: src/server/comment-threads.ts; side
 * effects: src/server/comment-thread-service.ts).
 *
 *   GET    /api/sessions/:id/threads
 *   POST   /api/sessions/:id/threads                     start a thread
 *   PATCH  /api/sessions/:id/threads/:tid                resolve, reopen, assign
 *   POST   /api/sessions/:id/threads/:tid/comments       reply
 *   PATCH  /api/sessions/:id/threads/:tid/comments/:cid  edit your comment
 *   DELETE /api/sessions/:id/threads/:tid/comments/:cid  delete your comment
 *   POST   /api/sessions/:id/threads/:tid/agent          ask the agent to answer
 *   POST   /api/sessions/:id/threads/:tid/seen           read receipt
 *
 * The /notes routes are the old team-notes API, kept for clients that still
 * speak it: a note is the opening comment of a session-level thread.
 *
 * Registered BEFORE handleSessionsRoutes in routes/index.ts: these suffixes
 * live inside the /api/sessions/:id path family.
 */

import { requestUser, type RouteContext } from "./context";
import {
  cleanAnchor,
  isValidThreadSession,
  listThreads,
  type CommentThread,
  type ThreadFailure,
} from "../comment-threads";
import {
  addComment,
  createThread,
  deleteComment,
  editComment,
  markThreadSeen,
  updateThread,
} from "../comment-thread-service";
import { removeStagedImages, stageInlineImages } from "../uploads";

const FAILURE: Record<ThreadFailure, { status: number; error: string }> = {
  not_found: { status: 404, error: "comment not found" },
  not_author: { status: 403, error: "only the author can change a comment" },
  empty: { status: 400, error: "comment text required" },
  too_many: { status: 409, error: "this session has too many comments" },
  too_large: { status: 409, error: "this session's comments are full" },
};

function failure(reason: ThreadFailure): Response {
  const { status, error } = FAILURE[reason];
  return Response.json({ error }, { status });
}

function invalidSession(): Response {
  return Response.json({ error: "invalid session" }, { status: 400 });
}

async function stageImages(
  sessionId: string,
  images: unknown,
): Promise<string[] | Response> {
  try {
    return await stageInlineImages(sessionId, images, "session-notes");
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "invalid images" },
      { status: 400 },
    );
  }
}

function asNote(thread: CommentThread) {
  const root = thread.comments[0]!;
  return {
    id: thread.id,
    user: root.user,
    text: root.text,
    ...(root.images ? { images: root.images } : {}),
    ts: root.ts,
    ...(root.editedAt ? { editedAt: root.editedAt } : {}),
  };
}

export async function handleCommentThreadRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { path } = ctx;
  if (!path.startsWith("/api/sessions/")) return undefined;
  const match = path.match(
    /^\/api\/sessions\/([^/]+)\/(threads|notes)(?:\/([^/]+))?(?:\/(comments|agent|seen))?(?:\/([^/]+))?$/,
  );
  if (!match) return undefined;
  const sessionId = decodeURIComponent(match[1]!);
  if (!isValidThreadSession(sessionId)) return invalidSession();
  const threadId = match[3] ? decodeURIComponent(match[3]) : undefined;
  const sub = match[4] as ThreadSub | undefined;
  const commentId = match[5] ? decodeURIComponent(match[5]) : undefined;
  if (match[2] === "notes")
    return sub || commentId
      ? undefined
      : handleLegacyNotes(ctx, sessionId, threadId);
  return handleThreads(ctx, sessionId, threadId, sub, commentId);
}

type ThreadSub = "comments" | "agent" | "seen";

async function handleThreads(
  ctx: RouteContext,
  sessionId: string,
  threadId: string | undefined,
  sub: ThreadSub | undefined,
  commentId: string | undefined,
): Promise<Response | undefined> {
  const { req } = ctx;

  if (!threadId) {
    if (req.method === "GET")
      return Response.json({ threads: await listThreads(sessionId) });
    if (req.method !== "POST") return undefined;
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user)
      return Response.json({ error: "user required" }, { status: 400 });
    const anchor = body?.anchor === undefined ? null : cleanAnchor(body.anchor);
    if (body?.anchor !== undefined && !anchor)
      return Response.json({ error: "invalid anchor" }, { status: 400 });
    const images = await stageImages(sessionId, body?.images);
    if (images instanceof Response) return images;
    const result = await createThread({
      sessionId,
      user,
      text: typeof body?.text === "string" ? body.text : "",
      images,
      anchor,
      assignee: typeof body?.assignee === "string" ? body.assignee : null,
    }).catch(async (error) => {
      await removeStagedImages(images);
      throw error;
    });
    if (!result.ok) {
      await removeStagedImages(images);
      return failure(result.reason);
    }
    return Response.json({ thread: result.thread });
  }

  if (!sub) {
    if (req.method !== "PATCH" || commentId) return undefined;
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user)
      return Response.json({ error: "user required" }, { status: 400 });
    const status =
      body?.status === "open" || body?.status === "resolved"
        ? body.status
        : undefined;
    const assignee =
      body?.assignee === null
        ? null
        : typeof body?.assignee === "string"
          ? body.assignee
          : undefined;
    if (!status && assignee === undefined)
      return Response.json({ error: "nothing to change" }, { status: 400 });
    const result = await updateThread(
      sessionId,
      threadId,
      { status, assignee },
      user,
    );
    return result.ok
      ? Response.json({ thread: result.thread })
      : failure(result.reason);
  }

  if (sub === "agent") {
    if (req.method !== "POST" || commentId) return undefined;
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user)
      return Response.json({ error: "user required" }, { status: 400 });
    const threads = await listThreads(sessionId);
    if (!threads.some((t) => t.id === threadId)) return failure("not_found");
    const { answerThreadInBackground } =
      await import("../comment-thread-agent");
    answerThreadInBackground(sessionId, threadId, user);
    return Response.json({ ok: true }, { status: 202 });
  }

  if (sub === "seen") {
    if (req.method !== "POST" || commentId) return undefined;
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user)
      return Response.json({ error: "user required" }, { status: 400 });
    const result = await markThreadSeen(sessionId, threadId, user);
    return result.ok
      ? Response.json({ thread: result.thread })
      : failure(result.reason);
  }

  // sub === "comments"
  if (!commentId) {
    if (req.method !== "POST") return undefined;
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user)
      return Response.json({ error: "user required" }, { status: 400 });
    const images = await stageImages(sessionId, body?.images);
    if (images instanceof Response) return images;
    const result = await addComment(sessionId, threadId, {
      user,
      text: typeof body?.text === "string" ? body.text : "",
      images,
    }).catch(async (error) => {
      await removeStagedImages(images);
      throw error;
    });
    if (!result.ok) {
      await removeStagedImages(images);
      return failure(result.reason);
    }
    return Response.json({ thread: result.thread, comment: result.added });
  }

  if (req.method !== "PATCH" && req.method !== "DELETE") return undefined;
  const body =
    req.method === "PATCH" ? await req.json().catch(() => null) : null;
  const user = requestUser(ctx, body?.user ?? ctx.url.searchParams.get("user"));
  if (!user) return Response.json({ error: "user required" }, { status: 400 });
  if (req.method === "PATCH") {
    const result = await editComment(
      sessionId,
      threadId,
      commentId,
      typeof body?.text === "string" ? body.text : "",
      user,
    );
    return result.ok
      ? Response.json({ thread: result.thread })
      : failure(result.reason);
  }
  const result = await deleteComment(sessionId, threadId, commentId, user);
  return result.ok
    ? Response.json({ thread: result.thread })
    : failure(result.reason);
}

/** The old team-notes API on top of session-level threads. */
async function handleLegacyNotes(
  ctx: RouteContext,
  sessionId: string,
  noteId: string | undefined,
): Promise<Response | undefined> {
  const { req, url } = ctx;
  if (!noteId) {
    if (req.method === "GET") {
      const limit = Math.max(1, Number(url.searchParams.get("limit")) || 200);
      const notes = (await listThreads(sessionId))
        .filter((t) => !t.anchor)
        .map(asNote)
        .slice(-limit);
      return Response.json({ notes });
    }
    if (req.method !== "POST") return undefined;
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user)
      return Response.json({ error: "user required" }, { status: 400 });
    const images = await stageImages(sessionId, body?.images);
    if (images instanceof Response) return images;
    const result = await createThread({
      sessionId,
      user,
      text: typeof body?.text === "string" ? body.text : "",
      images,
    });
    if (!result.ok) {
      await removeStagedImages(images);
      return failure(result.reason);
    }
    return Response.json({ note: asNote(result.thread) });
  }
  if (req.method !== "PATCH" && req.method !== "DELETE") return undefined;
  const body =
    req.method === "PATCH" ? await req.json().catch(() => null) : null;
  const user = requestUser(ctx, body?.user ?? url.searchParams.get("user"));
  if (!user) return Response.json({ error: "user required" }, { status: 400 });
  if (req.method === "PATCH") {
    const result = await editComment(
      sessionId,
      noteId,
      noteId,
      typeof body?.text === "string" ? body.text : "",
      user,
    );
    return result.ok
      ? Response.json({ note: asNote(result.thread) })
      : failure(result.reason);
  }
  const before = (await listThreads(sessionId)).find((t) => t.id === noteId);
  const result = await deleteComment(sessionId, noteId, noteId, user);
  if (!result.ok) return failure(result.reason);
  return Response.json({ note: before ? asNote(before) : null });
}
