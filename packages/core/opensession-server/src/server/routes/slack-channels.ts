/**
 * Slack channel Conversation tab (the Plain-thread sibling for slack-channel
 * feed workspaces): paginated channel history + post-a-message. Human-gated
 * browser routes — agent runs post through the slack MCP instead.
 *
 * Identity: reads use the signed-in caller's Slack grant when they have one
 * (their visibility, incl. private channels), bot token otherwise. POSTING
 * requires the caller's own grant — messages appear AS THEM (that's the
 * point); without a grant the route 403s with a pointer to the Account page.
 */
import { z } from "zod";
import { embedFor } from "../../shared/slack-embed";
import type { RouteContext } from "./context";
import {
  SLACK_THREAD_TARGET,
  slackThreadOption,
  type SlackThreadTarget,
} from "../slack-thread-target";
import { configuredIntegration } from "../config";
import {
  mergeSlackChannels,
  slackChannelsForUser,
  type SlackChannelOption,
} from "../../agents/slack/channel-directory";

export type { SlackChannelOption };

export function configuredSlackChannels(): SlackChannelOption[] {
  const names = configuredIntegration("slack").channelNames;
  if (!names || typeof names !== "object" || Array.isArray(names)) return [];
  return Object.entries(names)
    .filter(
      ([id, name]) =>
        /^C[A-Z0-9]+$/.test(id) && typeof name === "string" && name.trim(),
    )
    .map(([id, name]) => ({ id, name: String(name).trim() }));
}

export function defaultSlackChannel(
  channels: SlackChannelOption[],
): string | undefined {
  return (
    channels.find((channel) => channel.name.toLowerCase() === "os")?.id ||
    channels.find((channel) => channel.name.toLowerCase() === "engineering")
      ?.id ||
    channels[0]?.id
  );
}

/** The isolated demo instance has no Slack grant, so the composer would
 *  offer nothing to search. A short synthetic directory stands in. */
function demoSlackChannels(): SlackChannelOption[] {
  return [
    "announcements",
    "design",
    "engineering",
    "general",
    "help-center",
    "launches",
    "proj-onboarding",
    "proj-search",
    "random",
    "support",
  ].map((name, index) => ({
    id: `CDEMO${String(index + 1).padStart(4, "0")}`,
    name,
  }));
}

function callerOf(ctx: Pick<RouteContext, "authUser">): string | undefined {
  return ctx.authUser?.login || ctx.authUser?.name || undefined;
}

const SLACK_TS = /^\d+\.\d+$/;

/** An edit: the message's ts and its new text. */
export const EditMessageBody = z.object({
  ts: z.string().regex(SLACK_TS),
  text: z.string().trim().min(1),
});

/** A file the composer uploaded, shared with the message that sends it. */
const SharedFile = z.object({
  id: z.string().regex(/^F[A-Z0-9]+$/),
  title: z.string().trim().min(1).max(255),
});

/** A post: text, files reserved through /uploads, or both. */
export const PostMessageBody = z
  .object({
    text: z.string().trim().default(""),
    thread_ts: z.string().regex(SLACK_TS).optional(),
    broadcast: z.boolean().optional(),
    files: z.array(SharedFile).max(10).default([]),
  })
  .refine((body) => body.text || body.files.length, "text or files required");

/** The name an upload carries in its header, made safe for Slack. */
export function uploadFileName(header: string | null): string | undefined {
  if (!header) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(header);
  } catch {
    return undefined;
  }
  const base = name
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f]/g, "")
    .trim();
  return base ? base.slice(0, 255) : undefined;
}

/** Slack search for messages that mention `self`, not counting their own. */
export function mentionsQuery(self: string): string {
  return `<@${self}> -from:<@${self}>`;
}

/** Search matches as the web shows them: each message with the
 *  conversation it is in, named for a person (a DM) or the group. */
async function searchResultViews(
  caller: string,
  grantToken: string,
  found: import("../../agents/slack/search").SearchPage,
) {
  const { messageConverter } = await import("../../agents/slack/message-view");
  const { resolveSlackUser } = await import("../../agents/slack/slack-api");
  const { groupMessageName } = await import("../../agents/slack/conversations");
  const convert = await messageConverter(caller, grantToken);
  const results = [];
  for (const { found: hit, raw } of found.matches) {
    const message = await convert(raw, { inThread: true });
    if (!message) continue;
    const channel = (raw as { channel?: { is_mpim?: boolean } }).channel;
    const channelName = channel?.is_mpim
      ? groupMessageName(hit.channelName)
      : hit.isDirect && /^U[A-Z0-9]+$/.test(hit.channelName)
        ? (await resolveSlackUser(hit.channelName).catch(() => null))?.name ||
          hit.channelName
        : hit.channelName;
    results.push({
      channelId: hit.channelId,
      channelName,
      isDirect: hit.isDirect,
      ...(hit.threadTs ? { threadTs: hit.threadTs } : {}),
      message,
    });
  }
  return results;
}

/** Slack's refusals of an edit or a delete, as one short sentence. */
export function messageChangeError(
  error: string | undefined,
  action: "edit" | "delete",
): string {
  switch (error) {
    case "cant_update_message":
    case "cant_delete_message":
      return `Slack doesn't let you ${action} this message`;
    case "edit_window_closed":
      return "The time to edit this message has passed";
    case "message_not_found":
      return "This message is gone";
    case "msg_too_long":
      return "That message is too long";
    case "missing_scope":
      return `Reconnect Slack in Settings, Account to ${action} from here`;
    default:
      return action === "edit"
        ? "Couldn't save the edit"
        : "Couldn't delete the message";
  }
}

