import type { TranscriptEntry } from "./types";

/**
 * Deterministic zero-latency quick actions extracted from the latest finished
 * assistant turn.
 *
 * Complements the server-generated Haiku ReplySuggestions:
 *  - ```copy <label> fenced blocks become one-click Copy pills above the composer.
 *  - High-signal human-action URLs (GitHub PRs, Actions runs, Stripe approvals,
 *    Linear issues, Vercel previews, Plain tickets, or explicit Open/Review/
 *    Approve links) become one-click Open pills.
 *
 * Pure and deterministic so pills appear the millisecond a turn finishes, with
 * zero LLM latency or cost.
 */

export type QuickAction =
  | {
      readonly kind: "copy";
      readonly id: string;
      readonly label: string;
      readonly value: string;
    }
  | {
      readonly kind: "link";
      readonly id: string;
      readonly label: string;
      readonly url: string;
    };

const MAX_COPY_ACTIONS = 2;
const MAX_LINK_ACTIONS = 3;
const MAX_TOTAL_ACTIONS = 4;

const COPY_FENCE_RE =
  /^(`{3,}|~{3,})copy(?:[ \t]+([^\r\n]+))?[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/gm;
const MD_LINK_RE = /\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()[\]`"']+/g;

const ACTION_LINK_LABEL_RE =
  /^(?:open|review|approve|view|inspect|authorize|sign in|log in|check)\b/i;

function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, "");
}

function classifyActionUrl(
  rawUrl: string,
  explicitLabel?: string,
): { label: string; url: string } | null {
  const url = cleanUrl(rawUrl);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  if (host === "github.com") {
    const pr = /^\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/|$)/.exec(path);
    if (pr) return { label: `Open PR #${pr[1]}`, url };
    const run = /^\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:\/|$)/.exec(path);
    if (run) return { label: "Open CI run", url };
    const issue = /^\/[^/]+\/[^/]+\/issues\/(\d+)(?:\/|$)/.exec(path);
    if (issue) return { label: `Open issue #${issue[1]}`, url };
  }

  if (host === "dashboard.stripe.com") {
    if (path.includes("approval"))
      return { label: "Review Stripe approval", url };
    if (path.includes("invoice")) return { label: "Open Stripe invoice", url };
    return { label: "Open Stripe", url };
  }

  if (host === "linear.app") {
    const issue = /\/issue\/([A-Z]+-\d+)(?:\/|$)/i.exec(path);
    if (issue) return { label: `Open ${issue[1]!.toUpperCase()}`, url };
  }

  if (host === "app.plain.com") {
    return { label: "Open ticket", url };
  }

  if (
    host.endsWith(".vercel.app") ||
    (host === "vercel.com" && path.includes("/deployments"))
  ) {
    return { label: "Open preview", url };
  }

  if (explicitLabel) {
    const trimmed = explicitLabel.trim();
    if (
      trimmed.length >= 3 &&
      trimmed.length <= 36 &&
      ACTION_LINK_LABEL_RE.test(trimmed)
    ) {
      return { label: trimmed, url };
    }
  }

  return null;
}

export function extractQuickActions(markdown: string): QuickAction[] {
  if (!markdown || !markdown.trim()) return [];
  const actions: QuickAction[] = [];

  // 1. ```copy <label> blocks first (highest intent).
  COPY_FENCE_RE.lastIndex = 0;
  let copyCount = 0;
  let match: RegExpExecArray | null;
  while (
    (match = COPY_FENCE_RE.exec(markdown)) !== null &&
    copyCount < MAX_COPY_ACTIONS
  ) {
    const rawLabel = (match[2] ?? "").trim();
    const body = (match[3] ?? "").replace(/\r?\n$/, "");
    if (!body.trim()) continue;
    const label = rawLabel
      ? rawLabel.toLowerCase().startsWith("copy")
        ? rawLabel.slice(0, 36)
        : `Copy ${rawLabel}`.slice(0, 36)
      : "Copy";
    actions.push({
      kind: "copy",
      id: `copy-${copyCount}`,
      label,
      value: body,
    });
    copyCount++;
  }

  // Strip fenced code blocks before scanning for human-action URLs so URLs
  // inside code samples or shell logs don't become composer pills.
  const outsideCode = markdown.replace(
    /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g,
    "\n",
  );

  const seenUrls = new Set<string>();
  let linkCount = 0;
  const pushLink = (rawUrl: string, explicitLabel?: string) => {
    if (linkCount >= MAX_LINK_ACTIONS || actions.length >= MAX_TOTAL_ACTIONS)
      return;
    const classified = classifyActionUrl(rawUrl, explicitLabel);
    if (!classified) return;
    if (seenUrls.has(classified.url)) return;
    seenUrls.add(classified.url);
    actions.push({
      kind: "link",
      id: `link-${linkCount}`,
      label: classified.label,
      url: classified.url,
    });
    linkCount++;
  };

  MD_LINK_RE.lastIndex = 0;
  while ((match = MD_LINK_RE.exec(outsideCode)) !== null) {
    pushLink(match[2]!, match[1]);
  }

  BARE_URL_RE.lastIndex = 0;
  while ((match = BARE_URL_RE.exec(outsideCode)) !== null) {
    pushLink(match[0]);
  }

  return actions.slice(0, MAX_TOTAL_ACTIONS);
}

/**
 * Text of the latest assistant reply after the final user message, for
 * deriving zero-latency quick actions.
 */
export function latestAssistantReplyText(
  entries: readonly TranscriptEntry[],
): string {
  const parts: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "user" || entry.turnBoundary) break;
    if (
      entry.type === "assistant" &&
      !entry.isReasoning &&
      entry.content.trim()
    ) {
      parts.push(entry.content);
    }
  }
  return parts.reverse().join("\n\n");
}
