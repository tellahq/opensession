import { utilityClassName } from "../ui/cn";
import React from "react";
import type { ExternalRef } from "../lib/types";
import { feedForRefKind } from "../lib/feeds-meta";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  whitespaceNowrap: {
    whiteSpace: "nowrap",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  minH0: {
    minHeight: "0",
  },
  wFull: {
    width: "100%",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgBlack: {
    backgroundColor: "var(--color-black)",
  },
});

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
    return {
      label: feed.panel.label,
      refId: ref.id,
      ...(feed.panel.component ? { component: feed.panel.component } : {}),
      ...(feed.panel.embedUrlTemplate
        ? { embedUrl: fillTemplate(feed.panel.embedUrlTemplate, ref.id) }
        : {}),
      links: (feed.panel.links || []).map((l) => ({
        label: l.label,
        href: fillTemplate(l.hrefTemplate, ref.id),
      })),
    };
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
    <div
      className={utilityClassName(
        `flex h-full min-h-0 flex-col ${className || ""}`,
      )}
    >
      <div
        {...stylex.props(
          sx.flex,
          sx.itemsCenter,
          sx.gap3,
          sx.borderB,
          sx.borderDivider,
          sx.px3,
          sx.py2,
        )}
      >
        <span
          {...stylex.props(
            sx.minW0,
            sx.flex1,
            sx.truncate,
            sx.fontMedium,
            sx.textFg,
            typography.label,
          )}
        >
          {title || panel.label}
        </span>
        {panel.links.map((l) => (
          <a
            key={l.href}
            href={l.href}
            target="_blank"
            rel="noreferrer"
            {...stylex.props(
              sx.whitespaceNowrap,
              sx.textXs,
              sx.fontMedium,
              sx.textDim,
              sx.hoverTextFg,
            )}
          >
            {l.label} ↗
          </a>
        ))}
      </div>
      <iframe
        src={panel.embedUrl || "about:blank"}
        title={title || panel.label}
        {...stylex.props(sx.minH0, sx.wFull, sx.flex1, sx.border0, sx.bgBlack)}
        allow="fullscreen; autoplay; clipboard-write"
      />
    </div>
  );
}