/** `raw` when it names a file on Slack's own file host, else undefined. */
export function slackFileUrl(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return undefined;
    if (parsed.hostname !== "files.slack.com") return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** The demo instance's Slack sidebar: a few channels and people. */
function demoConversations() {
  const now = Date.now() / 1000;
  return {
    directMessages: true,
    conversations: [
      ...["design", "engineering", "general", "launches", "support"].map(
        (name, index) => ({
          id: `CDEMO${String(index + 1).padStart(4, "0")}`,
          name,
          kind: "channel" as const,
          unread: name === "engineering" || name === "launches",
        }),
      ),
      {
        id: "DDEMO0001",
        name: "Ada Lovelace",
        kind: "dm" as const,
        unread: true,
        unreadCount: 2,
        latestTs: String(now - 120),
      },
      {
        id: "DDEMO0002",
        name: "Grace Hopper",
        kind: "dm" as const,
        latestTs: String(now - 7200),
      },
    ],
  };
}

export {
  messageFiles,
  type SlackMessageFile,
} from "../../agents/slack/message-view";

export async function slackChannelsPayload(
  ctx: Pick<RouteContext, "authUser">,
  opts: {
    /** Add every channel the caller is a member of after the configured
     *  ones. The composer wants this; memory scopes want only the curated
     *  list. */
    everyChannel?: boolean;
    /** Preferred channel, when the feature has its own setting for one. */
    defaultChannel?: string;
    /** The Slack thread the session started from: listed first and
     *  preselected, since a Slack-started session reports back there. */
    thread?: SlackThreadTarget;
  } = {},
) {
  const configured = configuredSlackChannels();
  const caller = ctx.authUser?.login || ctx.authUser?.name || undefined;
  const { mcpUserGrantToken } = await import("../mcp-oauth");
  const grantToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
  // Drafts post as the bot, which carries files:write itself.
  const canUploadImages = Boolean(process.env.SLACK_BOT_TOKEN);
  const directory = !opts.everyChannel
    ? []
    : process.env.OPENSESSION_DEMO === "1"
      ? demoSlackChannels()
      : caller && grantToken
        ? await slackChannelsForUser(caller, grantToken)
        : [];
  const channels = mergeSlackChannels(configured, directory);
  const preferred = opts.thread
    ? SLACK_THREAD_TARGET
    : opts.defaultChannel &&
        channels.some((channel) => channel.id === opts.defaultChannel)
      ? opts.defaultChannel
      : defaultSlackChannel(configured) || channels[0]?.id;
  if (opts.thread) channels.unshift(slackThreadOption(opts.thread));
  return {
    channels,
    defaultChannel: preferred,
    canUploadImages,
  };
}

export async function handleSlackChannelRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path } = ctx;

  if (path === "/api/slack/channels" && req.method === "GET") {
    return Response.json(await slackChannelsPayload(ctx));
  }

  // The composer's "@" picker. Signed-in only: it is the workspace roster.
  if (path === "/api/slack/users" && req.method === "GET") {
    // The demo instance runs without sign-in and without Slack.
    if (process.env.OPENSESSION_DEMO === "1") {
      const { demoSlackMentionUsers } =
        await import("../../agents/slack/user-directory");
      return Response.json({ users: demoSlackMentionUsers() });
    }
    if (!ctx.authUser?.login && !ctx.authUser?.name)
      return Response.json({ error: "Sign in first" }, { status: 401 });
    const { demoSlackMentionUsers, slackMentionUsers } =
      await import("../../agents/slack/user-directory");
    const users =
      process.env.OPENSESSION_DEMO === "1"
        ? demoSlackMentionUsers()
        : await slackMentionUsers();
    return Response.json({ users });
  }

  // The Channels place: the caller's own Slack sidebar, through their grant.
  if (path === "/api/slack/conversations" && req.method === "GET") {
    // The demo instance runs without sign-in and without Slack.
    if (process.env.OPENSESSION_DEMO === "1")
      return Response.json({ connected: true, ...demoConversations() });
    const caller = callerOf(ctx);
    if (!caller)
      return Response.json({ error: "Sign in first" }, { status: 401 });
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const grantToken = mcpUserGrantToken("slack", caller);
    if (!grantToken)
      return Response.json({
        connected: false,
        conversations: [],
        directMessages: false,
      });
    try {
      const { slackConversationsForUser } =
        await import("../../agents/slack/conversations");
      return Response.json({
        connected: true,
        ...(await slackConversationsForUser(caller, grantToken)),
      });
    } catch (e: any) {
      return Response.json(
        { error: e?.message || "Slack did not answer" },
        { status: 502 },
      );
    }
  }

  // A Slack file (an image in a message) fetched with the caller's grant:
  // Slack serves private files only with a token, so the browser cannot load
  // them itself. Only Slack's own file host is fetched.
  if (path === "/api/slack/file" && req.method === "GET") {
    const caller = callerOf(ctx);
    if (!caller) return new Response("Sign in first", { status: 401 });
    const target = slackFileUrl(url.searchParams.get("url"));
    if (!target) return new Response("Not a Slack file", { status: 400 });
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const tokens = [
      mcpUserGrantToken("slack", caller),
      process.env.SLACK_BOT_TOKEN,
    ].filter((token): token is string => !!token);
    for (const token of tokens) {
      const res = await fetch(target, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
      }).catch(() => null);
      // Slack answers a token without access with its login page, not 403.
      const type = res?.headers.get("content-type") || "";
      if (!res?.ok || !type.startsWith("image/")) continue;
      return new Response(res.body, {
        headers: {
          "Content-Type": type,
          "Cache-Control": "private, max-age=86400",
        },
      });
    }
    return new Response("Not found", { status: 404 });
  }

  const reactMatch = path.match(/^\/api\/slack\/channels\/([^/]+)\/reactions$/);
  if (
    reactMatch &&
    req.method === "POST" &&
    process.env.OPENSESSION_DEMO === "1"
  )
    return demoReaction(req, decodeURIComponent(reactMatch[1]!));
  if (reactMatch && req.method === "POST") {
    const caller = callerOf(ctx);
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const grantToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
    if (!grantToken)
      return Response.json(
        { error: "Connect your Slack account in Settings → Account to react" },
        { status: 403 },
      );
    const body = (await req.json().catch(() => null)) as {
      ts?: string;
      name?: string;
      remove?: boolean;
    } | null;
    const name = body?.name?.replace(/^:|:$/g, "");
    if (!body?.ts || !name)
      return Response.json({ error: "ts and name required" }, { status: 400 });
    const { slackApiCall } = await import("../../agents/slack/slack-api");
    const res = await slackApiCall(
      body.remove ? "reactions.remove" : "reactions.add",
      { channel: decodeURIComponent(reactMatch[1]!), timestamp: body.ts, name },
      grantToken,
    ).catch(() => null);
    if (
      res?.ok ||
      res?.error === "already_reacted" ||
      res?.error === "no_reaction"
    )
      return Response.json({ ok: true });
    return Response.json(
      {
        error:
          res?.error === "missing_scope"
            ? "Reconnect Slack in Settings → Account to react from here"
            : res?.error || "reaction failed",
      },
      { status: res?.error === "missing_scope" ? 403 : 502 },
    );
  }

  // Threads and Sent: the person's own recent messages and the threads
  // they are in (agents/slack/my-threads.ts). `fresh=1` skips the cache.
  if (
    (path === "/api/slack/threads" || path === "/api/slack/sent") &&
    req.method === "GET"
  ) {
    const which = path.endsWith("threads") ? "threads" : "sent";
    if (process.env.OPENSESSION_DEMO === "1")
      return Response.json(
        which === "threads" ? { threads: demoThreads() } : demoSent(),
      );
    const caller = callerOf(ctx);
    if (!caller)
      return Response.json({ error: "Sign in first" }, { status: 401 });
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const grantToken = mcpUserGrantToken("slack", caller);
    if (!grantToken)
      return Response.json(
        { error: "Connect your Slack account in Settings, Account" },
        { status: 403 },
      );
    try {
      const { myThreadsAndSent } =
        await import("../../agents/slack/my-threads");
      const { messageConverter, renderSlackText } =
        await import("../../agents/slack/message-view");
      const { resolveSlackUser } = await import("../../agents/slack/slack-api");
      const { customEmojiMap, emojifySlackText } =
        await import("../../agents/slack/emoji");
      const { sent, threads } = await myThreadsAndSent(caller, grantToken, {
        fresh: url.searchParams.get("fresh") === "1",
      });
      // A direct message's channel name is the other person's user id.
      const nameOf = async (name: string, isDirect: boolean) =>
        isDirect && /^U[A-Z0-9]+$/.test(name)
          ? (await resolveSlackUser(name).catch(() => ({ name }))).name
          : name;
      if (which === "threads") {
        const convert = await messageConverter(caller, grantToken);
        const out = [];
        for (const thread of threads) {
          const parent = await convert(thread.parent);
          if (!parent) continue;
          const latest = [];
          for (const reply of thread.latest) {
            const view = await convert(reply, { inThread: true });
            if (view) latest.push(view);
          }
          out.push({
            channelId: thread.channelId,
            channelName: await nameOf(thread.channelName, thread.isDirect),
            isDirect: thread.isDirect,
            parent,
            latest,
            replyCount: thread.replyCount,
            latestReply: thread.latestReply,
          });
        }
        return Response.json({ threads: out });
      }
      const custom = await customEmojiMap(grantToken);
      const emojify = (t: string) => emojifySlackText(t, custom);
      const out = [];
      for (const message of sent) {
        out.push({
          channelId: message.channelId,
          channelName: await nameOf(message.channelName, message.isDirect),
          isDirect: message.isDirect,
          ts: message.ts,
          ...(message.threadTs ? { threadTs: message.threadTs } : {}),
          text: await renderSlackText(message.text, emojify),
        });
      }
      return Response.json({ messages: out });
    } catch (e: any) {
      return Response.json(
        {
          error:
            e?.message === "missing_scope"
              ? "Reconnect Slack in Settings, Account to see your threads"
              : e?.message || "Slack did not answer",
        },
        { status: 502 },
      );
    }
  }

  // Search across Slack as the caller (agents/slack/search.ts).
  if (path === "/api/slack/search" && req.method === "GET") {
    const query = (url.searchParams.get("q") || "").trim().slice(0, 500);
    if (!query) return Response.json({ error: "q required" }, { status: 400 });
    const page = Math.max(
      1,
      parseInt(url.searchParams.get("page") || "1", 10) || 1,
    );
    const sort =
      url.searchParams.get("sort") === "timestamp" ? "timestamp" : "score";
    if (process.env.OPENSESSION_DEMO === "1")
      return Response.json(demoSearch(query, sort));
    const caller = callerOf(ctx);
    if (!caller)
      return Response.json({ error: "Sign in first" }, { status: 401 });
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const grantToken = mcpUserGrantToken("slack", caller);
    if (!grantToken)
      return Response.json(
        { error: "Connect your Slack account in Settings, Account" },
        { status: 403 },
      );
    try {
      const { searchSlack } = await import("../../agents/slack/search");
      const found = await searchSlack(caller, grantToken, query, {
        page,
        sort,
      });
      return Response.json({
        results: await searchResultViews(caller, grantToken, found),
        total: found.total,
        page: found.page,
        pages: found.pages,
      });
    } catch (e: any) {
      return Response.json(
        {
          error:
            e?.message === "missing_scope"
              ? "Reconnect Slack in Settings, Account to search from here"
              : e?.message === "ratelimited"
                ? "Slack asked to slow down. Try again in a minute."
                : "Couldn't search Slack",
        },
        { status: e?.message === "missing_scope" ? 403 : 502 },
      );
    }
  }

  // Activity: the newest messages that mention the caller, by others.
  if (path === "/api/slack/activity" && req.method === "GET") {
    if (process.env.OPENSESSION_DEMO === "1")
      return Response.json({ items: demoActivity() });
    const caller = callerOf(ctx);
    if (!caller)
      return Response.json({ error: "Sign in first" }, { status: 401 });
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const grantToken = mcpUserGrantToken("slack", caller);
    if (!grantToken)
      return Response.json(
        { error: "Connect your Slack account in Settings, Account" },
        { status: 403 },
      );
    try {
      const { slackSelfId } = await import("../../agents/slack/conversations");
      const { searchSlack } = await import("../../agents/slack/search");
      const self = await slackSelfId(caller, grantToken);
      if (!self) throw new Error("Slack did not say who you are");
      const found = await searchSlack(caller, grantToken, mentionsQuery(self), {
        sort: "timestamp",
      });
      return Response.json({
        items: await searchResultViews(caller, grantToken, found),
      });
    } catch (e: any) {
      return Response.json(
        {
          error:
            e?.message === "missing_scope"
              ? "Reconnect Slack in Settings, Account to see your mentions"
              : "Couldn't load your mentions",
        },
        { status: e?.message === "missing_scope" ? 403 : 502 },
      );
    }
  }

  // A message's link in Slack, for Copy link and Open in Slack.
  const linkMatch = path.match(/^\/api\/slack\/channels\/([^/]+)\/permalink$/);
  if (linkMatch && req.method === "GET") {
    const channelId = decodeURIComponent(linkMatch[1]!);
    const ts = url.searchParams.get("ts") || "";
    if (!/^\d+\.\d+$/.test(ts))
      return Response.json({ error: "ts required" }, { status: 400 });
    if (process.env.OPENSESSION_DEMO === "1")
      return Response.json({
        url: `https://example.slack.com/archives/${channelId}/p${ts.replace(".", "")}`,
      });
    const caller = callerOf(ctx);
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const grantToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
    const { slackApiGet } = await import("../../agents/slack/slack-api");
    const res = await slackApiGet(
      "chat.getPermalink",
      { channel: channelId, message_ts: ts },
      grantToken,
    ).catch(() => null);
    if (!res?.ok || typeof res.permalink !== "string")
      return Response.json(
        { error: res?.error || "permalink failed" },
        { status: 502 },
      );
    return Response.json({ url: res.permalink });
  }

  // A conversation's header: name, kind, topic and member count.
  const infoMatch = path.match(/^\/api\/slack\/channels\/([^/]+)$/);
  if (infoMatch && req.method === "GET") {
    const channelId = decodeURIComponent(infoMatch[1]!);
    if (process.env.OPENSESSION_DEMO === "1") {
      const demo = demoConversations().conversations.find(
        (c) => c.id === channelId,
      );
      return demo
        ? Response.json({ ...demo, topic: "", memberCount: 8 })
        : Response.json({ error: "channel_not_found" }, { status: 404 });
    }
    const caller = callerOf(ctx);
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const grantToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
    const { slackApiGet, resolveSlackUser } =
      await import("../../agents/slack/slack-api");
    const { conversationKind, groupMessageName } =
      await import("../../agents/slack/conversations");
    const info = await slackApiGet(
      "conversations.info",
      { channel: channelId, include_num_members: true },
      grantToken,
    ).catch(() => null);
    if (!info?.ok)
      return Response.json(
        { error: info?.error || "channel_not_found" },
        { status: info?.error === "channel_not_found" ? 404 : 502 },
      );
    const channel = info.channel || {};
    const kind = conversationKind(channel);
    const user =
      kind === "dm" && typeof channel.user === "string"
        ? await resolveSlackUser(channel.user).catch(() => undefined)
        : undefined;
    return Response.json({
      id: channelId,
      kind,
      name:
        kind === "dm"
          ? user?.name || "Direct message"
          : kind === "group"
            ? groupMessageName(String(channel.name || ""))
            : String(channel.name || channelId),
      ...(user?.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      topic: String(channel.topic?.value || channel.purpose?.value || ""),
      ...(typeof channel.num_members === "number"
        ? { memberCount: channel.num_members }
        : {}),
    });
  }

  // Viewing the pane marks the channel read (as Slack itself does) — moves
  // the caller's OWN read cursor via their grant, so the sidebar unread dot
  // clears. No grant → no-op (the bot has no per-user cursor to move).
  const readMatch = path.match(/^\/api\/slack\/channels\/([^/]+)\/read$/);
  if (readMatch && req.method === "POST") {
    const caller = ctx.authUser?.login || ctx.authUser?.name || undefined;
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const grantToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
    if (!grantToken) return Response.json({ ok: false });
    const body = (await req.json().catch(() => null)) as {
      ts?: string;
    } | null;
    if (!body?.ts)
      return Response.json({ error: "ts required" }, { status: 400 });
    try {
      const { slackApiCall } = await import("../../agents/slack/slack-api");
      const res = await slackApiCall(
        "conversations.mark",
        { channel: decodeURIComponent(readMatch[1]), ts: body.ts },
        grantToken,
      );
      if (res?.ok) {
        const { invalidateFeedCache } = await import("../feeds");
        invalidateFeedCache("slack");
        const { markConversationRead } =
          await import("../../agents/slack/conversations");
        markConversationRead(
          caller!,
          decodeURIComponent(readMatch[1]),
          body.ts,
        );
      }
      return Response.json({ ok: !!res?.ok });
    } catch {
      return Response.json({ ok: false });
    }
  }

  const demoArtMatch = path.match(/^\/api\/slack\/demo-art\/([a-z]+\.svg)$/);
  if (demoArtMatch && process.env.OPENSESSION_DEMO === "1")
    return (
      demoArt(demoArtMatch[1]!) ?? new Response("Not found", { status: 404 })
    );

  // The demo instance keeps uploaded files in memory and serves them here.
  const demoFileMatch = path.match(/^\/api\/slack\/demo-files\/(FDEMO\d+)$/);
  if (demoFileMatch && process.env.OPENSESSION_DEMO === "1") {
    const file = demoFiles.get(demoFileMatch[1]!);
    return file
      ? new Response(file.bytes, { headers: { "Content-Type": file.type } })
      : new Response("Not found", { status: 404 });
  }

  // One file from the composer, sent on to Slack's upload URL with the
  // caller's grant. The message that sends it shares it (files in the POST
  // below), as Slack's own client does.
  const uploadMatch = path.match(/^\/api\/slack\/channels\/([^/]+)\/uploads$/);
  if (uploadMatch && req.method === "POST") {
    const name = uploadFileName(req.headers.get("x-file-name"));
    if (!name)
      return Response.json({ error: "x-file-name required" }, { status: 400 });
    const { MAX_SLACK_UPLOAD_BYTES } =
      await import("../../agents/slack/slack-api");
    if (Number(req.headers.get("content-length") || 0) > MAX_SLACK_UPLOAD_BYTES)
      return Response.json(
        { error: `${name} is too large (20 MB max)` },
        { status: 413 },
      );
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_SLACK_UPLOAD_BYTES)
      return Response.json(
        {
          error: bytes.byteLength
            ? `${name} is too large (20 MB max)`
            : `${name} is empty`,
        },
        { status: 413 },
      );
    if (process.env.OPENSESSION_DEMO === "1") {
      const id = `FDEMO${demoFiles.size + 1}`;
      demoFiles.set(id, {
        name,
        type: req.headers.get("content-type") || "application/octet-stream",
        bytes,
      });
      return Response.json({ id, title: name });
    }
    const caller = callerOf(ctx);
    const { mcpUserGrantToken } = await import("../mcp-oauth");
    const grantToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
    if (!grantToken)
      return Response.json(
        { error: "Connect your Slack account in Settings, Account to upload" },
        { status: 403 },
      );
    const { reserveSlackUpload } = await import("../../agents/slack/slack-api");
    try {
      const id = await reserveSlackUpload(name, bytes, undefined, grantToken);
      return Response.json({ id, title: name });
    } catch (e: any) {
      return Response.json(
        {
          error:
            e?.message === "SLACK_RECONNECT_REQUIRED"
              ? "Reconnect Slack in Settings, Account to upload from here"
              : `Couldn't upload ${name}`,
        },
        { status: e?.message === "SLACK_RECONNECT_REQUIRED" ? 403 : 502 },
      );
    }
  }

  const msgsMatch = path.match(/^\/api\/slack\/channels\/([^/]+)\/messages$/);
  if (!msgsMatch) return undefined;

  const channelId = decodeURIComponent(msgsMatch[1]);
  if (process.env.OPENSESSION_DEMO === "1")
    return demoChannelMessages(req, url, channelId);
  const caller = ctx.authUser?.login || ctx.authUser?.name || undefined;
  const { mcpUserGrantToken } = await import("../mcp-oauth");
  const grantToken = caller ? mcpUserGrantToken("slack", caller) : undefined;

  if (req.method === "GET") {
    // Newest page by default; `before=<ts>` pages older (exclusive), the
    // same shape the transcript's Load-history uses. `thread_ts=<ts>`
    // returns that thread's replies instead (parent excluded).
    const threadTs = url.searchParams.get("thread_ts") || undefined;
    const before = url.searchParams.get("before") || undefined;
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") || "40", 10) || 40, 1),
      100,
    );
    try {
      const { slackApiGet } = await import("../../agents/slack/slack-api");
      const { messageConverter } =
        await import("../../agents/slack/message-view");
      const convert = await messageConverter(caller, grantToken);
      const data = await slackApiGet(
        threadTs ? "conversations.replies" : "conversations.history",
        {
          channel: channelId,
          limit,
          ...(threadTs ? { ts: threadTs } : {}),
          ...(before ? { latest: before, inclusive: false } : {}),
        },
        grantToken,
      );
      if (threadTs && Array.isArray(data?.messages))
        data.messages = data.messages.filter((m: any) => m.ts !== threadTs);
      if (!data?.ok)
        return Response.json(
          { error: data?.error || "history failed" },
          { status: 502 },
        );
      // history arrives newest-first (reverse to chronological); thread
      // replies arrive oldest-first already.
      const chronological = threadTs
        ? [...(data.messages || [])]
        : [...(data.messages || [])].reverse();
      const out: unknown[] = [];
      for (const m of chronological) {
        const view = await convert(m, { inThread: !!threadTs });
        if (view) out.push(view);
      }
      return Response.json({
        messages: out,
        hasMore: !!data.has_more,
        asUser: !!grantToken,
      });
    } catch (e: any) {
      return Response.json(
        { error: e?.message || "history failed" },
        { status: 502 },
      );
    }
  }

  if (req.method === "POST") {
    const parsed = PostMessageBody.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsed.success)
      return Response.json({ error: "text required" }, { status: 400 });
    const body = parsed.data;
    if (!grantToken)
      return Response.json(
        {
          error:
            "Connect your Slack account in Settings, Account to post as yourself",
        },
        { status: 403 },
      );
    try {
      const { completeSlackUpload, slackApiCall } =
        await import("../../agents/slack/slack-api");
      // Files go out as one share with the text as its comment, as Slack's
      // client sends them. Slack has no "also send to channel" for a share.
      if (body.files.length) {
        await completeSlackUpload(
          channelId,
          body.files,
          body.text,
          body.thread_ts,
          grantToken,
        );
        return Response.json({ ok: true });
      }
      const res = await slackApiCall(
        "chat.postMessage",
        {
          channel: channelId,
          text: body.text,
          ...(body.thread_ts
            ? { thread_ts: body.thread_ts, reply_broadcast: !!body.broadcast }
            : {}),
        },
        grantToken,
      );
      if (!res?.ok)
        return Response.json(
          { error: res?.error || "post failed" },
          { status: 502 },
        );
      return Response.json({ ok: true, ts: res.ts });
    } catch (e: any) {
      return Response.json(
        { error: e?.message || "post failed" },
        { status: 502 },
      );
    }
  }

  // Edit or delete one of the caller's own messages, as them. Slack itself
  // refuses another person's message (cant_update_message).
  if (req.method === "PATCH" || req.method === "DELETE") {
    const action = req.method === "PATCH" ? "edit" : "delete";
    if (!grantToken)
      return Response.json(
        {
          error: `Connect your Slack account in Settings, Account to ${action}`,
        },
        { status: 403 },
      );
    const { slackApiCall } = await import("../../agents/slack/slack-api");
    if (action === "delete") {
      const ts = url.searchParams.get("ts") || "";
      if (!SLACK_TS.test(ts))
        return Response.json({ error: "ts required" }, { status: 400 });
      const res = await slackApiCall(
        "chat.delete",
        { channel: channelId, ts },
        grantToken,
      ).catch(() => null);
      if (res?.ok) return Response.json({ ok: true });
      return Response.json(
        { error: messageChangeError(res?.error, "delete") },
        { status: res?.error === "missing_scope" ? 403 : 502 },
      );
    }
    const body = EditMessageBody.safeParse(await req.json().catch(() => null));
    if (!body.success)
      return Response.json({ error: "ts and text required" }, { status: 400 });
    const res = await slackApiCall(
      "chat.update",
      { channel: channelId, ts: body.data.ts, text: body.data.text },
      grantToken,
    ).catch(() => null);
    if (!res?.ok)
      return Response.json(
        { error: messageChangeError(res?.error, "edit") },
        { status: res?.error === "missing_scope" ? 403 : 502 },
      );
    const stored =
      typeof res.message?.text === "string"
        ? res.message.text
        : String(res.text ?? body.data.text);
    return Response.json(await editedView(grantToken, stored));
  }

  return undefined;
}

