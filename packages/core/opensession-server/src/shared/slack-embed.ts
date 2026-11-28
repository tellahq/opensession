/**
 * Players for links Slack previews: a YouTube, Vimeo, Loom or Tella video,
 * or a post on X, turned into the URL of the provider's own embeddable
 * player. Only these hosts are embedded; anything else stays a preview.
 */

export type EmbedProvider = "youtube" | "vimeo" | "loom" | "tella" | "x";

export interface Embed {
  provider: EmbedProvider;
  /** The player's own page, for an iframe. */
  src: string;
  /** A video plays in a box of this width over height; a post sizes itself. */
  kind: "video" | "post";
  aspect: number;
}

const WIDE = 16 / 9;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function parse(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function host(url: URL): string {
  return url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
}

/** "1h2m3s", "90s" or "90" as seconds. */
function seconds(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || !match[0]) return undefined;
  const [, h = "0", m = "0", s = "0"] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function youtube(url: URL): Embed | undefined {
  const h = host(url);
  const path = url.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  let tall = false;
  if (h === "youtu.be") id = path[0];
  else if (h === "youtube.com" || h === "youtube-nocookie.com") {
    if (path[0] === "watch") id = url.searchParams.get("v") ?? undefined;
    else if (path[0] === "shorts") {
      id = path[1];
      tall = true;
    } else if (path[0] === "embed" || path[0] === "live") id = path[1];
  }
  if (!id || !YOUTUBE_ID.test(id)) return undefined;
  const params = new URLSearchParams({ autoplay: "1", rel: "0" });
  const start = seconds(
    url.searchParams.get("t") ?? url.searchParams.get("start"),
  );
  if (start) params.set("start", String(start));
  return {
    provider: "youtube",
    src: `https://www.youtube-nocookie.com/embed/${id}?${params}`,
    kind: "video",
    aspect: tall ? 9 / 16 : WIDE,
  };
}

function vimeo(url: URL): Embed | undefined {
  const h = host(url);
  const path = url.pathname.split("/").filter(Boolean);
  const id =
    h === "vimeo.com"
      ? path.find((part) => /^\d+$/.test(part))
      : h === "player.vimeo.com" && path[0] === "video"
        ? path[1]
        : undefined;
  if (!id || !/^\d+$/.test(id)) return undefined;
  return {
    provider: "vimeo",
    src: `https://player.vimeo.com/video/${id}?autoplay=1`,
    kind: "video",
    aspect: WIDE,
  };
}

function loom(url: URL): Embed | undefined {
  if (host(url) !== "loom.com") return undefined;
  const match = /^\/(?:share|embed)\/([0-9a-f]{32})\b/.exec(url.pathname);
  if (!match) return undefined;
  return {
    provider: "loom",
    src: `https://www.loom.com/embed/${match[1]}?autoplay=1`,
    kind: "video",
    aspect: WIDE,
  };
}

function tella(url: URL): Embed | undefined {
  const h = host(url);
  if (h !== "tella.tv" && h !== "tella.com") return undefined;
  const match = /^\/video\/([A-Za-z0-9_-]+)(?:\/(view|embed))?\/?$/.exec(
    url.pathname,
  );
  if (!match) return undefined;
  // Slack's own player link already carries what the video needs to play
  // there; keep it and only ask for autoplay.
  const params =
    match[2] === "embed" && h === "tella.tv"
      ? new URLSearchParams(url.search)
      : new URLSearchParams({ b: "0" });
  params.set("autoPlay", "true");
  return {
    provider: "tella",
    src: `https://www.tella.tv/video/${match[1]}/embed?${params}`,
    kind: "video",
    aspect: WIDE,
  };
}

function xPost(url: URL): Embed | undefined {
  const h = host(url);
  if (h !== "x.com" && h !== "twitter.com") return undefined;
  const match = /^\/[A-Za-z0-9_]+\/status(?:es)?\/(\d+)/.exec(url.pathname);
  if (!match) return undefined;
  return {
    provider: "x",
    src: `https://platform.twitter.com/embed/Tweet.html?id=${match[1]}&dnt=true`,
    kind: "post",
    aspect: 1,
  };
}

/** The player for `raw`, when it links somewhere that has one. */
export function embedFor(raw: unknown): Embed | undefined {
  if (typeof raw !== "string") return undefined;
  const url = parse(raw);
  if (!url) return undefined;
  return youtube(url) ?? vimeo(url) ?? loom(url) ?? tella(url) ?? xPost(url);
}

/** Whether an X preview's picture is a video's still (X names them so). */
export function isXVideoStill(imageUrl: unknown): boolean {
  return (
    typeof imageUrl === "string" &&
    /^https:\/\/pbs\.twimg\.com\/(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\//.test(
      imageUrl,
    )
  );
}
