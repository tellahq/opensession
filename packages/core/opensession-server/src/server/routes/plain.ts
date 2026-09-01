/**
 * Plain (support) routes: triage session hand-off, thread timelines, the Support queue, replies/notes and thread mutations. Human-gated — agent runs never see these as tools.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { listAutomations, runAutomation } from "../automations";
import {
  findSessionAsync,
  getCachedSessionsAsync,
  invalidateSessionsCache,
} from "../session-cache";
import { type Workspace } from "../workspaces";

// The most recent live (non-archived) session already triaging this thread,
// or null when the ticket has never been opened here. A cache read — cheap
// enough to sit in front of a redirect that must answer immediately.
async function existingPlainTriageSession(
  threadId: string,
): Promise<string | null> {
  const existing = (await getCachedSessionsAsync())
    .filter((s) => s.plainThreadId === threadId && !s.archived)
    .sort(
      (a, b) =>
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
    )[0];
  return existing ? existing.id : null;
}

// Land a Plain thread in a triage session: reuse the most recent live
// (non-archived) session already linked to the thread, else kick off the
// "Plain ticket triage" automation with the same context the webhook event
// carries and wait (up to 2 min) for its session to boot. The JSON API behind
// the Support view's "Triage this ticket" button awaits this; the
// /plain-triage redirect must NOT (see the handler — a navigation that hangs
// for minutes gets replaced by the cached app shell and loses its URL).
async function resolvePlainTriageSession(
  threadId: string,
): Promise<string | null> {
  const existing = await existingPlainTriageSession(threadId);
  if (existing) return existing;

  const automation = listAutomations().find(
    (a) => a.eventKey === "plain:thread_created",
  );
  if (!automation) return null;

  // Build the same payload shape the webhook event carries
  let payload: Record<string, unknown> = { threadId };
  try {
    const { getThreadWithMessages } = await import("../../agents/plain/api");
    const thread = await getThreadWithMessages(threadId);
    payload = {
      threadId,
      title: thread?.title || null,
      previewText: thread?.previewText || thread?.description || null,
      status: thread?.status || null,
      customer: {
        email: thread?.customer?.email?.email || null,
        fullName: thread?.customer?.fullName || null,
      },
    };
  } catch (e) {
    console.error(`[plain-triage] Thread lookup failed for ${threadId}:`, e);
  }

  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 120_000);
    void runAutomation(
      automation,
      (id) => {
        invalidateSessionsCache();
        clearTimeout(timer);
        resolve(id);
      },
      {
        trigger: "event",
        eventContext: JSON.stringify(payload, null, 2),
      },
    );
  });
}

// The Support sidebar's TODO-thread list, cached briefly so a click-through
// of tickets doesn't hammer Plain's API (every open browser polls this).
let plainTodoCache: { data: unknown[]; ts: number } | null = null;
const PLAIN_TODO_TTL = 30_000;
// Workspace users + label types for the Support UI's Assign/Labels menus —
// near-static, so cached long and shared by every open browser.
let plainUsersCache: { data: unknown[]; ts: number } | null = null;
let plainLabelTypesCache: { data: unknown[]; ts: number } | null = null;
const PLAIN_META_TTL = 5 * 60_000;

const plainAttachmentUploads = new Map<
  string,
  { size: number; kind: "reply" | "note"; at: number }
>();

async function readBodyWithinLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function handlePlainRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // Land the user in a Plain triage session for a thread. If one already
  // exists for this thread, jump straight to it; otherwise start a fresh
  // triage run with the same context the automation gets on thread_created.
  // Linked from the Plain support cards.
  //
  // This ALWAYS answers immediately. Booting a triage session takes 15-120s,
  // and a navigation held open that long is not a slow page — the service
  // worker's stall guard paints the cached app shell over it after 5s, at a
  // URL the router has no route for, and the app falls back to restoring the
  // viewer's last session (looks like "the link opened the wrong ticket").
  // So: hand back the thread-scoped Support view, which renders the real
  // ticket right away, and let the run boot behind it — the session files
  // itself under this thread's workspace and appears as a tab there.
  const plainTriageMatch = path.match(/^\/plain-triage\/([^/]+)$/);
  if (plainTriageMatch && req.method === "GET") {
    const threadId = decodeURIComponent(plainTriageMatch[1]);
    const sessionId = await existingPlainTriageSession(threadId);
    if (!sessionId) {
      void resolvePlainTriageSession(threadId).catch((e) =>
        console.error(
          `[plain-triage] Background boot for ${threadId} failed:`,
          e,
        ),
      );
    }
    console.log(
      `[plain-triage] ${threadId} -> ${sessionId ? `session ${sessionId}` : "support view (triage booting)"}`,
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: sessionId
          ? `${publicPrefix}/session/${sessionId}`
          : `${publicPrefix}/support/${encodeURIComponent(threadId)}`,
      },
    });
  }

  // Serve one of a thread's attachments (customer screenshots, mostly).
  // Plain hands out signed URLs that expire in ~3 minutes, so we mint one
  // per request and stream the bytes back rather than leaking a URL that
  // would be dead by the time the image is rendered. Cached hard by the
  // browser — attachment bytes are immutable once uploaded.
  const plainAttachmentMatch = path.match(
    /^\/api\/plain\/attachments\/([^/]+)$/,
  );
  if (plainAttachmentMatch && req.method === "GET") {
    const attachmentId = decodeURIComponent(plainAttachmentMatch[1]);
    try {
      const { getAttachmentDownloadUrl } =
        await import("../../agents/plain/api");
      const link = await getAttachmentDownloadUrl(attachmentId);
      if (!link) return Response.json({ error: "Not found" }, { status: 404 });

      const upstream = await fetch(link.url);
      if (!upstream.ok || !upstream.body)
        return Response.json(
          { error: `Attachment fetch failed (${upstream.status})` },
          { status: 502 },
        );
      // `inline` so images render in the timeline; the filename still
      // drives Save-as. Quotes escaped so a quirky name can't break out.
      const safeName = link.fileName.replace(/["\\]/g, "");
      return new Response(upstream.body, {
        headers: {
          "Content-Type": link.mimeType,
          "Content-Disposition": `inline; filename="${safeName}"`,
          "Cache-Control": "private, max-age=86400",
        },
      });
    } catch (e: any) {
      console.error(`[plain-attachment] ${attachmentId} failed:`, e);
      return Response.json(
        { error: e?.message || "Attachment fetch failed" },
        { status: 502 },
      );
    }
  }

  // The conversation timeline for a session's linked Plain thread,
  // flattened for the session viewer's read-only Plain sidebar.
  const plainThreadMatch = path.match(/^\/api\/sessions\/(.+)\/plain\/thread$/);
  if (plainThreadMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(plainThreadMatch[1]);
    const session = await findSessionAsync(sessionId);
    const threadId = session?.plainThreadId;
    if (!threadId)
      return Response.json(
        { error: "No linked Plain thread" },
        { status: 400 },
      );
    try {
      const { getThreadWithMessages, normalizePlainThread } =
        await import("../../agents/plain/api");
      const thread = await getThreadWithMessages(threadId);
      if (!thread)
        return Response.json({ error: "Thread not found" }, { status: 404 });
      return Response.json({ thread: normalizePlainThread(thread) });
    } catch (e: any) {
      console.error(`[plain-thread] Lookup failed for ${threadId}:`, e);
      return Response.json(
        { error: e?.message || "Plain lookup failed" },
        { status: 502 },
      );
    }
  }

  // The Support sidebar's ticket queue: every TODO Plain thread, newest
  // status change first (Plain's own Todo-inbox ordering). Cached ~30s.
  if (path === "/api/plain/threads" && req.method === "GET") {
    if (plainTodoCache && Date.now() - plainTodoCache.ts < PLAIN_TODO_TTL)
      return Response.json({ threads: plainTodoCache.data });
    try {
      const { listTodoThreads } = await import("../../agents/plain/api");
      const threads = await listTodoThreads(100);
      plainTodoCache = { data: threads, ts: Date.now() };
      return Response.json({ threads });
    } catch (e: any) {
      console.error("[plain-threads] List failed:", e);
      return Response.json(
        { error: e?.message || "Plain lookup failed" },
        { status: 502 },
      );
    }
  }

  // A thread's conversation timeline by thread id — the session-less
  // Support preview reads this (no session exists for the ticket yet).
  const plainThreadByIdMatch = path.match(/^\/api\/plain\/threads\/([^/]+)$/);
  if (plainThreadByIdMatch && req.method === "GET") {
    const threadId = decodeURIComponent(plainThreadByIdMatch[1]);
    try {
      const { getThreadWithMessages, normalizePlainThread } =
        await import("../../agents/plain/api");
      const thread = await getThreadWithMessages(threadId);
      if (!thread)
        return Response.json({ error: "Thread not found" }, { status: 404 });
      return Response.json({ thread: normalizePlainThread(thread) });
    } catch (e: any) {
      console.error(`[plain-thread] Lookup failed for ${threadId}:`, e);
      return Response.json(
        { error: e?.message || "Plain lookup failed" },
        { status: 502 },
      );
    }
  }

  // Human reply into a Plain thread from the Support preview / a
  // session's Plain tab: a customer-facing reply (email/chat, sent as
  // the Plain machine user) or an internal note. This is the human gate
  // itself — agent runs never get this path as a tool; automation runs
  // are denied Plain thread writes at the tool layer.
  const plainReplyMatch = path.match(/^\/api\/plain\/threads\/([^/]+)\/reply$/);
  const plainAttachmentUploadMatch = path.match(
    /^\/api\/plain\/threads\/([^/]+)\/attachments$/,
  );
  if (plainAttachmentUploadMatch && req.method === "POST") {
    const threadId = decodeURIComponent(plainAttachmentUploadMatch[1]);
    const rawName = req.headers.get("x-file-name") || "attachment";
    const requestedKind =
      req.headers.get("x-plain-kind") === "note" ? "note" : "reply";
    const declaredSize = Number(req.headers.get("content-length") || 0);
    const maxBytes = 25 * 1024 * 1024;
    if (declaredSize > maxBytes) {
      return Response.json(
        { error: "Attachment is too large (25 MB max)" },
        { status: 413 },
      );
    }
    try {
      let fileName: string;
      try {
        fileName = decodeURIComponent(rawName);
      } catch {
        return Response.json(
          { error: "Invalid attachment filename" },
          { status: 400 },
        );
      }
      const bytes = await readBodyWithinLimit(req.body, maxBytes);
      if (!bytes) {
        return Response.json(
          { error: "Attachment is too large (25 MB max)" },
          { status: 413 },
        );
      }
      if (!bytes.byteLength) {
        return Response.json({ error: "Attachment is empty" }, { status: 400 });
      }
      const { getThreadWithMessages, uploadPlainAttachment } =
        await import("../../agents/plain/api");
      const thread = await getThreadWithMessages(threadId);
      const customerId = thread?.customer?.id;
      if (!customerId) throw new Error("Thread has no customer");
      const channel = String(thread.channel || "").toUpperCase();
      const kind =
        requestedKind === "note"
          ? "note"
          : channel === "CHAT"
            ? "chat"
            : channel === "SLACK"
              ? "slack"
              : channel === "MS_TEAMS"
                ? "ms-teams"
                : channel === "DISCORD"
                  ? "discord"
                  : channel === "API" || channel === "IMPORT"
                    ? "custom"
                    : "email";
      const attachmentId = await uploadPlainAttachment(
        customerId,
        fileName,
        bytes,
        req.headers.get("content-type") || "application/octet-stream",
        kind,
      );
      const now = Date.now();
      for (const [id, upload] of plainAttachmentUploads) {
        if (now - upload.at > 60 * 60_000) plainAttachmentUploads.delete(id);
      }
      plainAttachmentUploads.set(attachmentId, {
        size: bytes.byteLength,
        kind: requestedKind,
        at: now,
      });
      return Response.json({ ok: true, attachmentId, fileName });
    } catch (e: any) {
      console.error(`[plain-attachment] Upload to ${threadId} failed:`, e);
      return Response.json(
        { error: e?.message || "Plain attachment upload failed" },
        { status: 502 },
      );
    }
  }
  if (plainReplyMatch && req.method === "POST") {
    const threadId = decodeURIComponent(plainReplyMatch[1]);
    const body = (await req.json().catch(() => null)) as {
      text?: string;
      kind?: string;
      user?: string;
      attachmentIds?: string[];
    } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const kind = body?.kind === "note" ? "note" : "reply";
    const rawAttachmentIds = Array.isArray(body?.attachmentIds)
      ? body.attachmentIds
      : [];
    if (rawAttachmentIds.length > 20) {
      return Response.json(
        { error: "Too many attachments (20 max)" },
        { status: 400 },
      );
    }
    const attachmentIds = rawAttachmentIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    const attachmentUploads = attachmentIds.map((id) =>
      plainAttachmentUploads.get(id),
    );
    if (attachmentUploads.some((upload) => !upload || upload.kind !== kind)) {
      return Response.json(
        {
          error: "Attachment is missing or belongs to a different message mode",
        },
        { status: 400 },
      );
    }
    const attachmentBytes = attachmentUploads.reduce(
      (total, upload) => total + (upload?.size || 0),
      0,
    );
    const attachmentLimit =
      kind === "note" ? 50 * 1024 * 1024 : 6 * 1024 * 1024;
    if (attachmentBytes > attachmentLimit) {
      return Response.json(
        {
          error: `${kind === "note" ? "Internal note" : "Reply"} attachments exceed the total size limit`,
        },
        { status: 413 },
      );
    }
    if (!text && attachmentIds.length === 0)
      return Response.json({ error: "Empty message" }, { status: 400 });
    // Plain's API can only impersonate customers, not workspace users, so
    // everything lands as the bot machine user — carry the human's
    // name in the message instead: replies get their first name as an
    // email-style sign-off (unless they already signed), notes get an
    // author prefix.
    const senderName = requestUser(ctx, body?.user);
    const firstName = senderName.split(/\s+/)[0] || "";
    try {
      const { getThreadWithMessages, postNote, sendCustomerReply } =
        await import("../../agents/plain/api");
      if (kind === "note") {
        // Notes need the customer id; the thread lookup carries it.
        const thread = await getThreadWithMessages(threadId);
        const customerId = thread?.customer?.id;
        if (!customerId) throw new Error("Thread has no customer");
        const noteText = firstName
          ? `**${senderName} (via Open Session):**\n\n${text}`
          : text;
        const ok = await postNote(
          threadId,
          customerId,
          noteText,
          undefined,
          attachmentIds,
        );
        if (!ok) throw new Error("Plain rejected the note");
      } else {
        const alreadySigned =
          firstName &&
          new RegExp(
            `${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
            "i",
          ).test(text.trimEnd());
        const replyText =
          firstName && text && !alreadySigned
            ? `${text.trimEnd()}\n\n${firstName}`
            : text;
        // Their own Plain grant (Account → Connect) sends the reply
        // AS THEM; without one (or if Plain rejects the token) the
        // workspace machine user sends it, name carried in the sign-off.
        const { mcpUserGrantToken } = await import("../mcp-oauth");
        const grantToken = senderName
          ? mcpUserGrantToken("plain", senderName)
          : undefined;
        const res = await sendCustomerReply(
          threadId,
          "",
          replyText,
          grantToken,
          attachmentIds,
        );
        if (!res.ok) throw new Error("Plain rejected the reply");
        console.log(
          `[plain-reply] ${senderName || "someone"} sent a reply to ${threadId} (as ${res.sentAs})`,
        );
        for (const id of attachmentIds) plainAttachmentUploads.delete(id);
        return Response.json({ ok: true, sentAs: res.sentAs });
      }
      console.log(
        `[plain-reply] ${requestUser(ctx, body?.user) || "someone"} sent a ${kind} to ${threadId}`,
      );
      for (const id of attachmentIds) plainAttachmentUploads.delete(id);
      return Response.json({ ok: true });
    } catch (e: any) {
      console.error(`[plain-reply] ${kind} to ${threadId} failed:`, e);
      return Response.json(
        { error: e?.message || "Plain write failed" },
        { status: 502 },
      );
    }
  }

  // Quick status change on a Plain thread from the Support UI: Done
  // closes it, Todo (re)opens/unsnoozes it, Snoozed parks it. Human-gated
  // like the reply route — agent runs never see these paths as tools.
  const plainStatusMatch = path.match(
    /^\/api\/plain\/threads\/([^/]+)\/status$/,
  );
  if (plainStatusMatch && req.method === "POST") {
    const threadId = decodeURIComponent(plainStatusMatch[1]);
    const body = (await req.json().catch(() => null)) as {
      status?: string;
      durationSeconds?: number;
      user?: string;
    } | null;
    const status = body?.status;
    if (status !== "todo" && status !== "done" && status !== "snoozed")
      return Response.json(
        { error: "status must be todo, done or snoozed" },
        { status: 400 },
      );
    try {
      const { setThreadStatus } = await import("../../agents/plain/api");
      await setThreadStatus(
        threadId,
        status,
        typeof body?.durationSeconds === "number"
          ? body.durationSeconds
          : undefined,
      );
      plainTodoCache = null; // the queue changed — next poll refetches
      // The sidebar band reads the feeds layer now — bust that cache too.
      try {
        (await import("../feeds")).invalidateFeedCache("plain");
      } catch {}
      console.log(
        `[plain-status] ${requestUser(ctx, body?.user) || "someone"} marked ${threadId} ${status}`,
      );
      return Response.json({ ok: true, status });
    } catch (e: any) {
      console.error(`[plain-status] ${status} on ${threadId} failed:`, e);
      return Response.json(
        { error: e?.message || "Plain write failed" },
        { status: 502 },
      );
    }
  }

  // Change a thread's priority (0 = Urgent … 3 = Low).
  const plainPriorityMatch = path.match(
    /^\/api\/plain\/threads\/([^/]+)\/priority$/,
  );
  if (plainPriorityMatch && req.method === "POST") {
    const threadId = decodeURIComponent(plainPriorityMatch[1]);
    const body = (await req.json().catch(() => null)) as {
      priority?: number;
      user?: string;
    } | null;
    const priority = body?.priority;
    if (typeof priority !== "number" || ![0, 1, 2, 3].includes(priority))
      return Response.json(
        { error: "priority must be 0 (Urgent) … 3 (Low)" },
        { status: 400 },
      );
    try {
      const { setThreadPriority } = await import("../../agents/plain/api");
      await setThreadPriority(threadId, priority);
      plainTodoCache = null;
      console.log(
        `[plain-priority] ${requestUser(ctx, body?.user) || "someone"} set ${threadId} priority ${priority}`,
      );
      return Response.json({ ok: true, priority });
    } catch (e: any) {
      console.error(`[plain-priority] on ${threadId} failed:`, e);
      return Response.json(
        { error: e?.message || "Plain write failed" },
        { status: 502 },
      );
    }
  }

  // Mark the customer behind a thread as spam (or undo). Spam lives on
  // the customer in Plain — all their threads get filtered — so marking
  // also closes this thread to get it out of the Todo queue right away.
  const plainSpamMatch = path.match(/^\/api\/plain\/threads\/([^/]+)\/spam$/);
  if (plainSpamMatch && req.method === "POST") {
    const threadId = decodeURIComponent(plainSpamMatch[1]);
    const body = (await req.json().catch(() => null)) as {
      spam?: boolean;
      user?: string;
    } | null;
    const spam = body?.spam !== false;
    try {
      const { getThreadWithMessages, setCustomerSpam, setThreadStatus } =
        await import("../../agents/plain/api");
      const thread = await getThreadWithMessages(threadId);
      const customerId = thread?.customer?.id;
      if (!customerId)
        return Response.json(
          { error: "Thread has no customer" },
          { status: 404 },
        );
      await setCustomerSpam(customerId, spam);
      // Plain closes the customer's threads itself on spam-mark (and
      // reopens on unmark) — this explicit close is a best-effort
      // belt-and-braces, so "already in the requested status" is fine.
      let closedThread = false;
      if (spam && thread?.status !== "DONE") {
        closedThread = await setThreadStatus(threadId, "done")
          .then(() => true)
          .catch((e) => {
            if (!/already in the requested status/i.test(e?.message || ""))
              console.error(
                `[plain-spam] Close after spam-mark failed for ${threadId}:`,
                e,
              );
            return false;
          });
      }
      plainTodoCache = null;
      console.log(
        `[plain-spam] ${requestUser(ctx, body?.user) || "someone"} ${spam ? "marked" : "unmarked"} customer ${customerId} (thread ${threadId}) as spam`,
      );
      return Response.json({ ok: true, spam, closedThread });
    } catch (e: any) {
      console.error(`[plain-spam] on ${threadId} failed:`, e);
      return Response.json(
        { error: e?.message || "Plain write failed" },
        { status: 502 },
      );
    }
  }

  // Workspace users for the Assign menu (alias accounts filtered out).
  if (path === "/api/plain/users" && req.method === "GET") {
    if (plainUsersCache && Date.now() - plainUsersCache.ts < PLAIN_META_TTL)
      return Response.json({ users: plainUsersCache.data });
    try {
      const { listWorkspaceUsers } = await import("../../agents/plain/api");
      const users = await listWorkspaceUsers();
      plainUsersCache = { data: users, ts: Date.now() };
      return Response.json({ users });
    } catch (e: any) {
      console.error("[plain-users] List failed:", e);
      return Response.json(
        { error: e?.message || "Plain lookup failed" },
        { status: 502 },
      );
    }
  }

  // Active label types for the Labels menu.
  if (path === "/api/plain/label-types" && req.method === "GET") {
    if (
      plainLabelTypesCache &&
      Date.now() - plainLabelTypesCache.ts < PLAIN_META_TTL
    )
      return Response.json({ labelTypes: plainLabelTypesCache.data });
    try {
      const { listLabelTypes } = await import("../../agents/plain/api");
      const labelTypes = await listLabelTypes();
      plainLabelTypesCache = { data: labelTypes, ts: Date.now() };
      return Response.json({ labelTypes });
    } catch (e: any) {
      console.error("[plain-label-types] List failed:", e);
      return Response.json(
        { error: e?.message || "Plain lookup failed" },
        { status: 502 },
      );
    }
  }

  // Assign a thread to a teammate (or unassign with userId: null).
  const plainAssignMatch = path.match(
    /^\/api\/plain\/threads\/([^/]+)\/assign$/,
  );
  if (plainAssignMatch && req.method === "POST") {
    const threadId = decodeURIComponent(plainAssignMatch[1]);
    const body = (await req.json().catch(() => null)) as {
      userId?: string | null;
      user?: string;
    } | null;
    const userId =
      typeof body?.userId === "string" && body.userId ? body.userId : null;
    try {
      const { assignThreadToUser } = await import("../../agents/plain/api");
      await assignThreadToUser(threadId, userId);
      console.log(
        `[plain-assign] ${requestUser(ctx, body?.user) || "someone"} ${
          userId
            ? `assigned ${threadId} to ${userId}`
            : `unassigned ${threadId}`
        }`,
      );
      return Response.json({ ok: true, userId });
    } catch (e: any) {
      console.error(`[plain-assign] on ${threadId} failed:`, e);
      return Response.json(
        { error: e?.message || "Plain write failed" },
        { status: 502 },
      );
    }
  }

  // Toggle labels on a thread: adds take label-type ids, removes take the
  // thread's label instance ids.
  const plainLabelsMatch = path.match(
    /^\/api\/plain\/threads\/([^/]+)\/labels$/,
  );
  if (plainLabelsMatch && req.method === "POST") {
    const threadId = decodeURIComponent(plainLabelsMatch[1]);
    const body = (await req.json().catch(() => null)) as {
      addLabelTypeIds?: string[];
      removeLabelIds?: string[];
      user?: string;
    } | null;
    const add = Array.isArray(body?.addLabelTypeIds)
      ? body.addLabelTypeIds.filter((x) => typeof x === "string" && x)
      : [];
    const remove = Array.isArray(body?.removeLabelIds)
      ? body.removeLabelIds.filter((x) => typeof x === "string" && x)
      : [];
    if (!add.length && !remove.length)
      return Response.json({ error: "Nothing to change" }, { status: 400 });
    try {
      const { changeThreadLabels } = await import("../../agents/plain/api");
      await changeThreadLabels(threadId, add, remove);
      plainTodoCache = null; // labels show on the queue rows
      console.log(
        `[plain-labels] ${requestUser(ctx, body?.user) || "someone"} changed labels on ${threadId} (+${add.length} −${remove.length})`,
      );
      return Response.json({ ok: true });
    } catch (e: any) {
      console.error(`[plain-labels] on ${threadId} failed:`, e);
      return Response.json(
        { error: e?.message || "Plain write failed" },
        { status: 502 },
      );
    }
  }

  // Rename a thread.
  const plainTitleMatch = path.match(/^\/api\/plain\/threads\/([^/]+)\/title$/);
  if (plainTitleMatch && req.method === "POST") {
    const threadId = decodeURIComponent(plainTitleMatch[1]);
    const body = (await req.json().catch(() => null)) as {
      title?: string;
      user?: string;
    } | null;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title) return Response.json({ error: "Empty title" }, { status: 400 });
    try {
      const { setThreadTitle } = await import("../../agents/plain/api");
      await setThreadTitle(threadId, title.slice(0, 200));
      plainTodoCache = null; // titles show in the queue
      console.log(
        `[plain-title] ${requestUser(ctx, body?.user) || "someone"} renamed ${threadId}`,
      );
      return Response.json({ ok: true });
    } catch (e: any) {
      console.error(`[plain-title] on ${threadId} failed:`, e);
      return Response.json(
        { error: e?.message || "Plain write failed" },
        { status: 502 },
      );
    }
  }

  // JSON twin of the /backstage/plain-triage/<id> redirect: the Support
  // preview's "Triage this ticket" button. Reuses a live session linked to
  // the thread, else starts the triage automation and waits for its
  // session to boot (~15-60s — the client shows a progress state).
  const plainTriageApiMatch = path.match(/^\/api\/plain\/triage\/([^/]+)$/);
  if (plainTriageApiMatch && req.method === "POST") {
    const threadId = decodeURIComponent(plainTriageApiMatch[1]);
    const sessionId = await resolvePlainTriageSession(threadId);
    if (!sessionId)
      return Response.json(
        { error: "Failed to start a triage session" },
        { status: 502 },
      );
    return Response.json({ sessionId });
  }

  return undefined;
}
