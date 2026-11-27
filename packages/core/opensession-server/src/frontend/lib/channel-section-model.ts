// The shape of your Channels sidebar sections and how they group your
// conversations. Kept apart from the pref (lib/channel-sections.ts) so a
// test can read it without the pref's server sync.

import { z } from "zod";
import type { Conversation } from "./api/slack-channels";

export interface ChannelSection {
  id: string;
  name: string;
  /** Shown before the name, like Slack's section emoji. */
  emoji?: string;
  /** Conversation ids, in the order the section lists them. */
  channels: string[];
}

export interface SidebarGroup {
  /** A section's id, or `channels`, `direct` or `hidden` for the built-in
   *  groups. */
  key: string;
  title: string;
  emoji?: string;
  /** Set on a section of your own. */
  section?: ChannelSection;
  rows: Conversation[];
}

const sectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().optional(),
  channels: z.array(z.string()),
}) satisfies z.ZodType<ChannelSection>;

/** The stored sections, dropping any entry that is not one. Null for a
 *  value that is not a list at all. */
export function decodeSections(
  raw: string | null | undefined,
): ChannelSection[] | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = z.array(z.unknown()).safeParse(json);
  if (!list.success) return null;
  return list.data.flatMap((entry) => {
    const section = sectionSchema.safeParse(entry);
    return section.success ? [section.data] : [];
  });
}

/** Remove `channelId` from whichever section holds it. */
export function withoutChannel(
  sections: readonly ChannelSection[],
  channelId: string,
): ChannelSection[] {
  return sections.map((section) =>
    section.channels.includes(channelId)
      ? {
          ...section,
          channels: section.channels.filter((c) => c !== channelId),
        }
      : section,
  );
}

/** Put `channelId` at the end of `sectionId`, or back under the built-in
 *  groups with `null`. */
export function movedChannel(
  sections: readonly ChannelSection[],
  channelId: string,
  sectionId: string | null,
): ChannelSection[] {
  return withoutChannel(sections, channelId).map((section) =>
    section.id === sectionId
      ? { ...section, channels: [...section.channels, channelId] }
      : section,
  );
}

const isDirect = (c: Conversation) => c.kind === "dm" || c.kind === "group";

/** The stored hidden conversation ids, dropping anything that is not one. */
export function decodeHidden(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = z.array(z.unknown()).safeParse(json);
  if (!list.success) return null;
  return list.data.flatMap((entry) => {
    const id = z.string().safeParse(entry);
    return id.success ? [id.data] : [];
  });
}

/**
 * Whether a hidden conversation still sits out of sight. The one you have
 * open stays where it is, and a direct message comes back when someone
 * writes, as Slack reopens a closed one.
 */
export function staysHidden(
  conversation: Conversation,
  hidden: ReadonlySet<string>,
  activeId?: string,
): boolean {
  if (!hidden.has(conversation.id) || conversation.id === activeId)
    return false;
  return !(isDirect(conversation) && conversation.unread);
}

/**
 * The sidebar's groups: your sections first, in your order and with their
 * conversations in your order, then every other channel, then every other
 * direct and group message, then the ones you hid. A conversation you have
 * left drops out of its section without being forgotten, so it comes back
 * if you rejoin.
 */
export function sidebarGroups(
  all: readonly Conversation[],
  sections: readonly ChannelSection[],
  hidden: ReadonlySet<string> = new Set(),
  activeId?: string,
): SidebarGroup[] {
  const out = all.filter((c) => staysHidden(c, hidden, activeId));
  const conversations = all.filter((c) => !out.includes(c));
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const placed = new Set<string>();
  const groups: SidebarGroup[] = sections.map((section) => {
    const rows: Conversation[] = [];
    for (const id of section.channels) {
      const row = byId.get(id);
      if (!row || placed.has(id)) continue;
      placed.add(id);
      rows.push(row);
    }
    const group: SidebarGroup = {
      key: section.id,
      title: section.name,
      section,
      rows,
    };
    if (section.emoji) group.emoji = section.emoji;
    return group;
  });
  const rest = conversations.filter((c) => !placed.has(c.id));
  groups.push(
    {
      key: "channels",
      title: "Channels",
      rows: rest.filter((c) => !isDirect(c)),
    },
    {
      key: "direct",
      title: "Direct messages",
      rows: rest.filter(isDirect),
    },
    { key: "hidden", title: "Hidden", rows: out },
  );
  return groups;
}
