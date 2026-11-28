/**
 * Block Kit blocks and message attachments, from Slack's message objects to
 * the shapes the Channels place renders (shared/slack-rich.ts). Markup is
 * rendered by the caller's `render` (Slack markup to the web's tokens); URLs
 * that are not http(s) are dropped. Interactive parts the web cannot act on
 * (select menus, date pickers, inputs) are left out.
 */
import type {
  RichAttachment,
  RichBlock,
  RichButton,
  RichContextItem,
  RichField,
  RichImage,
} from "../../shared/slack-rich";

type Render = (markup: string) => Promise<string>;

const MAX_BLOCKS = 50;
const MAX_ATTACHMENTS = 10;
const MAX_FIELDS = 10;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `raw` when it is an http(s) URL, else undefined. */
export function safeUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function positive(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function image(
  url: unknown,
  alt: unknown,
  width?: unknown,
  height?: unknown,
): RichImage | undefined {
  const safe = safeUrl(url);
  if (!safe) return undefined;
  const out: RichImage = { url: safe, alt: str(alt) };
  const w = positive(width);
  const h = positive(height);
  if (w && h) {
    out.width = w;
    out.height = h;
  }
  return out;
}

/** A text object: mrkdwn is rendered, plain text kept as written. */
async function textObject(obj: any, render: Render): Promise<string> {
  const text = str(obj?.text);
  if (!text) return "";
  return obj?.type === "mrkdwn" ? render(text) : text;
}

function button(el: any): RichButton | undefined {
  if (el?.type !== "button") return undefined;
  const text = str(el.text?.text);
  if (!text) return undefined;
  const out: RichButton = { text };
  const url = safeUrl(el.url);
  if (url) out.url = url;
  if (el.style === "primary") out.primary = true;
  return out;
}

async function block(b: any, render: Render): Promise<RichBlock | null> {
  switch (b?.type) {
    case "header": {
      const text = await textObject(b.text, render);
      return text ? { type: "header", text } : null;
    }
    case "divider":
      return { type: "divider" };
    case "section": {
      const out: Extract<RichBlock, { type: "section" }> = { type: "section" };
      const text = await textObject(b.text, render);
      if (text) out.text = text;
      if (Array.isArray(b.fields) && b.fields.length) {
        const fields = [];
        for (const field of b.fields.slice(0, MAX_FIELDS)) {
          const value = await textObject(field, render);
          if (value) fields.push(value);
        }
        if (fields.length) out.fields = fields;
      }
      if (b.accessory?.type === "image") {
        const img = image(b.accessory.image_url, b.accessory.alt_text);
        if (img) out.image = img;
      }
      const accessoryButton = button(b.accessory);
      if (accessoryButton?.url) out.button = accessoryButton;
      return out.text || out.fields || out.image ? out : null;
    }
    case "context": {
      const items: RichContextItem[] = [];
      for (const el of Array.isArray(b.elements) ? b.elements : []) {
        if (el?.type === "image") {
          const img = image(el.image_url, el.alt_text);
          if (img) items.push({ kind: "image", image: img });
        } else {
          const text = await textObject(el, render);
          if (text) items.push({ kind: "text", text });
        }
      }
      return items.length ? { type: "context", items } : null;
    }
    case "image": {
      const img = image(b.image_url, b.alt_text, b.image_width, b.image_height);
      if (!img) return null;
      const title = await textObject(b.title, render);
      return title
        ? { type: "image", image: img, title }
        : { type: "image", image: img };
    }
    case "actions": {
      const buttons = (Array.isArray(b.elements) ? b.elements : [])
        .map(button)
        .filter((x: RichButton | undefined): x is RichButton => !!x);
      return buttons.length ? { type: "actions", buttons } : null;
    }
    case "video": {
      const title = await textObject(b.title, render);
      const out: Extract<RichBlock, { type: "video" }> = {
        type: "video",
        title: title || str(b.alt_text) || "Video",
      };
      const url = safeUrl(b.title_url) || safeUrl(b.video_url);
      if (url) out.url = url;
      const thumb = image(b.thumbnail_url, b.alt_text);
      if (thumb) out.thumb = thumb;
      const provider = str(b.provider_name);
      if (provider) out.provider = provider;
      return out;
    }
    default:
      // rich_text is the message's own text; the rest is interactive.
      return null;
  }
}

export async function richBlocks(
  blocks: unknown,
  render: Render,
): Promise<RichBlock[]> {
  if (!Array.isArray(blocks)) return [];
  const out: RichBlock[] = [];
  for (const b of blocks.slice(0, MAX_BLOCKS)) {
    const view = await block(b, render);
    if (view) out.push(view);
  }
  return out;
}

/** Blocks besides rich_text mean an app laid the message out itself, and
 *  Slack shows those instead of the text, which is then only a fallback. */
export function hasLayoutBlocks(blocks: unknown): boolean {
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (b: any) => b && typeof b === "object" && b.type !== "rich_text",
    )
  );
}

