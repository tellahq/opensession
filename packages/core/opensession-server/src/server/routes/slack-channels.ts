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
import { configuredIntegration } from "../config";

export interface SlackChannelOption {
  id: string;
  name: string;
}

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

export async function slackChannelsPayload(
  ctx: Pick<RouteContext, "authUser">,
) {
  const channels = configuredSlackChannels();
  const caller = ctx.authUser?.login || ctx.authUser?.name || undefined;
  const { mcpUserGrantToken } = await import("../mcp-oauth");
  const grantToken = caller ? mcpUserGrantToken("slack", caller) : undefined;
  let canUploadImages = false;
  if (grantToken) {
    try {
      const response = await fetch("https://slack.com/api/auth.test", {
        headers: { Authorization: `Bearer ${grantToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      canUploadImages = (response.headers.get("x-oauth-scopes") || "")
        .split(",")
        .map((scope) => scope.trim())
        .includes("files:write");
    } catch {}
  }
  return {
    channels,
    defaultChannel: defaultSlackChannel(channels),
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
      const reactionsOf = (m: any) =>
        (m.reactions || [])
          .filter((r: any) => r?.name && r?.count)
          .map((r: any) => ({
            name: r.name,
            count: r.count,
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
        if (m.subtype && m.subtype !== "bot_message") continue;
        if (!m.text) continue;
        // User-first: app-relayed posts carry BOTH user and bot_id (a
        // person's own message via an app) — the person wins, otherwise
        // their posts render as the bot.
        const text = await renderSlackText(m.text, resolveSlackUser, emojify);
        if (m.user) {
          const u = await resolveSlackUser(m.user);
          out.push({
            ts: m.ts,
            userName: u.name,
            avatarUrl: u.avatarUrl,
            text,
            isBot: false,
            replyCount: m.reply_count || 0,
            reactions: reactionsOf(m),
          });
        } else {
          out.push({
            ts: m.ts,
            userName: m.username || personaName(),
            avatarUrl: m.icons?.image_72 || m.icons?.image_48,
            text,
            isBot: true,
            replyCount: m.reply_count || 0,
            reactions: reactionsOf(m),
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
    } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
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
        { channel: channelId, text },
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
