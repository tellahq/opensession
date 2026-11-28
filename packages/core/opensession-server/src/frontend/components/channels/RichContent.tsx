import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Embed } from "../../../shared/slack-embed";
import type {
  RichAttachment,
  RichBlock,
  RichButton,
  RichImage,
} from "../../../shared/slack-rich";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { ListRow } from "../../ui/list-row";
import { Tooltip } from "../../ui/tooltip";
import { IconPlay } from "../icons";
import { SlackText } from "./SlackText";

const PLAY_GLYPH = <IconPlay size={28} />;

const PROVIDER_NAMES: Record<Embed["provider"], string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  loom: "Loom",
  tella: "Tella",
  x: "X",
};

// What X's post frame says when its height changes.
const TweetResize = z.object({
  "twttr.embed": z.object({
    method: z.literal("twttr.private.resize"),
    params: z.array(z.object({ height: z.number().positive() })).min(1),
  }),
});

// X sends it as JSON text, or as an object in newer frames.
const TweetMessage = z.union([
  TweetResize,
  z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: "custom", message: "Not JSON" });
        return z.NEVER;
      }
    })
    .pipe(TweetResize),
]);

/** A post on X in X's own frame, which reports its height as it loads. */
function PostFrame({ embed }: { embed: Embed }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  // The theme the page shows, read once: the frame is built for one.
  const [theme] = useState(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== "https://platform.twitter.com") return;
      if (event.source !== frame.current?.contentWindow) return;
      const parsed = TweetMessage.safeParse(event.data);
      if (parsed.success)
        setHeight(Math.ceil(parsed.data["twttr.embed"].params[0]!.height));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={frame}
      title="Post on X"
      src={`${embed.src}&theme=${theme}`}
      style={{ height }}
      className="block w-full max-w-138 rounded-xl border-0"
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
      allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}

/**
 * A video that plays where it was shared, as Slack's do: its still with a
 * play button until clicked, so nothing loads from the provider before
 * then, and the provider's own player after.
 */
