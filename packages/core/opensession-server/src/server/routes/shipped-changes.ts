import {
  forgetShippedChangeAnnouncement,
  shareShippedVisualChange,
  shippedChangeChannels,
} from "../../agents/github/shipped-change-notify";
import { slackChannelsPayload } from "./slack-channels";
import { deleteSlackMessage } from "../../agents/slack/slack-api";
import { shippedChangesChannel } from "../../agents/github/constants";
import { draftShippedChange } from "../shipped-change-draft";
import { recordChannelUse } from "../shipped-change-channel-history";
import {
  SLACK_THREAD_TARGET,
  sessionSlackThread,
  slackThreadTarget,
} from "../slack-thread-target";
import { findSessionAsync, updateSessionFile } from "../session-cache";
import type { SessionSlackShare } from "../types";
import { resolvePrTarget } from "../session-repos";
import { prHostFor } from "../pr-host";
import { getRepo } from "../worktree";
import { requestUser, type RouteContext } from "./context";

export async function handleShippedChangeRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path, url } = ctx;
  const match = path.match(
    /^\/api\/sessions\/([^/]+)\/share-shipped-change(\/suggestion)?$/,
  );
  if (
    !match ||
    (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT")
  )
    return;
  const session = await findSessionAsync(decodeURIComponent(match[1]));
  if (!session)
    return Response.json({ error: "Session not found" }, { status: 404 });
  // The card's first draft, written from the whole session rather than the
  // PR title. Null tells the card to keep its title-based fallback.
  if (match[2]) {
    if (req.method !== "GET") return;
    const target = resolvePrTarget(
      session,
      url.searchParams.get("repo"),
      url.searchParams.get("branch"),
    );
    if (!target)
      return Response.json(
        { error: "Pull request target not found" },
        { status: 404 },
      );
    // Written in the background when the turn that merged it ended
    // (shipped-change-draft.ts), and saved on the session, so this is usually
    // a read. Otherwise it is written now and saved even if the viewer leaves.
    const draft = await draftShippedChange(
      session,
      target,
      ctx.authUser?.login || ctx.authUser?.name || requestUser(ctx),
    );
    if (draft === undefined)
      return Response.json(
        { error: "Pull request not found" },
        { status: 404 },
      );
    // A session started from a Slack thread reports back in that thread.
    const thread = sessionSlackThread(session);
    return Response.json({
      message: draft?.message ?? null,
      channel: thread ? SLACK_THREAD_TARGET : (draft?.channel ?? null),
    });
  }
  if (req.method === "GET") {
    const thread = await slackThreadTarget(session, shippedChangeChannels());
    return Response.json(
      await slackChannelsPayload(ctx, {
        everyChannel: true,
        defaultChannel: shippedChangesChannel(),
        ...(thread ? { thread } : {}),
      }),
    );
  }
  const body = await req.json().catch(() => ({}));
  const caller =
    ctx.authUser?.login || ctx.authUser?.name || requestUser(ctx, body?.user);
  const { mcpUserGrantToken } = await import("../mcp-oauth");
  const slackToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
  // PUT is undo: take the message back out of Slack and drop the receipt, so
  // the card offers the send again. The bot posted it, so the bot deletes it,
  // and only for the person the receipt names.
  if (req.method === "PUT") {
    const at = typeof body?.at === "string" ? body.at : "";
    const share = session.slackShares?.find((candidate) => candidate.at === at);
    if (!share || !share.ts || (share.by && share.by !== caller))
      return Response.json(
        { error: "That message can no longer be undone" },
        { status: 409 },
      );
    try {
      await deleteSlackMessage(share.channelId, share.ts);
    } catch (error: any) {
      return Response.json(
        { error: error?.message || "Couldn't undo the Slack message" },
        { status: 502 },
      );
    }
    if (share.announcementKey)
      forgetShippedChangeAnnouncement(share.announcementKey);
    await updateSessionFile(session.id, (data) => ({
      ...data,
      slackShares: (data.slackShares || []).filter(
        (candidate) => candidate.at !== at,
      ),
    }));
    return Response.json({ status: "undone" });
  }
  const target = resolvePrTarget(session, body?.repo, body?.branch);
  if (!target)
    return Response.json(
      { error: "Pull request target not found" },
      { status: 404 },
    );
  const repo = getRepo(target.repoId);
  const pr = await prHostFor(repo).getPrDetails(target.branch, target.ghRepo);
  if (!pr)
    return Response.json({ error: "Pull request not found" }, { status: 404 });
  if (pr.state !== "MERGED")
    return Response.json(
      { error: "Share to Slack is available after the pull request merges" },
      { status: 409 },
    );

  const thread =
    body?.channel === SLACK_THREAD_TARGET
      ? await slackThreadTarget(session, shippedChangeChannels())
      : undefined;
  if (body?.channel === SLACK_THREAD_TARGET && !thread)
    return Response.json(
      { error: "This session has no Slack thread to reply in" },
      { status: 400 },
    );
  try {
    const result = await shareShippedVisualChange({
      session,
      pr: { number: pr.number, title: pr.title, url: pr.url },
      repoFullName: target.ghRepo,
      requestedBy: requestUser(ctx, body?.user),
      channel: body?.channel,
      message: body?.message,
      caller,
      slackToken,
      ...(thread ? { thread } : {}),
      screenshots: Array.isArray(body?.screenshots)
        ? body.screenshots.filter(
            (path: unknown): path is string => typeof path === "string",
          )
        : undefined,
    });
    // The receipt is what collapses the share card, on reload and for every
    // other viewer, so record it before answering.
    const share: SessionSlackShare | undefined = result.channel && {
      channelId: result.channel.id,
      channelName: result.channel.name,
      permalink: result.permalink,
      at: new Date().toISOString(),
      by: caller,
      prNumber: pr.number,
      ...(result.ts ? { ts: result.ts } : {}),
      ...(result.announcementKey
        ? { announcementKey: result.announcementKey }
        : {}),
    };
    if (share && !thread)
      await recordChannelUse(target.ghRepo, {
        channelId: share.channelId,
        channelName: share.channelName,
        at: share.at,
        summary: typeof body?.message === "string" ? body.message : undefined,
      });
    if (share) {
      await updateSessionFile(session.id, (data) => ({
        ...data,
        slackShares: [...(data.slackShares || []), share].slice(-20),
      }));
    }
    return Response.json({ ...result, share });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Couldn't share the shipped update" },
      { status: 502 },
    );
  }
}
