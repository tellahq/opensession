import {
  forgetShippedChangeAnnouncement,
  shareShippedVisualChange,
  shippedChangeChannels,
} from "../../agents/github/shipped-change-notify";
import { slackChannelsPayload } from "./slack-channels";
import { deleteSlackMessage } from "../../agents/slack/slack-api";
import { shippedChangesChannel } from "../../agents/github/constants";
import { suggestShippedChangeMessage } from "../shipped-change-suggestion";
import {
  channelsUsedForRepo,
  recentChannelUses,
  recordChannelUse,
} from "../shipped-change-channel-history";
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
    const pr = await prHostFor(getRepo(target.repoId)).getPrDetails(
      target.branch,
      target.ghRepo,
    );
    if (!pr)
      return Response.json(
        { error: "Pull request not found" },
        { status: 404 },
      );
    // Candidates: the configured channels, plus any this repository's
    // updates went to before. The person's full channel directory runs to
    // hundreds and is theirs to search; the pick only has to start well.
    const [recentChannels, examples] = await Promise.all([
      channelsUsedForRepo(target.ghRepo),
      recentChannelUses(),
    ]);
    const channels = [...shippedChangeChannels()];
    for (const channel of [
      ...recentChannels,
      ...examples.map((use) => ({ id: use.channelId, name: use.channelName })),
    ])
      if (!channels.some((known) => known.id === channel.id))
        channels.push({ id: channel.id, name: channel.name });
    const suggestion = await suggestShippedChangeMessage({
      session,
      pr: { number: pr.number, title: pr.title, body: pr.body },
      repo: target.ghRepo,
      channels,
      recentChannels,
      examples,
      user: ctx.authUser?.login || ctx.authUser?.name || requestUser(ctx),
    });
    return Response.json({
      message: suggestion?.message ?? null,
      channel: suggestion?.channel ?? null,
    });
  }
  if (req.method === "GET") {
    return Response.json(
      await slackChannelsPayload(ctx, {
        everyChannel: true,
        defaultChannel: shippedChangesChannel(),
      }),
    );
  }
  const body = await req.json().catch(() => ({}));
  const caller =
    ctx.authUser?.login || ctx.authUser?.name || requestUser(ctx, body?.user);
  const { mcpUserGrantToken } = await import("../mcp-oauth");
  const slackToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
  // PUT is undo: take the message back out of Slack and drop the receipt, so
  // the card offers the send again.
  if (req.method === "PUT") {
    const at = typeof body?.at === "string" ? body.at : "";
    const share = session.slackShares?.find((candidate) => candidate.at === at);
    if (!share || !share.ts)
      return Response.json(
        { error: "That message can no longer be undone" },
        { status: 409 },
      );
    if (!slackToken)
      return Response.json(
        { error: "Connect your Slack account in Settings → Account" },
        { status: 403 },
      );
    try {
      await deleteSlackMessage(share.channelId, share.ts, slackToken);
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
    if (share) {
      await recordChannelUse(target.ghRepo, {
        channelId: share.channelId,
        channelName: share.channelName,
        at: share.at,
        summary: typeof body?.message === "string" ? body.message : undefined,
      });
      await updateSessionFile(session.id, (data) => ({
        ...data,
        slackShares: [...(data.slackShares || []), share].slice(-20),
      }));
    }
    return Response.json({ ...result, share });
  } catch (error: any) {
    if (error?.message === "SLACK_RECONNECT_REQUIRED") {
      return Response.json(
        { error: "Reconnect Slack to add image access, then send again" },
        { status: 403 },
      );
    }
    return Response.json(
      { error: error?.message || "Couldn't share the shipped update" },
      { status: 502 },
    );
  }
}
