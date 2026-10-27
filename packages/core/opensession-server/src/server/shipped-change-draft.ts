/**
 * shipped-change-draft: the "Send to Slack" card's first draft, written on the
 * server and saved on the session.
 *
 * The draft used to be written only while a viewer had the card up, and only
 * kept in memory. Now a turn that ends with the session's PR merged writes it
 * in the background, and every draft is saved on the session file, so the card
 * opens on a finished draft even when nobody was watching, and after a
 * restart. The card's own request reuses the saved draft while the session
 * has not moved on since it was written.
 */

import { shippedChangeChannels } from "../agents/github/shipped-change-notify";
import { suggestShippedChangeMessage } from "./shipped-change-suggestion";
import {
  channelsUsedForRepo,
  recentChannelUses,
} from "./shipped-change-channel-history";
import { findSessionAsync, updateSessionFile } from "./session-cache";
import { resolvePrTarget } from "./session-repos";
import { prHostFor } from "./pr-host";
import { getPrsByRepo } from "./pr-cache";
import { getRepo } from "./worktree";
import type { ShippedChangeDraft, UnifiedSession } from "./types";

type PrTarget = { ghRepo: string; branch: string; repoId: string };

/** The saved draft, when it was written for this PR and nothing has happened
 *  in the session since. */
export function savedShippedChangeDraft(
  session: Pick<UnifiedSession, "lastActivity" | "shippedChangeDraft">,
  target: Pick<PrTarget, "repoId" | "branch">,
): ShippedChangeDraft | undefined {
  const saved = session.shippedChangeDraft;
  if (
    saved &&
    saved.repoId === target.repoId &&
    saved.branch === target.branch &&
    saved.activity === (session.lastActivity || "")
  )
    return saved;
  return undefined;
}

/**
 * Write the draft for the session's PR on `target` and save it on the
 * session. Undefined when the PR could not be found, null when the model gave
 * nothing usable (the card keeps its title-based fallback then).
 */
export async function draftShippedChange(
  session: UnifiedSession,
  target: PrTarget,
  user?: string,
): Promise<ShippedChangeDraft | null | undefined> {
  const saved = savedShippedChangeDraft(session, target);
  if (saved) return saved;
  const pr = await prHostFor(getRepo(target.repoId)).getPrDetails(
    target.branch,
    target.ghRepo,
  );
  if (!pr) return undefined;
  // Candidates: the configured channels, plus any this repository's updates
  // went to before. The person's full channel directory runs to hundreds and
  // is theirs to search; the pick only has to start well.
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
  const activity = session.lastActivity || "";
  const suggestion = await suggestShippedChangeMessage({
    session,
    pr: { number: pr.number, title: pr.title, body: pr.body },
    repo: target.ghRepo,
    channels,
    recentChannels,
    examples,
    user,
  });
  if (!suggestion) return null;
  const draft: ShippedChangeDraft = {
    repoId: target.repoId,
    branch: target.branch,
    prNumber: pr.number,
    message: suggestion.message,
    ...(suggestion.channel ? { channel: suggestion.channel } : {}),
    activity,
    at: new Date().toISOString(),
  };
  await updateSessionFile(session.id, (data) => ({
    ...data,
    shippedChangeDraft: draft,
  })).catch((error) =>
    console.warn(
      `[shipped-change] couldn't save the draft for ${session.id}:`,
      error,
    ),
  );
  return draft;
}

/**
 * After a clean turn: when the session's PR has merged and its update has not
 * been sent yet, write the draft now rather than when someone opens the card.
 * Reads only the in-memory PR cache to decide, so a turn on an unmerged branch
 * costs nothing.
 */
export async function draftShippedChangeAfterTurn(
  sessionId: string,
  user?: string,
): Promise<void> {
  const session = await findSessionAsync(sessionId);
  if (!session) return;
  const target = resolvePrTarget(session);
  if (!target) return;
  const pr = getPrsByRepo().get(target.repoId)?.get(target.branch);
  if (!pr || pr.state !== "MERGED") return;
  if (session.slackShares?.some((share) => share.prNumber === pr.number))
    return;
  await draftShippedChange(session, target, user);
}