async function attachment(
  a: any,
  render: Render,
): Promise<RichAttachment | null> {
  if (!a || typeof a !== "object") return null;
  const out: RichAttachment = {};
  // Slack honours mrkdwn_in per field, but apps and unfurls in practice
  // all send markup, so every text field is rendered.
  const markup = (value: unknown) => {
    const text = str(value);
    return text ? render(text) : Promise.resolve("");
  };
  const color = str(a.color).replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(color)) out.color = color.toLowerCase();
  const pretext = await markup(a.pretext);
  if (pretext) out.pretext = pretext;
  const authorName = str(a.author_name);
  if (authorName) {
    const author: NonNullable<RichAttachment["author"]> = { name: authorName };
    const icon = safeUrl(a.author_icon);
    if (icon) author.icon = icon;
    const link = safeUrl(a.author_link);
    if (link) author.link = link;
    out.author = author;
  }
  const serviceName = str(a.service_name);
  if (serviceName && !authorName) {
    const service: NonNullable<RichAttachment["service"]> = {
      name: serviceName,
    };
    const icon = safeUrl(a.service_icon);
    if (icon) service.icon = icon;
    out.service = service;
  }
  const title = str(a.title);
  if (title) out.title = title;
  const titleLink = safeUrl(a.title_link);
  if (title && titleLink) out.titleLink = titleLink;
  const blocks = await richBlocks(a.blocks, render);
  if (blocks.length && hasLayoutBlocks(a.blocks)) out.blocks = blocks;
  else {
    const text = await markup(a.text);
    if (text) out.text = text;
  }
  if (Array.isArray(a.fields) && a.fields.length) {
    const fields: RichField[] = [];
    for (const field of a.fields.slice(0, MAX_FIELDS)) {
      const value = await markup(field?.value);
      const fieldTitle = str(field?.title);
      if (value || fieldTitle)
        fields.push({ title: fieldTitle, value, short: !!field?.short });
    }
    if (fields.length) out.fields = fields;
  }
  const big = image(
    a.image_url,
    title || serviceName,
    a.image_width,
    a.image_height,
  );
  if (big) out.image = big;
  else {
    const thumb = image(
      a.thumb_url,
      title || serviceName,
      a.thumb_width,
      a.thumb_height,
    );
    if (thumb) out.thumb = thumb;
  }
  const footer = await markup(a.footer);
  if (footer) out.footer = footer;
  const footerIcon = safeUrl(a.footer_icon);
  if (footer && footerIcon) out.footerIcon = footerIcon;
  const shown =
    out.pretext ||
    out.author ||
    out.title ||
    out.text ||
    out.fields ||
    out.image ||
    out.thumb ||
    out.blocks ||
    out.footer;
  return shown ? out : null;
}

export async function richAttachments(
  attachments: unknown,
  render: Render,
): Promise<RichAttachment[]> {
  if (!Array.isArray(attachments)) return [];
  const out: RichAttachment[] = [];
  for (const a of attachments.slice(0, MAX_ATTACHMENTS)) {
    const view = await attachment(a, render);
    if (view) out.push(view);
  }
  return out;
}
