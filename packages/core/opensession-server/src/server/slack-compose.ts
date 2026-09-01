import type { SlackChannelOption } from "./routes/slack-channels";
import { broadcastToSession } from "./ws-hub";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function snapshotImages(
  sessionId: string,
  requestId: string,
  images: string[],
): {
  dir: string;
  paths: string[];
} {
  const dir = join(UPLOADS_DIR, "slack-composer", sessionId, requestId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const paths = [...new Set(images)].slice(0, 10).map((source, index) => {
      if (!validFeaturedScreenshot(source)) {
        throw new Error(
          `Slack image is unavailable: ${basename(source) || "image"}`,
        );
      }
      const target = join(dir, `${index + 1}-${basename(source)}`);
      const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || !stat.size || stat.size > 20 * 1024 * 1024) {
          throw new Error(
            `Slack image is unavailable: ${basename(source) || "image"}`,
          );
        }
        writeFileSync(target, readFileSync(fd), { mode: 0o600 });
      } finally {
        closeSync(fd);
      }
      return target;
    });
    return { dir, paths };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function snapshotPendingSlackImages(
  sessionId: string,
  requestId: string,
  images: string[],
): string[] {
  const pending = pendingSlackComposers.get(sessionId);
  if (
    !pending ||
    pending.request.id !== requestId ||
    pending.status !== "sending"
  ) {
    throw new Error("Slack composer is no longer open");
  }
  const snapshot = snapshotImages(sessionId, `${requestId}/send`, images);
  return snapshot.paths;
}

function cleanup(pending: PendingSlackComposer): void {
  rmSync(pending.snapshotDir, { recursive: true, force: true });
}

function broadcast(sessionId: string, request: SlackComposeRequest): void {
  broadcastToSession(sessionId, {
    type: "slack_composer",
    sessionId,
    request,
  });
}

export function openSlackComposer(
  sessionId: string,
  input: { message?: string; channel?: string; images?: string[] },
  signal?: AbortSignal,
): Promise<SlackComposeResult> {
  const existing = pendingSlackComposers.get(sessionId);
  if (existing) {
    throw new Error("this session already has a Slack composer open");
  }
  const request: SlackComposeRequest = {
    id: crypto.randomUUID(),
    message: String(input.message || "").slice(0, 500),
    ...(input.channel?.trim() ? { channel: input.channel.trim() } : {}),
    images: [],
  };
  const snapshot = snapshotImages(sessionId, request.id, input.images || []);
  request.images = snapshot.paths;
  return new Promise((resolve) => {
    const settle = (result: SlackComposeResult) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      cancelPendingSlackComposer(sessionId, request.id);
    };
    pendingSlackComposers.set(sessionId, {
      request,
      resolve: settle,
      status: "pending",
      snapshotDir: snapshot.dir,
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    if (pendingSlackComposers.has(sessionId)) broadcast(sessionId, request);
  });
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
