/**
 * Slack messages as the Channels place shows them: Slack's markup turned
 * into the tokens the web renders (lib/slack-markup.ts), authors resolved to
 * names and photos, reactions marked when they are the reader's own, files
 * reduced to what a message shows. Shared by the channel, thread, Threads
 * and Sent routes (server/routes/slack-channels.ts).
 */
import { resolveSlackUser } from "./slack-api";

/** Message subtypes a channel shows besides plain messages. Joins, topic
 *  changes and the like stay out. */
export const SHOWN_SUBTYPES = new Set([
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

/**
 * Slack markup → the tokens the web renders: <url|label> → [label](url),
 * bare <url> → url, mentions, broadcasts and channel refs → [[@Name]],
 * [[@here]], [[#name]] tags, custom emoji → ![:name:](url) images, standard
 * emoji → unicode. Entities decode only after the <...> markup is consumed so
 * an escaped "&lt;" can't become fake markup; emoji run last so a decoded ":"
 * can join a shortcode.
 */
export async function renderSlackText(
  raw: string,
  emojify: (t: string) => string,
): Promise<string> {
  let text = raw
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, "[[@$1]]")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "[[#$1]]");
  const mentionIds = [...text.matchAll(/<@(U[A-Z0-9]+)>/g)].map((m) => m[1]!);
  for (const id of [...new Set(mentionIds)]) {
    const u = await resolveSlackUser(id).catch(() => ({ name: "someone" }));
    text = text.replaceAll(`<@${id}>`, `[[@${u.name.split(" ")[0]}]]`);
  }
  return emojify(
    text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
  );
}

/** A message's own text as its author edits it: Slack's markup kept (links,
 *  mention tokens), only the HTML entities Slack escapes decoded, so saving
 *  it unchanged sends back what was there. */
export function editableSource(raw: string): string {
  return raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * A converter for one reader: Slack message objects in, the web's message
 * shape out (null for a message the channel does not show). `inThread` drops
 * the thread summary, which a reply inside its own thread does not carry.
 */
export async function messageConverter(
  caller: string | undefined,
  grantToken: string | undefined,
): Promise<(m: any, opts?: { inThread?: boolean }) => Promise<any | null>> {
  const { customEmojiMap, emojifySlackText, reactionDisplay } =
    await import("./emoji");
  const { personaName } = await import("../../server/config");
  const custom = await customEmojiMap(grantToken);
  const emojify = (t: string) => emojifySlackText(t, custom);
  const selfId =
    caller && grantToken
      ? await (
          await import("./conversations")
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

  return async (m, opts = {}) => {
    if (m?.type !== "message") return null;
    if (m.subtype && !SHOWN_SUBTYPES.has(m.subtype)) return null;
    const files = messageFiles(m.files);
    if (!m.text && !files.length) return null;
    const text = m.text ? await renderSlackText(m.text, emojify) : "";
    const thread =
      !opts.inThread && (m.reply_count || 0) > 0
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
    // User-first: app-relayed posts carry BOTH user and bot_id (a person's
    // own message via an app); the person wins, or their posts render as
    // the bot.
    if (m.user) {
      const u = await resolveSlackUser(m.user);
      // The reader's own message: they may edit or delete it.
      const own =
        selfId && m.user === selfId
          ? { mine: true, source: editableSource(String(m.text || "")) }
          : {};
      return {
        ...shared,
        ...own,
        userId: m.user,
        userName: u.name,
        avatarUrl: u.avatarUrl,
        isBot: false,
      };
    }
    return {
      ...shared,
      userName: m.username || m.bot_profile?.name || personaName(),
      avatarUrl:
        m.icons?.image_72 ||
        m.icons?.image_48 ||
        m.bot_profile?.icons?.image_72,
      isBot: true,
    };
  };
}
