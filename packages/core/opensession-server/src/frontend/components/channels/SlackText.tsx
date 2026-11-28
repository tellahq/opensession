import type { ReactNode } from "react";
import { cn } from "../../ui/cn";
import {
  slackBlocks,
  type SlackBlock,
  type SlackInline,
} from "../../lib/slack-markup";

function Inline({ node }: { node: SlackInline }): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "bold":
      return (
        <strong className="font-bold">
          <Inlines nodes={node.children} />
        </strong>
      );
    case "italic":
      return (
        <em>
          <Inlines nodes={node.children} />
        </em>
      );
    case "strike":
      return (
        <s>
          <Inlines nodes={node.children} />
        </s>
      );
    case "code":
      return (
        <code className="rounded-sm bg-hover px-1 py-px font-mono text-[0.88em] text-red">
          {node.text}
        </code>
      );
    case "emoji":
      // Custom emoji image, sized to ride inline with the text.
      return (
        <img
          src={node.url}
          alt={node.name}
          title={node.name}
          className="inline-block size-[18px] align-text-bottom"
        />
      );
    case "tag":
      return (
        <span className="rounded-sm bg-accent-soft px-1 font-medium text-accent">
          {node.label}
        </span>
      );
    case "link":
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noreferrer"
          className="text-link no-underline hover:underline"
        >
          {node.label}
        </a>
      );
  }
}

function Inlines({ nodes }: { nodes: SlackInline[] }) {
  return nodes.map((node, index) => <Inline key={index} node={node} />);
}

function Block({ block }: { block: SlackBlock }) {
  if (block.type === "code")
    return (
      <pre className="my-1 overflow-x-auto rounded-md border border-line bg-hover px-3 py-2 font-mono text-label leading-relaxed whitespace-pre">
        {block.text}
      </pre>
    );
  if (block.type === "quote")
    return (
      <blockquote className="my-0.5 border-l-4 border-line-strong pl-3 text-dim">
        <Inlines nodes={block.inlines} />
      </blockquote>
    );
  return (
    <p className="m-0">
      <Inlines nodes={block.inlines} />
    </p>
  );
}

/**
 * Slack message text, as Slack shows it: paragraphs, quotes and code blocks,
 * bold, italic, strikethrough and inline code, links, @ and # tags and
 * custom emoji (lib/slack-markup.ts parses it).
 */
export function SlackText({
  text,
  className,
}: {
  text: string;
  /** Type size and ink, for text smaller than a message's. */
  className?: string;
}) {
  return (
    <div
      className={cn(
        "select-text whitespace-pre-wrap break-words text-body leading-body text-fg",
        className,
      )}
    >
      {slackBlocks(text).map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
