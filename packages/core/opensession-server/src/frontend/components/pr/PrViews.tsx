import { mergeStylexProps } from "../../ui/cn";
import { useState } from "react";
import { renderPrCommentMarkdown } from "../../lib/markdown";
import { formatPrCommentPrompt, stripHtmlComments } from "../../lib/pr-prompts";
import { avatarUrl, type Provider } from "../../lib/provider";
import type { PrComment, PrDetails } from "../../lib/types";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  size7: {
    width: "calc(4px * 7)",
    height: "calc(4px * 7)",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgActive: {
    backgroundColor: "var(--bg-active)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  sizeFull: {
    width: "100%",
    height: "100%",
  },
  objectCover: {
    objectFit: "cover",
  },
  OutlineOffset1: {
    outlineOffset: "calc(1px * -1)",
  },
  outlineDivider: {
    outlineColor: "var(--divider)",
  },
  roundedXl: {
    borderRadius: "calc(18px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderDashed: {
    borderStyle: "dashed",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  py10: {
    paddingBlock: "calc(4px * 10)",
  },
  textCenter: {
    textAlign: "center",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  minW0: {
    minWidth: "0",
  },
  borderLine60: {
    borderColor: "color-mix(in oklab, var(--border) 60%, transparent)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  smoothShadowSm: {
    boxShadow:
      "0 1px 3px -1px color-mix(in srgb, var(--smooth-shadow-color) 6%, transparent), 0 4px 10px -4px color-mix(in srgb, var(--smooth-shadow-color) 9%, transparent)",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mxAuto: {
    marginInline: "auto",
  },
  wFull: {
    width: "100%",
  },
  maxW760px: {
    maxWidth: "760px",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  flex1: {
    flex: "1",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  py1: {
    paddingBlock: "4px",
  },
  opacity0: {
    opacity: "0%",
  },
  transitionOpacity: {
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  focusVisibleOpacity100: {
    ":focus-visible": {
      opacity: "100%",
    },
  },
  noUnderline: {
    textDecorationLine: "none",
  },
});

function PrAvatar({ login, provider }: { login: string; provider: Provider }) {
  const src = avatarUrl(login, provider, 56);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  return (
    <span
      {...stylex.props(
        sx.flex,
        sx.size7,
        sx.shrink0,
        sx.itemsCenter,
        sx.justifyCenter,
        sx.overflowHidden,
        sx.roundedFull,
        sx.bgActive,
        sx.fontSemibold,
        sx.textFg,
        typography.meta,
      )}
      aria-hidden
    >
      {src && failedSrc !== src ? (
        <img
          {...mergeStylexProps(
            "outline outline-1",
            sx.sizeFull,
            sx.roundedFull,
            sx.objectCover,
            sx.OutlineOffset1,
            sx.outlineDivider,
          )}
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        login.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

function PrDescriptionCard({
  author,
  descriptionHtml,
  provider,
}: {
  author: string;
  descriptionHtml: string;
  provider: Provider;
}) {
  if (!descriptionHtml)
    return (
      <div
        {...stylex.props(
          sx.roundedXl,
          sx.border,
          sx.borderDashed,
          sx.borderLine,
          sx.px4,
          sx.py10,
          sx.textCenter,
          sx.textXs,
          sx.textFaint,
        )}
      >
        This pull request has no description.
      </div>
    );
  return (
    <article
      {...stylex.props(
        sx.minW0,
        sx.roundedXl,
        sx.border,
        sx.borderLine60,
        sx.bgSurface,
        sx.smoothShadowSm,
      )}
    >
      <div
        {...stylex.props(
          sx.flex,
          sx.itemsCenter,
          sx.gap2,
          sx.borderB,
          sx.borderDivider,
          sx.px4,
          sx.py3,
        )}
      >
        <PrAvatar login={author} provider={provider} />
        <div>
          <div {...stylex.props(sx.textXs, sx.fontSemibold, sx.textFg)}>
            {author}
          </div>
          <div {...stylex.props(sx.textFaint, typography.meta)}>
            Opened this pull request
          </div>
        </div>
      </div>
      <div
        {...mergeStylexProps(
          "markdown",
          sx.px4,
          sx.py4,
          sx.leadingRelaxed,
          sx.textDim,
          typography.body,
        )}
        dangerouslySetInnerHTML={{ __html: descriptionHtml }}
      />
    </article>
  );
}

/**
 * The Overview page's main column: the description, then the conversation.
 *
 * It carries no heading of its own — the page tab above it already says where
 * you are, and a second "Conversation" title only pushed the description down.
 */
export function ConversationView({
  author,
  descriptionHtml,
  comments,
  provider,
  repo,
  pr,
  onAddToInput,
}: {
  author: string;
  descriptionHtml: string;
  comments: PrComment[];
  provider: Provider;
  /** The repo a bare `#5528` in a comment refers to (see markdown.ts). */
  repo?: string;
  pr?: PrDetails;
  /** Append one comment to the session's composer draft. */
  onAddToInput?: (text: string) => void;
}) {
  return (
    /* `w-full` is load-bearing, not belt-and-braces: this column is a flex item
       and `mx-auto` (an auto cross-axis margin) opts it out of stretching, so
       without it the box sizes to its content and `max-w` becomes a fixed 760px
       that a phone can't fit. */
    <div
      {...stylex.props(
        sx.mxAuto,
        sx.flex,
        sx.wFull,
        sx.minW0,
        sx.maxW760px,
        sx.flexCol,
        sx.gap4,
      )}
    >
      <PrDescriptionCard
        author={author}
        descriptionHtml={descriptionHtml}
        provider={provider}
      />

      {comments.length === 0 ? (
        <div
          {...stylex.props(
            sx.roundedXl,
            sx.border,
            sx.borderDashed,
            sx.borderLine,
            sx.px4,
            sx.py10,
            sx.textCenter,
            sx.textXs,
            sx.textFaint,
          )}
        >
          No comments yet.
        </div>
      ) : (
        comments.map((comment, index) => {
          const body = stripHtmlComments(comment.body);
          const timestamp = comment.createdAt
            ? new Date(comment.createdAt).toLocaleString()
            : null;
          return (
            <article
              /* A grid item's automatic minimum size is its min-content
                 width, so a wide comment (a deploy table, a long path) would
                 otherwise stretch the track past the viewport. */
              {...mergeStylexProps(
                "group",
                sx.minW0,
                sx.roundedXl,
                sx.border,
                sx.borderLine60,
                sx.bgSurface,
                sx.smoothShadowSm,
              )}
              key={`${comment.url || comment.createdAt || index}`}
            >
              <div
                {...stylex.props(
                  sx.flex,
                  sx.itemsCenter,
                  sx.gap2,
                  sx.borderB,
                  sx.borderDivider,
                  sx.px4,
                  sx.py3,
                )}
              >
                <PrAvatar
                  login={comment.author || "Unknown"}
                  provider={provider}
                />
                <div {...stylex.props(sx.minW0, sx.flex1)}>
                  <div {...stylex.props(sx.textXs, sx.fontSemibold, sx.textFg)}>
                    {comment.author || "Unknown"}
                  </div>
                  {timestamp && (
                    <div {...stylex.props(sx.textFaint, typography.meta)}>
                      {timestamp}
                    </div>
                  )}
                </div>
                {onAddToInput && pr && (
                  <button
                    {...mergeStylexProps(
                      "group-hover:opacity-100",
                      sx.roundedMd,
                      sx.border0,
                      sx.bgTransparent,
                      sx.px15,
                      sx.py1,
                      sx.textFaint,
                      sx.opacity0,
                      sx.transitionOpacity,
                      sx.hoverBgHover,
                      sx.hoverTextFg,
                      sx.focusVisibleOpacity100,
                      typography.meta,
                    )}
                    onClick={() =>
                      onAddToInput(formatPrCommentPrompt(comment, pr))
                    }
                  >
                    Add to session
                  </button>
                )}
                {comment.url && (
                  <a
                    {...stylex.props(
                      sx.textFaint,
                      sx.noUnderline,
                      sx.hoverTextFg,
                      typography.meta,
                    )}
                    href={comment.url}
                    target="_blank"
                    rel="noopener"
                  >
                    Open on GitHub
                  </a>
                )}
              </div>
              <div
                {...mergeStylexProps(
                  "markdown",
                  sx.px4,
                  sx.py4,
                  sx.leadingRelaxed,
                  sx.textDim,
                  typography.body,
                )}
                dangerouslySetInnerHTML={{
                  __html: renderPrCommentMarkdown(body, { repo }),
                }}
              />
            </article>
          );
        })
      )}
    </div>
  );
}

export function CommitIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <path d="M11.5 7.25a3.5 3.5 0 0 0-6.92 0H1.75a.75.75 0 0 0 0 1.5h2.83a3.5 3.5 0 0 0 6.92 0h2.75a.75.75 0 0 0 0-1.5H11.5ZM8 10a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z" />
    </svg>
  );
}
