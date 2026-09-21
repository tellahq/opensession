import {
  deleteSlackMessage,
  postSlackFiles,
  sendSlackMessage,
  slackPermalink,
  slackUploadTs,
} from "../../agents/slack/slack-api";
import { validFeaturedScreenshot } from "../../agents/github/shipped-change-notify";
import {
  cancelPendingSlackComposer,
  claimPendingSlackComposer,
  openSlackComposer,
  pendingSlackComposers,
  restorePendingSlackComposer,
  sendPendingSlackComposer,
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
      void openSlackComposer(sessionId, {
        message: typeof body?.message === "string" ? body.message : "",
      });
      return Response.json(pendingSlackComposers.get(sessionId)!.request);
    } catch (error: any) {
      return Response.json(
        { error: error?.message || "Couldn't open the Slack composer" },
        { status: 409 },
      );
    }
  }
  // Undo: take a message this person just sent back out of Slack. Their own
  // user token is the authority, so Slack refuses anything that isn't theirs.
  const undoMatch = ctx.path.match(
    /^\/api\/sessions\/([^/]+)\/slack-composer\/undo$/,
  );
  if (undoMatch && ctx.req.method === "POST") {
    const caller = ctx.authUser?.login || ctx.authUser?.name;
    if (!caller) {
      return Response.json(
        { error: "Sign in to undo this Slack message" },
        { status: 401 },
      );
    }
    const body = await ctx.req.json().catch(() => ({}));
    // Deleting needs only the id, and Slack itself refuses anything that
    // isn't the caller's own message, so the id does not have to be listed.
    const channelId =
      typeof body?.channel === "string" && isSlackChannelId(body.channel.trim())
        ? body.channel.trim()
        : "";
    const ts = typeof body?.ts === "string" ? body.ts : "";
    if (!channelId || !ts) {
      return Response.json(
        { error: "That message can no longer be undone" },
        { status: 409 },
      );
    }
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const slackToken = mcpUserGrantToken("slack", caller);
    if (!slackToken) {
      return Response.json(
        { error: "Connect your Slack account in Settings → Account" },
        { status: 403 },
      );
    }
    try {
      await deleteSlackMessage(channelId, ts, slackToken);
    } catch (error: any) {
      return Response.json(
        { error: error?.message || "Couldn't undo the Slack message" },
        { status: 502 },
      );
    }
    return Response.json({ status: "undone" });
  }
  const match = ctx.path.match(/^\/api\/sessions\/([^/]+)\/slack-composer$/);
  if (!match || !["GET", "POST", "PATCH", "DELETE"].includes(ctx.req.method))
    return;
  const sessionId = decodeURIComponent(match[1]);
  if (ctx.req.method === "GET")
    return Response.json(
      await slackChannelsPayload(ctx, { everyChannel: true }),
    );
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
    if (message.length > 500)
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

  const { mcpUserGrantToken } = await import("../mcp-oauth");
  const slackToken = mcpUserGrantToken("slack", caller);
  const channel = await targetChannel(
    body?.channel,
    slackToken ? { caller, token: slackToken } : undefined,
  );
  if (!channel)
    return Response.json(
      { error: "Choose a Slack channel you can post to" },
      { status: 400 },
    );
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (message.length > 500)
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

  if (!slackToken) {
    return Response.json(
      {
        error:
          "Connect your Slack account in Settings → Account to post as yourself",
      },
      { status: 403 },
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
    let ts: string | undefined;
    if (snapshottedScreenshots.length > 0) {
      const completed = await postSlackFiles(
        channel.id,
        snapshottedScreenshots,
        message,
        {
          title: "Open Session update",
          altText: "Image attached to an Open Session update",
        },
        slackToken,
      );
      ts = await slackUploadTs(completed, channel.id, slackToken);
    } else {
      const posted = await sendSlackMessage(
        channel.id,
        message,
        undefined,
        slackToken,
      );
      if (!posted?.ok)
        throw new Error(posted?.error || "Slack returned an invalid response");
      ts = typeof posted.ts === "string" ? posted.ts : undefined;
    }
    const permalink = ts
      ? await slackPermalink(channel.id, ts, slackToken)
      : undefined;
    sendPendingSlackComposer(sessionId, requestId, channel, permalink, ts);
    return Response.json({ status: "sent", channel, permalink, ts });
  } catch (error: any) {
    restorePendingSlackComposer(sessionId, requestId);
    if (
      /SLACK_RECONNECT_REQUIRED|missing_scope|not_allowed_token_type/.test(
        error?.message || "",
      )
    ) {
      return Response.json(
        { error: "Reconnect Slack to add image access, then send again" },
        { status: 403 },
      );
    }
    return Response.json(
      { error: error?.message || "Couldn't send to Slack" },
      { status: 502 },
    );
  }
}
