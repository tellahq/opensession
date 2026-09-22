import { useEffect, useId, useRef, useState } from "react";
import { useIsPhone } from "../../hooks/useIsPhone";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { renderPrCommentMarkdown } from "../../lib/markdown";
import { formatPrCommentPrompt, stripHtmlComments } from "../../lib/pr-prompts";
import { avatarUrl, type Provider } from "../../lib/provider";
import type { PrComment, PrDetails } from "../../lib/types";

function PrAvatar({ login, provider }: { login: string; provider: Provider }) {
  const src = avatarUrl(login, provider, 56);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-active text-meta font-semibold text-fg"
      aria-hidden
    >
      {src && failedSrc !== src ? (
        <img
          className="size-full rounded-full object-cover outline outline-1 -outline-offset-1 outline-divider"
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
  const isPhone = useIsPhone();
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const body = bodyRef.current;
    const preview = previewRef.current;
    if (!isPhone || !body || !preview) return;
    const measure = () => {
      // Keep measuring the full markdown, not a truncated HTML/string preview.
      if (!expanded) setOverflows(body.scrollHeight > preview.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [isPhone, descriptionHtml, expanded]);

  if (!descriptionHtml)
    return (
      <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
        This pull request has no description.
      </div>
    );
  return (
    <article className="min-w-0 rounded-xl border border-line/60 bg-surface smooth-shadow-sm phone:border-0 phone:bg-panel phone:shadow-none">
      <div className="flex items-center gap-2 border-b border-divider px-4 py-3">
        <PrAvatar login={author} provider={provider} />
        <div>
          <div className="text-xs font-semibold text-fg">{author}</div>
          <div className="text-meta text-faint">Opened this pull request</div>
        </div>
      </div>
      <div
        id={bodyId}
        ref={previewRef}
        className={cn(!expanded && "phone:max-h-80 phone:overflow-hidden")}
        // A keyboard user reaching a link below the preview must see it.
        onFocusCapture={() => setExpanded(true)}
      >
        <div
          ref={bodyRef}
          className="markdown px-4 py-4 text-body leading-relaxed text-dim"
          dangerouslySetInnerHTML={{ __html: descriptionHtml }}
        />
      </div>
      {isPhone && overflows && (
        <div className="px-4 pb-3">
          <Button
            variant="ghost"
            className="min-h-11"
            aria-controls={bodyId}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : "Read more"}
          </Button>
        </div>
      )}
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
    <div className="mx-auto flex w-full min-w-0 max-w-[760px] flex-col gap-4">
      <PrDescriptionCard
        key={pr?.url}
        author={author}
        descriptionHtml={descriptionHtml}
        provider={provider}
      />

      {comments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
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
              className="group min-w-0 rounded-xl border border-line/60 bg-surface smooth-shadow-sm"
              key={`${comment.url || comment.createdAt || index}`}
            >
              <div className="flex items-center gap-2 border-b border-divider px-4 py-3">
                <PrAvatar
                  login={comment.author || "Unknown"}
                  provider={provider}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-fg">
                    {comment.author || "Unknown"}
                  </div>
                  {timestamp && (
                    <div className="text-meta text-faint">{timestamp}</div>
                  )}
                </div>
                {onAddToInput && pr && (
                  <button
                    className="rounded-md border-0 bg-transparent px-1.5 py-1 text-meta text-faint opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() =>
                      onAddToInput(formatPrCommentPrompt(comment, pr))
                    }
                  >
                    Add to session
                  </button>
                )}
                {comment.url && (
                  <a
                    className="text-meta text-faint no-underline hover:text-fg"
                    href={comment.url}
                    target="_blank"
                    rel="noopener"
                  >
                    Open on GitHub
                  </a>
                )}
              </div>
              <div
                className="markdown px-4 py-4 text-body leading-relaxed text-dim"
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