/** What the web swaps into an edited message: its rendered text and the
 *  source it edits from next time. `stored` is the text as Slack saved it
 *  (chat.update echoes it, entities escaped). */
async function editedView(
  grantToken: string,
  stored: string,
): Promise<{ ok: true; text: string; source: string }> {
  const { customEmojiMap, emojifySlackText } =
    await import("../../agents/slack/emoji");
  const { editableSource, renderSlackText } =
    await import("../../agents/slack/message-view");
  const custom = await customEmojiMap(grantToken);
  return {
    ok: true,
    text: await renderSlackText(stored, (t) => emojifySlackText(t, custom)),
    source: editableSource(stored),
  };
}

/** The demo instance's uploads, by their FDEMO id. */
const demoFiles = new Map<
  string,
  { name: string; type: string; bytes: Uint8Array<ArrayBuffer> }
>();

// The demo instance has no Slack: each demo conversation keeps a short,
// in-memory history so the Channels place can be shown and posted to.
const demoHistories = new Map<string, any[]>();
function demoHistory(channelId: string): any[] {
  let history = demoHistories.get(channelId);
  if (history) return history;
  const now = Math.floor(Date.now() / 1000);
  const people = [
    { userName: "Ada Lovelace", userId: "UDEMOADA" },
    { userName: "Grace Hopper", userId: "UDEMOGRACE" },
    { userName: "Alan Turing", userId: "UDEMOALAN" },
  ];
  const lines = [
    "Morning! The new onboarding flow is on staging.",
    "Nice. I'll give it a spin after standup.",
    "Found one thing: the second step skips the avatar upload on Safari.",
    "Good catch, I'll pick it up.",
    "Shipped the fix, it's on staging again.",
    "Looks great now 🎉",
  ];
  // The fourth line is the demo reader's own, so Edit and Delete show.
  const you = { userName: "You", userId: "UDEMOYOU", mine: true };
  history = lines.map((text, index) => ({
    ts: `${now - 86400 - (lines.length - index) * 900}.000100`,
    text,
    ...(index === 3
      ? { ...you, source: text }
      : people[index % people.length]!),
    isBot: false,
    replyCount: index === 2 ? 2 : 0,
    ...(index === 2
      ? {
          replyUsers: [{ name: "Grace Hopper" }, { name: "Alan Turing" }],
        }
      : {}),
    reactions:
      index === 5 ? [{ name: "tada", count: 3, emoji: "🎉", mine: true }] : [],
  }));
  history.push({
    ts: `${now - 600}.000100`,
    text: "Release notes for this week are in the doc, shout if anything is missing.",
    ...people[0]!,
    isBot: false,
    replyCount: 0,
    reactions: [{ name: "eyes", count: 1, emoji: "👀" }],
  });
  // #launches carries what apps post: a pull request card, an issue laid
  // out in blocks, and a link preview.
  if (channelId === "CDEMO0004") history.push(...demoAppMessages(now));
  demoHistories.set(channelId, history);
  return history;
}

