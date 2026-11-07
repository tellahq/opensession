import type { CommentThread, TextAnchor, ThreadComment } from "../types";
import { request } from "./request";

// Comment threads on a session (src/server/routes/comment-threads.ts). Every
// mutation is broadcast back to the session's viewers as `comment_thread`, so
// callers may apply the returned thread at once and the echo is idempotent.

function threadsPath(sessionId: string, ...parts: string[]): string {
  return [
    `/sessions/${encodeURIComponent(sessionId)}/threads`,
    ...parts.map(encodeURIComponent),
  ].join("/");
}

export async function fetchThreadsApi(
  sessionId: string,
): Promise<CommentThread[]> {
  const data = await request<{ threads?: CommentThread[] }>(
    threadsPath(sessionId),
    { label: "Failed to load comments" },
  );
  return data?.threads || [];
}

export async function createThreadApi(
  sessionId: string,
  input: {
    text: string;
    user: string;
    images?: string[];
    anchor?: TextAnchor;
    assignee?: string;
  },
): Promise<CommentThread> {
  const data = await request<{ thread: CommentThread }>(
    threadsPath(sessionId),
    {
      method: "POST",
      body: input,
      label: "Failed to add comment",
    },
  );
  return data.thread;
}

export async function replyToThreadApi(
  sessionId: string,
  threadId: string,
  input: { text: string; user: string; images?: string[] },
): Promise<{ thread: CommentThread; comment: ThreadComment }> {
  return request(threadsPath(sessionId, threadId, "comments"), {
    method: "POST",
    body: input,
    label: "Failed to reply",
  });
}

export async function editThreadCommentApi(
  sessionId: string,
  threadId: string,
  commentId: string,
  text: string,
  user: string,
): Promise<CommentThread> {
  const data = await request<{ thread: CommentThread }>(
    threadsPath(sessionId, threadId, "comments", commentId),
    { method: "PATCH", body: { text, user }, label: "Failed to edit comment" },
  );
  return data.thread;
}

/** Resolves to the thread after the delete, or null when it went with it. */
export async function deleteThreadCommentApi(
  sessionId: string,
  threadId: string,
  commentId: string,
  user: string,
): Promise<CommentThread | null> {
  const data = await request<{ thread: CommentThread | null }>(
    `${threadsPath(sessionId, threadId, "comments", commentId)}?user=${encodeURIComponent(user)}`,
    { method: "DELETE", label: "Failed to delete comment" },
  );
  return data.thread;
}

export async function updateThreadApi(
  sessionId: string,
  threadId: string,
  patch: { status?: "open" | "resolved"; assignee?: string | null },
  user: string,
): Promise<CommentThread> {
  const data = await request<{ thread: CommentThread }>(
    threadsPath(sessionId, threadId),
    {
      method: "PATCH",
      body: { ...patch, user },
      label: "Failed to update comment",
    },
  );
  return data.thread;
}

export async function askAgentInThreadApi(
  sessionId: string,
  threadId: string,
  user: string,
): Promise<void> {
  await request(threadsPath(sessionId, threadId, "agent"), {
    method: "POST",
    body: { user },
    label: "Failed to ask the agent",
  });
}

/** Read receipt: `user` had the thread on screen. */
export async function markThreadSeenApi(
  sessionId: string,
  threadId: string,
  user: string,
): Promise<CommentThread> {
  const data = await request<{ thread: CommentThread }>(
    threadsPath(sessionId, threadId, "seen"),
    { method: "POST", body: { user }, label: "Failed to mark seen" },
  );
  return data.thread;
}

/** Entry id → emoji → who reacted. */
export type MessageReactions = Record<string, Record<string, string[]>>;

export async function fetchReactionsApi(
  sessionId: string,
): Promise<MessageReactions> {
  const data = await request<{ reactions?: MessageReactions }>(
    `/sessions/${encodeURIComponent(sessionId)}/reactions`,
    { label: "Failed to load reactions" },
  );
  return data?.reactions ?? {};
}

/** Add the person's reaction, or take it back when they already reacted. */
export async function toggleReactionApi(
  sessionId: string,
  input: { entryId: string; emoji: string; user: string },
): Promise<MessageReactions> {
  const data = await request<{ reactions: MessageReactions }>(
    `/sessions/${encodeURIComponent(sessionId)}/reactions`,
    { method: "POST", body: input, label: "Failed to react" },
  );
  return data.reactions;
}
