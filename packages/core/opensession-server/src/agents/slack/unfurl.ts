/**
 * Slack link unfurling for Open Session session links.
 *
 * When someone pastes a `<instance-host>/session/<id>` link into Slack, Slack
 * fires a `link_shared` event (the app must have `links:read`/`links:write` and
 * register the domain as an unfurl domain). We can't rely on Open Graph tags
 * because an instance host is often private (tailnet-only, behind a VPN), so
 * Slack's crawler cannot reach it. Instead we look the session up in-process
 * and post a rich preview back with
 * `chat.unfurl`.
 */

import { slackApiCall } from "./slack-api";
import { findSessionAsync } from "../../server/session-cache";
import type { UnifiedSession } from "../../server/types";
import { configuredServer } from "../../server/config";
import {
  hasUsableSessionShot,
  sessionCardTitle,
  sessionSocialCardData,
  sessionSocialCardUrl,
} from "../../server/session-social-card";

const UI_BASE =
  process.env.OPENSESSION_UI_BASE || configuredServer().publicBaseUrl;

function uiHost(): string {
  try {
    return new URL(UI_BASE).host;
  } catch {
    return new URL(configuredServer().publicBaseUrl).hostname;
  }
}

/**
 * Extract a session id from an Open Session URL, or null if it isn't one of ours.
 * Handles the legacy `/opensession/…` and `/backstage/…` path prefixes that
 * 301 to the bare form (Slack sends whatever the user pasted), and both URL
 * shapes the UI produces:
 *   - `/session/<id>`
 *   - `/workspace/<workspaceId>/session/<id>`  (the deep-link the app copies
 *     today)
 */
export function sessionIdFromUrl(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.host !== uiHost()) return null;
  let path = u.pathname;
  if (path === "/opensession" || path.startsWith("/opensession/")) {
    path = path.slice("/opensession".length);
  } else if (path === "/backstage" || path.startsWith("/backstage/")) {
    path = path.slice("/backstage".length);
  }
  const m =
    path.match(/^\/session\/([^/?#]+)/) ||
    path.match(/^\/workspace\/[^/?#]+\/session\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Escape text going into Slack mrkdwn (esp. inside a `<url|text>` link). */
function esc(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Bare relative duration: "5m" / "2h" / "3d" — no "ago" suffix, callers add it. */
function relTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!t) return "";
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** "+123 −45" diff stat from the PR fields, or "" when unknown. */
function diffStat(s: UnifiedSession): string {
  if (s.prAdditions == null && s.prDeletions == null) return "";
  return `+${s.prAdditions ?? 0} −${s.prDeletions ?? 0}`;
}

/** A compact review-decision label, or "" when there's nothing worth showing. */
function reviewLabel(decision?: string): string {
  switch (decision) {
    case "APPROVED":
      return "✅ approved";
    case "CHANGES_REQUESTED":
      return "✋ changes requested";
    default:
      return "";
  }
}

/** Social cards are named after the linked session, not its parent workspace. */
export function cardTitle(s: UnifiedSession): { title: string } {
  return sessionCardTitle(s);
}

/** Build the Block Kit unfurl body for one session. */
export async function unfurlForSession(
  s: UnifiedSession,
  url: string,
): Promise<{ blocks: any[] }> {
  const card = await sessionSocialCardData(s, { includeShot: true });
  const { title } = card;

  // The linked title always leads. The card below it is the session's own
  // screenshots and nothing else, so it only appears when there is one to
  // show: an empty rectangle says less than no image at all.
  const blocks: any[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*<${url}|${esc(title)}>*` },
    },
  ];
  if (await hasUsableSessionShot(card)) {
    blocks.push({
      type: "image",
      image_url: sessionSocialCardUrl(s.id),
      alt_text: `${title}, Open Session preview`,
    });
  }

  // A missing creator stays missing rather than becoming "Open Session".
  const bits: string[] = [];
  if (s.createdBy || s.startedBy) bits.push(card.owner);
  if (s.repo) bits.push(s.repo);
  const updated = relTime(s.lastActivity);
  if (updated) bits.push(`updated ${updated} ago`);

  if (bits.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: bits.join("  ·  ") }],
    });
  }

  if (s.prUrl) {
    const num = s.prNumber ? `#${s.prNumber}` : "PR";
    const prTitle = s.prTitle ? ` ${esc(s.prTitle)}` : "";
    const extras: string[] = [];
    if (s.prIsDraft) extras.push("draft");
    const diff = diffStat(s);
    if (diff) extras.push(diff);
    const c = s.prChecks;
    if (c && c.total) {
      extras.push(
        `checks ${c.passed}/${c.total}${c.failed ? ` (${c.failed} failed)` : ""}`,
      );
    }
    const rev = reviewLabel(s.prReviewDecision);
    if (rev) extras.push(rev);
    const tail = extras.length ? `  ·  ${extras.join("  ·  ")}` : "";
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `<${s.prUrl}|${num}${prTitle}>${tail}` },
      ],
    });
  }

  return { blocks };
}

interface LinkSharedDeps {
  findSession: typeof findSessionAsync;
  unfurl: typeof slackApiCall;
}

const linkSharedDeps: LinkSharedDeps = {
  findSession: findSessionAsync,
  unfurl: slackApiCall,
};

/**
 * Handle a Slack `link_shared` event: look up every Open Session session link in
 * the message and post rich previews back via chat.unfurl. Unknown or foreign
 * links are ignored; if none resolve we make no API call.
 */
export async function handleLinkShared(
  event: any,
  deps: LinkSharedDeps = linkSharedDeps,
): Promise<void> {
  const links: Array<{ url: string; domain?: string }> = event.links || [];
  const unfurls: Record<string, { blocks: any[] }> = {};

  for (const link of links) {
    const id = sessionIdFromUrl(link.url);
    if (!id) continue;
    const session = await deps.findSession(id);
    if (!session) continue;
    unfurls[link.url] = await unfurlForSession(session, link.url);
  }

  if (Object.keys(unfurls).length === 0) return;

  const result = await deps.unfurl("chat.unfurl", {
    channel: event.channel,
    ts: event.message_ts,
    unfurls,
  });
  if (!result?.ok) {
    throw new Error(
      `Slack chat.unfurl failed: ${result?.error || "unknown error"}`,
    );
  }
}
