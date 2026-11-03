import type { SlackChannelOption } from "./routes/slack-channels";
import { broadcastToSession } from "./ws-hub";
import { constants } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { UPLOADS_DIR } from "./uploads";
import { validFeaturedScreenshot } from "../agents/github/shipped-change-notify";

export interface SlackComposeRequest {
  id: string;
  message: string;
  channel?: string;
  images: string[];
}

export interface SlackComposeResult {
  status: "sent" | "cancelled";
  channel?: SlackChannelOption;
  /** Link to the posted message, when Slack gave us one. */
  permalink?: string;
}

interface PendingSlackComposer {
  request: SlackComposeRequest;
  resolve: (result: SlackComposeResult) => void;
  status: "pending" | "sending";
  snapshotDir: string;
}

const g = globalThis as any;
export const pendingSlackComposers: Map<string, PendingSlackComposer> =
  (g.__pendingSlackComposers ??= new Map());

interface SentSlackComposerMessage {
  channelId: string;
  ts: string;
  by: string;
}

/** Messages the composer posted, by session. Drafts go out as the bot, which
 *  can delete any bot message, so undo is limited to what is listed here and
 *  to the person who sent it. */
const sentSlackComposerMessages: Map<string, SentSlackComposerMessage[]> =
  (g.__sentSlackComposerMessages ??= new Map());

export function rememberSentSlackComposerMessage(
  sessionId: string,
  message: SentSlackComposerMessage,
): void {
  const sent = sentSlackComposerMessages.get(sessionId) || [];
  sentSlackComposerMessages.set(sessionId, [...sent, message].slice(-20));
}

export function sentSlackComposerMessage(
  sessionId: string,
  channelId: string,
  ts: string,
  by: string,
): boolean {
  return !!sentSlackComposerMessages
    .get(sessionId)
    ?.some(
      (message) =>
        message.channelId === channelId &&
        message.ts === ts &&
        message.by === by,
    );
}

export function forgetSentSlackComposerMessage(
  sessionId: string,
  channelId: string,
  ts: string,
): void {
  const sent = sentSlackComposerMessages.get(sessionId);
  if (!sent) return;
  const rest = sent.filter(
    (message) => message.channelId !== channelId || message.ts !== ts,
  );
  if (rest.length) sentSlackComposerMessages.set(sessionId, rest);
  else sentSlackComposerMessages.delete(sessionId);
}