/** App and bot messages for the demo, already in the web's shape. */
function demoAppMessages(now: number) {
  const app = (userName: string) => ({
    userName,
    isBot: true,
    replyCount: 0,
    reactions: [],
  });
  return [
    {
      ...app("GitHub"),
      ts: `${now - 3000}.000100`,
      text: "",
      attachments: [
        {
          color: "36a64f",
          title: "#42 Fix avatar upload on Safari",
          titleLink: "https://example.test/acme/web/pull/42",
          text: "The file input's *accept* attribute dropped HEIC. This widens it and adds a test.",
          fields: [
            { title: "Reviewers", value: "Grace Hopper", short: true },
            { title: "Checks", value: "12 passed", short: true },
          ],
          footer: "[acme/web](https://example.test/acme/web)",
        },
      ],
    },
    {
      ...app("Linear"),
      ts: `${now - 2400}.000100`,
      text: "",
      blocks: [
        { type: "header", text: "Onboarding: second step skips avatar" },
        {
          type: "section",
          text: "*ENG-118* moved to *In review* by Alan Turing",
          fields: ["*Priority*\nHigh", "*Cycle*\nCycle 24"],
        },
        {
          type: "context",
          items: [
            {
              kind: "image",
              image: { url: "/api/slack/demo-art/avatar.svg", alt: "" },
            },
            { kind: "text", text: "Alan Turing · Onboarding project" },
          ],
        },
        {
          type: "actions",
          buttons: [
            {
              text: "Open issue",
              url: "https://example.test/acme/issue/ENG-118",
            },
            { text: "Assign to me" },
          ],
        },
      ],
    },
    {
      ts: `${now - 1800}.000100`,
      userName: "Ada Lovelace",
      userId: "UDEMOADA",
      isBot: false,
      replyCount: 0,
      reactions: [],
      text: "Launch post draft: https://example.test/blog/onboarding-v2",
      attachments: [
        {
          service: { name: "Acme blog" },
          title: "Onboarding v2: a faster first five minutes",
          titleLink: "https://example.test/blog/onboarding-v2",
          text: "Three steps instead of six, an avatar upload that works everywhere, and a tour you can skip.",
          image: {
            url: "/api/slack/demo-art/cover.svg",
            alt: "Onboarding v2",
            width: 640,
            height: 336,
          },
        },
      ],
    },
    {
      ts: `${now - 1200}.000100`,
      userName: "Grace Hopper",
      userId: "UDEMOGRACE",
      isBot: false,
      replyCount: 0,
      reactions: [],
      text: "The walkthrough from Friday: https://youtu.be/aqz-KE-bpKQ",
      attachments: [
        {
          service: { name: "YouTube" },
          title: "Onboarding v2 walkthrough",
          titleLink: "https://youtu.be/aqz-KE-bpKQ",
          embed: embedFor("https://youtu.be/aqz-KE-bpKQ"),
          image: {
            url: "/api/slack/demo-art/cover.svg",
            alt: "Onboarding v2 walkthrough",
            width: 640,
            height: 336,
          },
        },
      ],
    },
    {
      ts: `${now - 900}.000100`,
      userName: "Alan Turing",
      userId: "UDEMOALAN",
      isBot: false,
      replyCount: 0,
      reactions: [],
      text: "Someone posted a clip of it: https://x.com/acme/status/1800000000000000000",
      attachments: [
        {
          service: { name: "X (formerly Twitter)" },
          title: "Acme (@acme) on X",
          titleLink: "https://x.com/acme/status/1800000000000000000",
          text: "Onboarding in three steps instead of six. Here is the new flow.",
          embed: embedFor("https://x.com/acme/status/1800000000000000000"),
          image: {
            url: "/api/slack/demo-art/cover.svg",
            alt: "",
            width: 640,
            height: 336,
          },
        },
      ],
    },
  ];
}

