import { deleteSlackMessage } from "../../agents/slack/slack-api";
import { postAsSlackBot } from "../../agents/slack/bot-post";
import { sessionLink } from "../run-instructions";
import { validFeaturedScreenshot } from "../../agents/github/shipped-change-notify";
import {
  cancelPendingSlackComposer,
  claimPendingSlackComposer,
  forgetSentSlackComposerMessage,
  openSlackComposer,
  pendingSlackComposers,
  rememberSentSlackComposerMessage,
  restorePendingSlackComposer,
  sendPendingSlackComposer,
  sentSlackComposerMessage,
  snapshotPendingSlackImages,
  updatePendingSlackComposer,
} from "../slack-compose";
import {
  configuredSlackChannels,
  defaultSlackChannel,
  slackChannelsPayload,
} from "./slack-channels";
import {
  isSlackChannelId,
  resolveSlackChannel,
} from "../../agents/slack/channel-directory";
import type { RouteContext } from "./context";
import { findSessionAsync } from "../session-cache";
import {
  SLACK_THREAD_TARGET,
  slackThreadReceipt,
  slackThreadTarget,
} from "../slack-thread-target";
import { slackMessageLength } from "../../shared/slack-mentions";

/** The channel to post to: any the caller can reach, with the configured
 *  default when the composer sent none. */
async function targetChannel(
  value: unknown,
  auth?: { caller: string; token: string },
) {
  const channels = configuredSlackChannels();
  if (typeof value !== "string" || !value.trim()) {
    return channels.find(
      (channel) => channel.id === defaultSlackChannel(channels),
    );
  }
  return resolveSlackChannel(value, channels, auth);
}