async function snapshotImages(
  sessionId: string,
  requestId: string,
  images: string[],
): Promise<{
  dir: string;
  paths: string[];
}> {
  const dir = join(UPLOADS_DIR, "slack-composer", sessionId, requestId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const paths: string[] = [];
    for (const [index, source] of [...new Set(images)].slice(0, 10).entries()) {
      if (!(await validFeaturedScreenshot(source))) {
        throw new Error(
          `Slack image is unavailable: ${basename(source) || "image"}`,
        );
      }
      const target = join(dir, `${index + 1}-${basename(source)}`);
      const handle = await open(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || !stat.size || stat.size > 20 * 1024 * 1024) {
          throw new Error(
            `Slack image is unavailable: ${basename(source) || "image"}`,
          );
        }
        await writeFile(target, await handle.readFile(), { mode: 0o600 });
      } finally {
        await handle.close();
      }
      paths.push(target);
    }
    return { dir, paths };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function snapshotPendingSlackImages(
  sessionId: string,
  requestId: string,
  images: string[],
): Promise<string[]> {
  const pending = pendingSlackComposers.get(sessionId);
  if (
    !pending ||
    pending.request.id !== requestId ||
    pending.status !== "sending"
  ) {
    throw new Error("Slack composer is no longer open");
  }
  const snapshot = await snapshotImages(sessionId, `${requestId}/send`, images);
  return snapshot.paths;
}

function cleanup(pending: PendingSlackComposer): void {
  void rm(pending.snapshotDir, { recursive: true, force: true }).catch(
    (error) => console.warn("[slack] composer snapshot cleanup failed:", error),
  );
}

/** Sessions whose composer is still copying its images, so a second open
 *  in that window is refused like one against an open composer. */
const openingSlackComposers = new Set<string>();

function broadcast(sessionId: string, request: SlackComposeRequest): void {
  broadcastToSession(sessionId, {
    type: "slack_composer",
    sessionId,
    request,
  });
}

/**
 * Open a composer and return at once. The draft lives here, not in the caller:
 * it stays open until the person sends or cancels it, however long that takes,
 * and `result` settles then. Nothing that happens to the caller (an agent's
 * MCP call timing out or its turn ending) closes it.
 */
export async function openSlackComposer(
  sessionId: string,
  input: { message?: string; channel?: string; images?: string[] },
): Promise<{
  request: SlackComposeRequest;
  result: Promise<SlackComposeResult>;
}> {
  const existing = pendingSlackComposers.get(sessionId);
  if (existing || openingSlackComposers.has(sessionId)) {
    throw new Error("this session already has a Slack composer open");
  }
  const request: SlackComposeRequest = {
    id: crypto.randomUUID(),
    message: String(input.message || "").slice(0, 500),
    ...(input.channel?.trim() ? { channel: input.channel.trim() } : {}),
    images: [],
  };
  openingSlackComposers.add(sessionId);
  let snapshot: { dir: string; paths: string[] };
  try {
    snapshot = await snapshotImages(sessionId, request.id, input.images || []);
  } finally {
    openingSlackComposers.delete(sessionId);
  }
  request.images = snapshot.paths;
  const result = new Promise<SlackComposeResult>((resolve) => {
    pendingSlackComposers.set(sessionId, {
      request,
      resolve,
      status: "pending",
      snapshotDir: snapshot.dir,
    });
  });
  broadcast(sessionId, request);
  return { request, result };
}

export function updatePendingSlackComposer(
  sessionId: string,
  requestId: string,
  draft: Omit<SlackComposeRequest, "id">,
): SlackComposeRequest | null {
  const pending = pendingSlackComposers.get(sessionId);
  if (
    !pending ||
    pending.request.id !== requestId ||
    pending.status !== "pending"
  )
    return null;
  const channel = draft.channel || pending.request.channel;
  pending.request = {
    id: requestId,
    message: draft.message,
    ...(channel ? { channel } : {}),
    images: [...draft.images],
  };
  broadcast(sessionId, pending.request);
  return pending.request;
}

export function claimPendingSlackComposer(
  sessionId: string,
  requestId: string,
): boolean {
  const pending = pendingSlackComposers.get(sessionId);
  if (
    !pending ||
    pending.request.id !== requestId ||
    pending.status !== "pending"
  )
    return false;
  pending.status = "sending";
  return true;
}

export function restorePendingSlackComposer(
  sessionId: string,
  requestId: string,
): void {
  const pending = pendingSlackComposers.get(sessionId);
  if (pending?.request.id === requestId && pending.status === "sending")
    pending.status = "pending";
}

export function sendPendingSlackComposer(
  sessionId: string,
  requestId: string,
  channel: SlackChannelOption,
  permalink?: string,
  ts?: string,
): boolean {
  const pending = pendingSlackComposers.get(sessionId);
  if (
    !pending ||
    pending.request.id !== requestId ||
    pending.status !== "sending"
  )
    return false;
  pendingSlackComposers.delete(sessionId);
  cleanup(pending);
  pending.resolve({ status: "sent", channel, permalink });
  // Every viewer of this session collapses the composer into the same receipt,
  // not just the person who pressed Send.
  broadcastToSession(sessionId, {
    type: "slack_composer_resolved",
    sessionId,
    requestId,
    status: "sent",
    channel,
    permalink,
    ts,
  });
  return true;
}

export function cancelPendingSlackComposer(
  sessionId: string,
  requestId: string,
): boolean {
  const pending = pendingSlackComposers.get(sessionId);
  if (
    !pending ||
    pending.request.id !== requestId ||
    pending.status !== "pending"
  )
    return false;
  pendingSlackComposers.delete(sessionId);
  cleanup(pending);
  pending.resolve({ status: "cancelled" });
  broadcastToSession(sessionId, {
    type: "slack_composer_resolved",
    sessionId,
    requestId,
    status: "cancelled",
  });
  return true;
}

export function resendPendingSlackComposer(
  sessionId: string,
  send: (message: object) => void,
): void {
  const pending = pendingSlackComposers.get(sessionId);
  send({
    type: "slack_composer",
    sessionId,
    request: pending?.request ?? null,
  });
}