/** Pictures for the demo's app messages, drawn here so it needs no network. */
function demoArt(name: string): Response | undefined {
  const svg =
    name === "avatar.svg"
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#7b6cf6"/><text x="16" y="21" font-size="14" font-family="sans-serif" fill="#fff" text-anchor="middle">AT</text></svg>`
      : name === "cover.svg"
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 336"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#5b8def"/><stop offset="1" stop-color="#a46ce8"/></linearGradient></defs><rect width="640" height="336" fill="url(#g)"/><text x="320" y="180" font-size="44" font-family="sans-serif" font-weight="700" fill="#fff" text-anchor="middle">Onboarding v2</text></svg>`
        : undefined;
  return svg
    ? new Response(svg, { headers: { "Content-Type": "image/svg+xml" } })
    : undefined;
}

async function demoChannelMessages(
  req: Request,
  url: URL,
  channelId: string,
): Promise<Response> {
  const history = demoHistory(channelId);
  if (req.method === "GET") {
    const threadTs = url.searchParams.get("thread_ts");
    if (threadTs) {
      const replies = demoHistories.get(`${channelId}:${threadTs}`) ?? [
        {
          ts: `${Math.floor(Number(threadTs)) + 60}.000200`,
          text: "Same here on Safari 18.",
          userName: "Grace Hopper",
          isBot: false,
          replyCount: 0,
          reactions: [],
        },
        {
          ts: `${Math.floor(Number(threadTs)) + 120}.000300`,
          text: "It's the file input's accept attribute, fix incoming.",
          userName: "Alan Turing",
          isBot: false,
          replyCount: 0,
          reactions: [],
        },
      ];
      demoHistories.set(`${channelId}:${threadTs}`, replies);
      return Response.json({ messages: replies, hasMore: false, asUser: true });
    }
    return Response.json({ messages: history, hasMore: false, asUser: true });
  }
  if (req.method === "POST") {
    const parsed = PostMessageBody.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsed.success)
      return Response.json({ error: "text required" }, { status: 400 });
    const body = parsed.data;
    const text = body.text;
    const files = body.files.map((shared) => {
      const file = demoFiles.get(shared.id);
      return {
        name: shared.title,
        ...(file?.type.startsWith("image/")
          ? { thumb: `/api/slack/demo-files/${shared.id}` }
          : {}),
      };
    });
    const message = {
      ts: `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1000).padStart(6, "0")}`,
      text,
      ...(files.length ? { files } : {}),
      source: text,
      mine: true,
      userId: "UDEMOYOU",
      userName: "You",
      isBot: false,
      replyCount: 0,
      reactions: [],
    };
    if (body?.thread_ts) {
      const key = `${channelId}:${body.thread_ts}`;
      demoHistories.set(key, [...(demoHistories.get(key) ?? []), message]);
      const parent = history.find((m) => m.ts === body.thread_ts);
      if (parent) parent.replyCount = (parent.replyCount || 0) + 1;
    } else history.push(message);
    return Response.json({ ok: true, ts: message.ts });
  }
  if (req.method === "PATCH" || req.method === "DELETE") {
    // A thread's replies live under `<channel>:<parent ts>`.
    const lists = [...demoHistories.entries()]
      .filter(([key]) => key === channelId || key.startsWith(`${channelId}:`))
      .map(([, list]) => list);
    if (req.method === "DELETE") {
      const ts = url.searchParams.get("ts");
      for (const list of lists) {
        const index = list.findIndex((m) => m.ts === ts && m.mine);
        if (index >= 0) {
          list.splice(index, 1);
          return Response.json({ ok: true });
        }
      }
      return Response.json(
        { error: messageChangeError("cant_delete_message", "delete") },
        { status: 502 },
      );
    }
    const body = EditMessageBody.safeParse(await req.json().catch(() => null));
    if (!body.success)
      return Response.json({ error: "ts and text required" }, { status: 400 });
    const message = lists.flat().find((m) => m.ts === body.data.ts && m.mine);
    if (!message)
      return Response.json(
        { error: messageChangeError("cant_update_message", "edit") },
        { status: 502 },
      );
    message.text = body.data.text;
    message.source = body.data.text;
    message.edited = true;
    return Response.json({
      ok: true,
      text: body.data.text,
      source: body.data.text,
    });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

async function demoReaction(
  req: Request,
  channelId: string,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    ts?: string;
    name?: string;
    remove?: boolean;
  } | null;
  const message = demoHistory(channelId).find((m) => m.ts === body?.ts);
  if (!message || !body?.name)
    return Response.json({ error: "message_not_found" }, { status: 404 });
  const reactions: any[] = message.reactions ?? [];
  const existing = reactions.find((r) => r.name === body.name);
  if (body.remove) {
    if (existing?.mine) {
      existing.count -= 1;
      existing.mine = false;
    }
  } else if (existing && !existing.mine) {
    existing.count += 1;
    existing.mine = true;
  } else if (!existing) {
    const { reactionDisplay } = await import("../../agents/slack/emoji");
    reactions.push({
      name: body.name,
      count: 1,
      mine: true,
      ...reactionDisplay(body.name, new Map()),
    });
  }
  message.reactions = reactions.filter((r) => r.count > 0);
  return Response.json({ ok: true });
}

/** Search over the demo's in-memory conversations. */
function demoSearch(query: string, sort: "score" | "timestamp") {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const conversations = demoConversations().conversations;
  const results = [];
  for (const conversation of conversations) {
    const history = demoHistory(conversation.id);
    const threads = [...demoHistories.entries()].filter(([key]) =>
      key.startsWith(`${conversation.id}:`),
    );
    const candidates = [
      ...history.map((message) => ({ message, threadTs: undefined })),
      ...threads.flatMap(([key, replies]) =>
        replies.map((message) => ({
          message,
          threadTs: key.slice(conversation.id.length + 1),
        })),
      ),
    ];
    for (const { message, threadTs } of candidates) {
      const text = String(message.text || "").toLowerCase();
      if (!words.every((word) => text.includes(word))) continue;
      results.push({
        channelId: conversation.id,
        channelName: conversation.name,
        isDirect: conversation.kind === "dm",
        ...(threadTs ? { threadTs } : {}),
        message: { ...message, replyCount: 0 },
      });
    }
  }
  if (sort === "timestamp")
    results.sort((a, b) => Number(b.message.ts) - Number(a.message.ts));
  return { results, total: results.length, page: 1, pages: 1 };
}

/** The demo's mentions of its reader, newest first. */
function demoActivity() {
  const now = Math.floor(Date.now() / 1000);
  const people = {
    ada: { userName: "Ada Lovelace", userId: "UDEMOADA" },
    grace: { userName: "Grace Hopper", userId: "UDEMOGRACE" },
    alan: { userName: "Alan Turing", userId: "UDEMOALAN" },
  };
  const item = (
    channelId: string,
    channelName: string,
    isDirect: boolean,
    who: { userName: string; userId: string },
    ago: number,
    text: string,
    threadTs?: string,
  ) => ({
    channelId,
    channelName,
    isDirect,
    ...(threadTs ? { threadTs } : {}),
    message: {
      ts: `${now - ago}.000100`,
      text,
      ...who,
      isBot: false,
      replyCount: 0,
      reactions: [],
    },
  });
  const design = demoHistory("CDEMO0001")[2];
  return [
    item(
      "CDEMO0002",
      "engineering",
      false,
      people.grace,
      300,
      "[[@You]] can you sign off the release notes before 4?",
    ),
    item(
      "CDEMO0001",
      "design",
      false,
      people.alan,
      3600,
      "[[@You]] the Safari fix is ready for a look",
      design?.ts,
    ),
    item(
      "CDEMO0004",
      "launches",
      false,
      people.ada,
      86400 + 600,
      "Thanks [[@You]], the launch post reads much better now.",
    ),
  ];
}

function demoThreads() {
  const parent = demoHistory("CDEMO0001")[2];
  const key = `CDEMO0001:${parent.ts}`;
  const replies = demoHistories.get(key) ?? [
    {
      ts: `${Math.floor(Number(parent.ts)) + 60}.000200`,
      text: "Same here on Safari 18.",
      userName: "Grace Hopper",
      isBot: false,
      replyCount: 0,
      reactions: [],
    },
    {
      ts: `${Math.floor(Number(parent.ts)) + 120}.000300`,
      text: "It's the file input's *accept* attribute, fix incoming.",
      userName: "Alan Turing",
      isBot: false,
      replyCount: 0,
      reactions: [{ name: "+1", count: 2, emoji: "👍" }],
    },
  ];
  demoHistories.set(key, replies);
  const release = demoHistory("CDEMO0002").at(-1);
  const now = Math.floor(Date.now() / 1000);
  return [
    {
      channelId: "CDEMO0001",
      channelName: "design",
      isDirect: false,
      parent,
      latest: replies.slice(-2),
      replyCount: replies.length,
      latestReply: replies.at(-1).ts,
    },
    {
      channelId: "CDEMO0002",
      channelName: "engineering",
      isDirect: false,
      parent: { ...release, replyCount: 4 },
      latest: [
        {
          ts: `${now - 400}.000100`,
          text: "Added the billing changes under *Fixes*.",
          userName: "Grace Hopper",
          isBot: false,
          replyCount: 0,
          reactions: [],
        },
        {
          ts: `${now - 200}.000100`,
          text: "Thanks, shipping it at 4.",
          userName: "Ada Lovelace",
          isBot: false,
          replyCount: 0,
          reactions: [],
        },
      ],
      replyCount: 4,
      latestReply: `${now - 200}.000100`,
    },
  ];
}

function demoSent() {
  const now = Math.floor(Date.now() / 1000);
  return {
    messages: [
      {
        channelId: "CDEMO0002",
        channelName: "engineering",
        isDirect: false,
        ts: `${now - 300}.000100`,
        threadTs: `${now - 600}.000100`,
        text: "Can we hold the release until the billing fix lands?",
      },
      {
        channelId: "DDEMO0001",
        channelName: "Ada Lovelace",
        isDirect: true,
        ts: `${now - 3600}.000100`,
        text: "Sure, I'll look at it after lunch.",
      },
      {
        channelId: "CDEMO0001",
        channelName: "design",
        isDirect: false,
        ts: `${now - 86400 * 2}.000100`,
        text: "New onboarding mocks are in the *Figma* file.",
      },
    ],
  };
}
