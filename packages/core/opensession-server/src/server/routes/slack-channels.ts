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

/** Message subtypes a channel shows besides plain messages. Joins, topic
 *  changes and the like stay out, as before. */
const SHOWN_SUBTYPES = new Set([
  "bot_message",
  "thread_broadcast",
  "file_share",
  "me_message",
]);

export interface SlackMessageFile {
  name: string;
  /** Proxied through /api/slack/file, for an image. */
  thumb?: string;
  width?: number;
  height?: number;
  /** Opens the file in Slack. */
  permalink?: string;
}

/** What a channel shows of a message's files: images inline, the rest as a
 *  named link to Slack. */
export function messageFiles(files: unknown): SlackMessageFile[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter((f: any) => f && typeof f === "object" && f.mode !== "tombstone")
    .map((f: any) => {
      const thumb = f.thumb_720 || f.thumb_480 || f.thumb_360;
      const isImage = String(f.mimetype || "").startsWith("image/");
      return {
        name: String(f.title || f.name || "file"),
        ...(isImage && typeof thumb === "string"
          ? {
              thumb: `/api/slack/file?url=${encodeURIComponent(thumb)}`,
              ...(f.thumb_720_w || f.original_w
                ? { width: Number(f.thumb_720_w || f.original_w) }
                : {}),
              ...(f.thumb_720_h || f.original_h
                ? { height: Number(f.thumb_720_h || f.original_h) }
                : {}),
            }
          : {}),
        ...(typeof f.permalink === "string" ? { permalink: f.permalink } : {}),
      };
    });
}

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

  const msgsMatch = path.match(/^\/api\/slack\/channels\/([^/]+)\/messages$/);
  if (!msgsMatch) return undefined;

  // Slack markup → markdown-ish the pane renders: <url|label> →
  // [label](url), bare <url> → url, mentions/broadcasts/channel refs →
  // [[@Name]]/[[@here]]/[[#name]] tag tokens (chips in the pane), custom
  // emoji → ![:name:](url) image tokens, standard emoji → unicode.
  // Entities decode only after the <...> markup is consumed so an escaped
  // "&lt;" can't become fake markup; emoji run last so a decoded ":" can
  // join a shortcode.
  const renderSlackText = async (
    raw: string,
    resolveSlackUser: (id: string) => Promise<{ name: string }>,
    emojify: (t: string) => string,
  ) => {
    let text = raw
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "[$2]($1)")
      .replace(/<(https?:[^>]+)>/g, "$1")
      .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, "[[@$1]]")
      .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "[[#$1]]");
    const mentionIds = [...text.matchAll(/<@(U[A-Z0-9]+)>/g)].map((m) => m[1]);
    for (const id of [...new Set(mentionIds)]) {
      const u = await resolveSlackUser(id).catch(() => ({ name: "someone" }));
      text = text.replaceAll(`<@${id}>`, `[[@${u.name.split(" ")[0]}]]`);
    }
    return emojify(
      text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
    );
  };
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
      const { slackApiGet, resolveSlackUser } =
        await import("../../agents/slack/slack-api");
      const { customEmojiMap, emojifySlackText, reactionDisplay } =
        await import("../../agents/slack/emoji");
      const { personaName } = await import("../config");
      const custom = await customEmojiMap(grantToken);
      const emojify = (t: string) => emojifySlackText(t, custom);
      const selfId =
        caller && grantToken
          ? await (
              await import("../../agents/slack/conversations")
            )
              .slackSelfId(caller, grantToken)
              .catch(() => undefined)
          : undefined;
      const reactionsOf = (m: any) =>
        (m.reactions || [])
          .filter((r: any) => r?.name && r?.count)
          .map((r: any) => ({
            name: r.name,
            count: r.count,
            ...(selfId && Array.isArray(r.users) && r.users.includes(selfId)
              ? { mine: true }
              : {}),
            ...reactionDisplay(r.name, custom),
          }));
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
        if (m.type !== "message") continue;
        if (m.subtype && !SHOWN_SUBTYPES.has(m.subtype)) continue;
        const files = messageFiles(m.files);
        if (!m.text && !files.length) continue;
        // User-first: app-relayed posts carry BOTH user and bot_id (a
        // person's own message via an app) — the person wins, otherwise
        // their posts render as the bot.
        const text = m.text
          ? await renderSlackText(m.text, resolveSlackUser, emojify)
          : "";
        const thread =
          !threadTs && (m.reply_count || 0) > 0
            ? {
                replyCount: m.reply_count || 0,
                ...(m.latest_reply ? { latestReply: m.latest_reply } : {}),
                replyUsers: await Promise.all(
                  (m.reply_users || []).slice(0, 4).map(async (id: string) => {
                    const u = await resolveSlackUser(id).catch(() => ({
                      name: id,
                      avatarUrl: undefined,
                    }));
                    return { name: u.name, avatarUrl: u.avatarUrl };
                  }),
                ),
              }
            : { replyCount: 0 };
        const shared = {
          ts: m.ts,
          text,
          ...thread,
          reactions: reactionsOf(m),
          ...(files.length ? { files } : {}),
          ...(m.edited ? { edited: true } : {}),
          ...(m.subtype === "thread_broadcast" ? { broadcast: true } : {}),
        };
        if (m.user) {
          const u = await resolveSlackUser(m.user);
          out.push({
            ...shared,
            userId: m.user,
            userName: u.name,
            avatarUrl: u.avatarUrl,
            isBot: false,
          });
        } else {
          out.push({
            ...shared,
            userName: m.username || m.bot_profile?.name || personaName(),
            avatarUrl:
              m.icons?.image_72 ||
              m.icons?.image_48 ||
              m.bot_profile?.icons?.image_72,
            isBot: true,
          });
        }
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
    const body = (await req.json().catch(() => null)) as {
      text?: string;
      thread_ts?: string;
      broadcast?: boolean;
    } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const replyTo =
      typeof body?.thread_ts === "string" && /^\d+\.\d+$/.test(body.thread_ts)
        ? body.thread_ts
        : undefined;
    if (!text)
      return Response.json({ error: "text required" }, { status: 400 });
    if (!grantToken)
      return Response.json(
        {
          error:
            "Connect your Slack account in Settings → Account to post as yourself",
        },
        { status: 403 },
      );
    try {
      const { slackApiCall } = await import("../../agents/slack/slack-api");
      const res = await slackApiCall(
        "chat.postMessage",
        {
          channel: channelId,
          text,
          ...(replyTo
            ? { thread_ts: replyTo, reply_broadcast: !!body?.broadcast }
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

  return undefined;
}

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
  history = lines.map((text, index) => ({
    ts: `${now - 86400 - (lines.length - index) * 900}.000100`,
    text,
    ...people[index % people.length]!,
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
  demoHistories.set(channelId, history);
  return history;
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
    const body = (await req.json().catch(() => null)) as {
      text?: string;
      thread_ts?: string;
    } | null;
    const text = body?.text?.trim();
    if (!text)
      return Response.json({ error: "text required" }, { status: 400 });
    const message = {
      ts: `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1000).padStart(6, "0")}`,
      text,
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