export async function handleSlackComposeRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const openMatch = ctx.path.match(
    /^\/api\/sessions\/([^/]+)\/slack-composer\/open$/,
  );
  if (openMatch && ctx.req.method === "POST") {
    const sessionId = decodeURIComponent(openMatch[1]);
    if (!ctx.authUser?.login && !ctx.authUser?.name) {
      return Response.json(
        { error: "Sign in to review this Slack message" },
        { status: 401 },
      );
    }
    const body = await ctx.req.json().catch(() => ({}));
    try {
      const { request } = openSlackComposer(sessionId, {
        message: typeof body?.message === "string" ? body.message : "",
      });
      return Response.json(request);
    } catch (error: any) {
      return Response.json(
        { error: error?.message || "Couldn't open the Slack composer" },
        { status: 409 },
      );
    }
  }
  // Undo: take a message this person just sent back out of Slack. Drafts go
  // out as the bot, which could delete any bot message, so only a message
  // this composer posted for this caller qualifies.
  const undoMatch = ctx.path.match(
    /^\/api\/sessions\/([^/]+)\/slack-composer\/undo$/,
  );
  if (undoMatch && ctx.req.method === "POST") {
    const sessionId = decodeURIComponent(undoMatch[1]);
    const caller = ctx.authUser?.login || ctx.authUser?.name;
    if (!caller) {
      return Response.json(
        { error: "Sign in to undo this Slack message" },
        { status: 401 },
      );
    }
    const body = await ctx.req.json().catch(() => ({}));
    const channelId =
      typeof body?.channel === "string" && isSlackChannelId(body.channel.trim())
        ? body.channel.trim()
        : "";
    const ts = typeof body?.ts === "string" ? body.ts : "";
    if (
      !channelId ||
      !ts ||
      !sentSlackComposerMessage(sessionId, channelId, ts, caller)
    ) {
      return Response.json(
        { error: "That message can no longer be undone" },
        { status: 409 },
      );
    }
    try {
      await deleteSlackMessage(channelId, ts);
    } catch (error: any) {
      return Response.json(
        { error: error?.message || "Couldn't undo the Slack message" },
        { status: 502 },
      );
    }
    forgetSentSlackComposerMessage(sessionId, channelId, ts);
    return Response.json({ status: "undone" });
  }
  const match = ctx.path.match(/^\/api\/sessions\/([^/]+)\/slack-composer$/);
  if (!match || !["GET", "POST", "PATCH", "DELETE"].includes(ctx.req.method))
    return;
  const sessionId = decodeURIComponent(match[1]);
  if (ctx.req.method === "GET") {
    const thread = await slackThreadTarget(
      await findSessionAsync(sessionId),
      configuredSlackChannels(),
    );
    return Response.json(
      await slackChannelsPayload(ctx, {
        everyChannel: true,
        ...(thread ? { thread } : {}),
      }),
    );
  }
  const body = await ctx.req.json().catch(() => ({}));
  const caller = ctx.authUser?.login || ctx.authUser?.name;
  if (!caller) {
    return Response.json(
      { error: "Sign in to review this Slack message" },
      { status: 401 },
    );
  }
  const requestId = typeof body?.requestId === "string" ? body.requestId : "";
  const pending = pendingSlackComposers.get(sessionId);
  if (!pending || pending.request.id !== requestId) {
    return Response.json(
      { error: "Slack composer is no longer open" },
      { status: 409 },
    );
  }
  if (ctx.req.method === "DELETE") {
    if (!cancelPendingSlackComposer(sessionId, requestId)) {
      return Response.json(
        { error: "Slack message is already being sent" },
        { status: 409 },
      );
    }
    return Response.json({ status: "cancelled" });
  }

  const requestedScreenshots = Array.isArray(body?.screenshots)
    ? body.screenshots
    : [];
  if (
    requestedScreenshots.some(
      (path: unknown) =>
        typeof path !== "string" || !validFeaturedScreenshot(path),
    )
  ) {
    return Response.json(
      { error: "One or more Slack images are no longer available" },
      { status: 400 },
    );
  }
  const screenshots = [...new Set<string>(requestedScreenshots)].slice(0, 10);

  if (ctx.req.method === "PATCH") {
    const message = typeof body?.message === "string" ? body.message : "";
    if (slackMessageLength(message) > 500)
      return Response.json(
        { error: "Slack message must be 500 characters or fewer" },
        { status: 400 },
      );
    const channel =
      typeof body?.channel === "string" ? body.channel.trim() : "";
    const request = updatePendingSlackComposer(sessionId, requestId, {
      message,
      ...(channel ? { channel } : {}),
      images: screenshots,
    });
    if (!request) {
      return Response.json(
        { error: "Slack message is already being sent" },
        { status: 409 },
      );
    }
    return Response.json(request);
  }

  // The caller's own grant only widens which channels they can pick; the
  // message itself always goes out as the bot.
  const { mcpUserGrantToken } = await import("../mcp-oauth");
  const slackToken = mcpUserGrantToken("slack", caller);
  // The thread a Slack-started session came from posts as a reply there.
  const thread =
    body?.channel === SLACK_THREAD_TARGET
      ? await slackThreadTarget(
          await findSessionAsync(sessionId),
          configuredSlackChannels(),
        )
      : undefined;
  const channel = thread
    ? thread.channel
    : await targetChannel(
        body?.channel,
        slackToken ? { caller, token: slackToken } : undefined,
      );
  if (!channel)
    return Response.json(
      { error: "Choose a Slack channel you can post to" },
      { status: 400 },
    );
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (slackMessageLength(message) > 500)
    return Response.json(
      { error: "Slack message must be 500 characters or fewer" },
      { status: 400 },
    );
  if (!message && screenshots.length === 0) {
    return Response.json(
      { error: "Write a message or add an image first" },
      { status: 400 },
    );
  }

  if (!claimPendingSlackComposer(sessionId, requestId)) {
    return Response.json(
      { error: "Slack message is already being sent" },
      { status: 409 },
    );
  }
  try {
    const snapshottedScreenshots = snapshotPendingSlackImages(
      sessionId,
      requestId,
      screenshots,
    );
    const { ts, permalink } = await postAsSlackBot(
      channel,
      message,
      snapshottedScreenshots,
      {
        title: "Open Session update",
        altText: "Image attached to an Open Session update",
        sender: caller,
        sessionUrl: sessionLink(sessionId),
        ...(thread ? { threadTs: thread.threadTs } : {}),
      },
    );
    if (ts)
      rememberSentSlackComposerMessage(sessionId, {
        channelId: channel.id,
        ts,
        by: caller,
      });
    const sentTo = thread ? slackThreadReceipt(thread) : channel;
    sendPendingSlackComposer(sessionId, requestId, sentTo, permalink, ts);
    return Response.json({ status: "sent", channel: sentTo, permalink, ts });
  } catch (error: any) {
    restorePendingSlackComposer(sessionId, requestId);
    return Response.json(
      { error: error?.message || "Couldn't send to Slack" },
      { status: 502 },
    );
  }
}
