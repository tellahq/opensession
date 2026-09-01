/**
 * slack-links — the thread ↔ session index for Slack threads anchored by
 * messages opensession sessions posted (typically automation runs), so a human
 * reply in one of those threads drives the posting session instead of
 * spawning a new one. Lives here rather than in the Slack agent so opensession
 * modules can populate it without importing the agent (same reasoning as
 * session-control.ts).
 *
 * The session file (`NativeSessionFile.slackThreads`) is the source of
 * truth; this in-memory index is a fast reverse-lookup rebuilt on startup and
 * kept in sync as threads are linked. It's parked on globalThis so a
 * `bun --hot` reload keeps it.
 */

const g = globalThis as unknown as {
  __slackLinkThreadToSess?: Map<string, string>;
  __slackLinkSessToThreads?: Map<string, Set<string>>;
};
// `${channel}:${threadTs}` → session id.
const threadToSess: Map<string, string> = (g.__slackLinkThreadToSess ??=
  new Map());
const sessToThreads: Map<string, Set<string>> = (g.__slackLinkSessToThreads ??=
  new Map());

const threadKey = (channel: string, threadTs: string) =>
  `${channel}:${threadTs}`;

/** The opensession session that posted the message anchoring this thread, if any. */
export function sessionForThread(
  channel: string,
  threadTs: string,
): string | undefined {
  return threadToSess.get(threadKey(channel, threadTs));
}

/** Link a thread to a session (a session can own several threads; a thread has one session). */
export function linkThreadInIndex(
  sessionId: string,
  channel: string,
  threadTs: string,
): void {
  const key = threadKey(channel, threadTs);
  const prevSess = threadToSess.get(key);
  if (prevSess && prevSess !== sessionId)
    sessToThreads.get(prevSess)?.delete(key);
  threadToSess.set(key, sessionId);
  let keys = sessToThreads.get(sessionId);
  if (!keys) sessToThreads.set(sessionId, (keys = new Set()));
  keys.add(key);
}

/**
 * Stateful scanner that spots successful Slack posts in a run's event stream.
 * Feed it every StreamEvent; it returns `{channel, threadTs}` whenever a post
 * is confirmed, in two ways:
 *
 * - slack MCP calls (`…post_message`/`reply_to_thread`/`add_message`): the
 *   input is remembered at tool_use and the posted message's channel/ts read
 *   off the tool_result (raw chat.postMessage JSON — `ok`/`channel`/`ts` sit
 *   at the head, safely inside the stream event's 500-char truncation). A
 *   threaded reply anchors to the thread it replied INTO (input.thread_ts); a
 *   top-level post anchors to its own ts.
 * - posts made outside the MCP (e.g. dispute_report_pdf.sh uploading via
 *   bash+curl) announce themselves with a `SLACK_MSG_POSTED channel=… ts=…`
 *   marker line, scanned in every tool result.
 *
 * One scanner per run — it holds the pending tool_use inputs.
 */
export function createSlackPostScanner(): (event: {
  type: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  content?: string;
}) => { channel: string; threadTs: string } | undefined {
  const pending = new Map<string, { channel?: string; threadTs?: string }>();
  return (event) => {
    if (
      event.type === "tool_use" &&
      event.toolUseId &&
      /^slack_.*(post_message|reply_to_thread|add_message)$/.test(
        event.toolName || "",
      )
    ) {
      const input = (event.toolInput || {}) as Record<string, unknown>;
      pending.set(event.toolUseId, {
        channel:
          typeof input.channel_id === "string"
            ? input.channel_id
            : typeof input.channel === "string"
              ? input.channel
              : undefined,
        threadTs:
          typeof input.thread_ts === "string" ? input.thread_ts : undefined,
      });
      return undefined;
    }
    if (event.type !== "tool_result") return undefined;
    const result = event.content || "";
    if (event.toolUseId && pending.has(event.toolUseId)) {
      const p = pending.get(event.toolUseId)!;
      pending.delete(event.toolUseId);
      // Prefer the result's channel (always the canonical C…/D… id — the
      // input may carry a channel name) and lenient-regex it: a truncated
      // JSON tail must not lose the post.
      const channel =
        result.match(/"channel"\s*:\s*"([A-Z0-9]+)"/)?.[1] || p.channel;
      const threadTs =
        p.threadTs || result.match(/"ts"\s*:\s*"(\d+\.\d+)"/)?.[1];
      if (/"ok"\s*:\s*true/.test(result) && channel && threadTs)
        return { channel, threadTs };
      return undefined;
    }
    const m = result.match(
      /SLACK_MSG_POSTED channel=([CD][A-Z0-9]+) ts=(\d+\.\d+)/,
    );
    return m ? { channel: m[1], threadTs: m[2] } : undefined;
  };
}

/** Remove all of a session's thread links (session deleted). */
export function unlinkThreadsInIndex(sessionId: string): void {
  for (const key of sessToThreads.get(sessionId) || [])
    threadToSess.delete(key);
  sessToThreads.delete(sessionId);
}

/** Rebuild the whole index from the session store (called at startup). */
export function rebuildIndex(
  sessions: Array<{
    id: string;
    slackThreads?: Array<{ channel: string; threadTs: string }>;
  }>,
): void {
  threadToSess.clear();
  sessToThreads.clear();
  for (const s of sessions) {
    for (const t of s.slackThreads || []) {
      if (t?.channel && t?.threadTs)
        linkThreadInIndex(s.id, t.channel, t.threadTs);
    }
  }
}
