// The shape of a Channels draft and how a stored list is read back. Kept
// apart from the store (lib/channel-drafts.ts) so a test can load it without
// the browser.

import { z } from "zod";

export interface ChannelDraft {
  channelId: string;
  /** The thread it replies in, when it is a reply. */
  thread?: string;
  text: string;
  /** Last edited, in ms. */
  at: number;
  /** The people picked from the "@" list: [shown name, Slack id]. */
  mentions: [string, string][];
}

const draftSchema = z.object({
  channelId: z.string(),
  thread: z.string().optional(),
  text: z.string(),
  at: z.number(),
  mentions: z.array(z.tuple([z.string(), z.string()])),
}) satisfies z.ZodType<ChannelDraft>;

export function draftKey(channelId: string, thread?: string): string {
  return thread ? `${channelId}:${thread}` : channelId;
}

/** The stored drafts, newest first, dropping anything that is not one. */
export function decodeDrafts(raw: string | null): ChannelDraft[] {
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = z.array(z.unknown()).safeParse(json);
  if (!list.success) return [];
  return list.data
    .flatMap((entry) => {
      const draft = draftSchema.safeParse(entry);
      return draft.success ? [draft.data] : [];
    })
    .sort((a, b) => b.at - a.at);
}