function Player({
  embed,
  poster,
  title,
  onPlay,
}: {
  embed: Embed;
  poster?: RichImage;
  title: string;
  /** Playing a post replaces its whole preview with the post. */
  onPlay?: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  // A post's preview keeps its picture's shape; a video plays in its own.
  const aspect =
    embed.kind === "post"
      ? poster?.width && poster.height
        ? poster.width / poster.height
        : 16 / 9
      : embed.aspect;
  const tall = aspect < 1;
  const box = tall ? "w-64 max-w-full" : "w-full max-w-120";
  if (playing && embed.kind === "video")
    return (
      <iframe
        title={title}
        src={embed.src}
        style={{ aspectRatio: String(embed.aspect) }}
        className={cn("block h-auto rounded-lg border-0 bg-code-well", box)}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation allow-forms"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
    );
  return (
    <ListRow
      aria-label={`Play ${title} from ${PROVIDER_NAMES[embed.provider]}`}
      onClick={() => (onPlay ? onPlay() : setPlaying(true))}
      style={{ aspectRatio: String(aspect) }}
      className={cn(
        "group/play relative block min-h-0 overflow-hidden rounded-lg border border-line bg-code-well p-0",
        box,
      )}
    >
      {poster && (
        <Picture
          image={poster}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-tooltip text-tooltip-fg opacity-90 transition-transform group-hover/play:scale-105 motion-reduce:transition-none">
          {PLAY_GLYPH}
        </span>
      </span>
    </ListRow>
  );
}
const SMALL_TEXT = "text-meta leading-snug text-dim";

/** An app's picture: loaded straight from its host, which never learns
 *  which page asked. */
function Picture({
  image,
  className,
}: {
  image: RichImage;
  className?: string;
}) {
  return (
    <img
      src={image.url}
      alt={image.alt}
      width={image.width}
      height={image.height}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={className}
    />
  );
}

const BIG_PICTURE =
  "block h-auto max-h-90 w-auto max-w-[min(100%,480px)] rounded-lg border border-line object-contain";

function ActionButton({ button }: { button: RichButton }) {
  const variant = button.primary ? "primary" : "default";
  if (button.url)
    return (
      <Button
        size="sm"
        variant={variant}
        render={<a href={button.url} target="_blank" rel="noreferrer" />}
      >
        {button.text}
      </Button>
    );
  return (
    <Tooltip label="Open in Slack to use this">
      <span>
        <Button size="sm" variant={variant} disabled>
          {button.text}
        </Button>
      </span>
    </Tooltip>
  );
}

function Fields({ fields }: { fields: string[] }) {
  return (
    <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
      {fields.map((field, index) => (
        <SlackText key={index} text={field} />
      ))}
    </div>
  );
}

function Block({ block }: { block: RichBlock }) {
  switch (block.type) {
    case "header":
      return (
        <div className="text-dialog-title font-bold text-fg">{block.text}</div>
      );
    case "divider":
      return <hr className="my-1 border-0 border-t border-divider" />;
    case "section":
      return (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {block.text && <SlackText text={block.text} />}
            {block.fields && <Fields fields={block.fields} />}
          </div>
          {block.image && (
            <Picture
              image={block.image}
              className="size-18 shrink-0 rounded-md object-cover"
            />
          )}
          {block.button && <ActionButton button={block.button} />}
        </div>
      );
    case "context":
      return (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          {block.items.map((item, index) =>
            item.kind === "image" ? (
              <Picture
                key={index}
                image={item.image}
                className="size-4 shrink-0 rounded-xs object-cover"
              />
            ) : (
              <SlackText key={index} text={item.text} className={SMALL_TEXT} />
            ),
          )}
        </div>
      );
    case "image":
      return (
        <div className="flex flex-col gap-1">
          {block.title && (
            <span className="text-meta text-faint">{block.title}</span>
          )}
          <Picture image={block.image} className={BIG_PICTURE} />
        </div>
      );
    case "actions":
      return (
        <div className="flex flex-wrap gap-2 py-0.5">
          {block.buttons.map((button, index) => (
            <ActionButton key={index} button={button} />
          ))}
        </div>
      );
    case "video":
      return (
        <div className="flex w-fit max-w-full flex-col gap-1">
          {block.url ? (
            <a
              href={block.url}
              target="_blank"
              rel="noreferrer"
              className="w-fit text-body font-bold text-link no-underline hover:underline"
            >
              {block.title}
            </a>
          ) : (
            <span className="text-body font-bold text-fg">{block.title}</span>
          )}
          {block.embed ? (
            <Player
              embed={block.embed}
              poster={block.thumb}
              title={block.title}
            />
          ) : (
            block.thumb && (
              <a href={block.url} target="_blank" rel="noreferrer">
                <Picture image={block.thumb} className={BIG_PICTURE} />
              </a>
            )
          )}
          {block.provider && (
            <span className="text-meta text-faint">{block.provider}</span>
          )}
        </div>
      );
  }
}

/** Block Kit, as an app laid its message out. */
export function RichBlocks({ blocks }: { blocks: RichBlock[] }) {
  return (
    <div className="flex max-w-160 flex-col gap-1.5">
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

function Attachment({ attachment: a }: { attachment: RichAttachment }) {
  const [showPost, setShowPost] = useState(false);
  const embed = a.embed;
  if (embed?.kind === "post" && showPost)
    return (
      <div className="flex flex-col gap-1">
        {a.pretext && <SlackText text={a.pretext} />}
        <PostFrame embed={embed} />
      </div>
    );
  // A video's still becomes its player; the small thumbnail beside the
  // text goes with it.
  const poster = embed ? (a.image ?? a.thumb) : undefined;
  const thumb = embed ? undefined : a.thumb;
  return (
    <div className="flex flex-col gap-1">
      {a.pretext && <SlackText text={a.pretext} />}
      <div className="flex max-w-160 gap-3">
        {/* The app's colour runs down the left edge, as in Slack. */}
        <span
          aria-hidden
          className="w-1 shrink-0 rounded-full bg-line-strong"
          style={a.color ? { backgroundColor: `#${a.color}` } : undefined}
        />
        <div className="flex min-w-0 flex-1 gap-3 py-0.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {a.service && (
              <span className="flex items-center gap-1.5 text-label font-bold text-dim">
                {a.service.icon && (
                  <Picture
                    image={{ url: a.service.icon, alt: "" }}
                    className="size-4 rounded-xs"
                  />
                )}
                {a.service.name}
              </span>
            )}
            {a.author && (
              <span className="flex items-center gap-1.5 text-label font-bold text-fg">
                {a.author.icon && (
                  <Picture
                    image={{ url: a.author.icon, alt: "" }}
                    className="size-5 rounded-sm"
                  />
                )}
                {a.author.link ? (
                  <a
                    href={a.author.link}
                    target="_blank"
                    rel="noreferrer"
                    className="text-fg no-underline hover:underline"
                  >
                    {a.author.name}
                  </a>
                ) : (
                  a.author.name
                )}
              </span>
            )}
            {a.title &&
              (a.titleLink ? (
                <a
                  href={a.titleLink}
                  target="_blank"
                  rel="noreferrer"
                  className="w-fit text-body font-bold text-link no-underline hover:underline"
                >
                  {a.title}
                </a>
              ) : (
                <span className="text-body font-bold text-fg">{a.title}</span>
              ))}
            {a.blocks ? (
              <RichBlocks blocks={a.blocks} />
            ) : (
              a.text && <SlackText text={a.text} />
            )}
            {a.fields && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {a.fields.map((field, index) => (
                  <div
                    key={index}
                    className={cn(!field.short && "col-span-full")}
                  >
                    {field.title && (
                      <div className="text-label font-bold text-fg">
                        {field.title}
                      </div>
                    )}
                    <SlackText text={field.value} />
                  </div>
                ))}
              </div>
            )}
            {embed ? (
              <Player
                embed={embed}
                poster={poster}
                title={a.title || PROVIDER_NAMES[embed.provider]}
                onPlay={
                  embed.kind === "post" ? () => setShowPost(true) : undefined
                }
              />
            ) : (
              a.image && <Picture image={a.image} className={BIG_PICTURE} />
            )}
            {a.footer && (
              <span className="flex items-center gap-1.5">
                {a.footerIcon && (
                  <Picture
                    image={{ url: a.footerIcon, alt: "" }}
                    className="size-4 rounded-xs"
                  />
                )}
                <SlackText text={a.footer} className={SMALL_TEXT} />
              </span>
            )}
          </div>
          {thumb && (
            <Picture
              image={thumb}
              className="size-18 shrink-0 rounded-md object-cover"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** App cards, link previews and shared messages under a message's text. */
export function RichAttachments({
  attachments,
}: {
  attachments: RichAttachment[];
}) {
  return (
    <div className="mt-1.5 flex flex-col gap-2.5">
      {attachments.map((attachment, index) => (
        <Attachment key={index} attachment={attachment} />
      ))}
    </div>
  );
}
