import React from "react";
import type { ExternalRef } from "../lib/types";
import { feedForRefKind } from "../lib/feeds-meta";

/**
 * The generic web panel for feed-item workspaces (the feeds design): a
 * full-width iframe of the item's embeddable page with escape-hatch links to
 * the real thing. Rendered as the feed view-tab of feed-backed workspaces
 * (and by WorkspacePane on their session-less route).
 *
 * Per-kind knowledge (which URL embeds, which links to offer) comes entirely
 * from the feed descriptors' `panel` templates (lib/feeds-meta.ts) — provider
 * pages that block framing declare an embeddable page as the
 * `embedUrlTemplate` and offer the rest as header links.
 */

export interface RefWebPanel {
  /** Tab label ("Video", "Conversation"). */
  label: string;
  /** Custom component key (e.g. "slack-channel") — rendered by the panel
   *  registry in SessionViewer/WorkspacePane instead of an iframe. */
  component?: string;
  /** The item id the panel is about (channel id, video id). */
  refId: string;
  /** The iframe-able URL (web panels). */
  embedUrl?: string;
  /** External links rendered in the pane header. */
  links: { label: string; href: string }[];
}

function fillTemplate(template: string, id: string): string {
  return template.replaceAll("{id}", encodeURIComponent(id));
}

/**
 * The web panel spec for a ref, or null when the kind has none. Driven by
 * the feed descriptors' `panel` templates (lib/feeds-meta.ts — config and
 * code feeds alike declare them); a kind whose descriptor hasn't loaded yet
 * (cold meta cache on first paint) has no panel until the meta fetch lands.
 */
export function refWebPanel(ref: ExternalRef): RefWebPanel | null {
  const feed = feedForRefKind(ref.kind);
  if (feed?.panel && (feed.panel.embedUrlTemplate || feed.panel.component)) {
    const panel: RefWebPanel = {
      label: feed.panel.label,
      refId: ref.id,
      links: (feed.panel.links || []).map((l) => ({
        label: l.label,
        href: fillTemplate(l.hrefTemplate, ref.id),
      })),
    };
    if (feed.panel.component) panel.component = feed.panel.component;
    if (feed.panel.embedUrlTemplate) {
      panel.embedUrl = fillTemplate(feed.panel.embedUrlTemplate, ref.id);
    }
    return panel;
  }
  return null;
}

export function FeedWebPane({
  panel,
  title,
  className,
}: {
  panel: RefWebPanel;
  title?: string;
  className?: string;
}) {
  return (
    <div className={`flex h-full min-h-0 flex-col ${className || ""}`}>
      <div className="flex items-center gap-3 border-b border-divider px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-label font-medium text-fg">
          {title || panel.label}
        </span>
        {panel.links.map((l) => (
          <a
            key={l.href}
            href={l.href}
            target="_blank"
            rel="noreferrer"
            className="whitespace-nowrap text-xs font-medium text-dim hover:text-fg"
          >
            {l.label} ↗
          </a>
        ))}
      </div>
      <iframe
        src={panel.embedUrl || "about:blank"}
        title={title || panel.label}
        className="min-h-0 w-full flex-1 border-0 bg-black"
        allow="fullscreen; autoplay; clipboard-write"
      />
    </div>
  );
}
