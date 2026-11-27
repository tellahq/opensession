import { z } from "zod";

/**
 * Comments on a page in the Browser or Portal tab.
 *
 * Annotate mode lays a transparent layer over the framed page: a click marks
 * a point, a drag marks an area, and the comment goes to the chat with where
 * it was made. The page is cross-origin, so this window cannot read its DOM.
 * A page that wants its comments to name the element under them answers an
 * inspect request (the desktop app adds this answer to every framed page):
 *
 *   parent → page  { type: "opensession:inspect", id, x, y }
 *   page → parent  { type: "opensession:inspected", id, element, scroll, viewport }
 *
 * `x` and `y` are CSS pixels from the page's top left; `element` is the one
 * `document.elementFromPoint` finds there, or null. A page without an answer
 * still gets point and area comments, sized against the frame.
 */

export const INSPECT_REQUEST = "opensession:inspect";
export const INSPECT_REPLY = "opensession:inspected";

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const rectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});

const elementSchema = z.object({
  selector: z.string().max(400),
  tag: z.string().max(40),
  text: z.string().max(400).optional(),
  rect: rectSchema,
});

const replySchema = z.object({
  type: z.literal(INSPECT_REPLY),
  id: z.string(),
  element: elementSchema.nullable(),
  scroll: z.object({ x: z.number().finite(), y: z.number().finite() }),
  viewport: z.object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }),
});

export type InspectedElement = z.infer<typeof elementSchema>;
export type InspectReply = z.infer<typeof replySchema>;

/** A reply from `frame` to the request `id`, or null for anything else. */
export function inspectReply(
  event: Pick<MessageEvent, "data" | "source">,
  frame: MessageEventSource | null | undefined,
  id: string,
): InspectReply | null {
  if (!frame || event.source !== frame) return null;
  const parsed = replySchema.safeParse(event.data);
  return parsed.success && parsed.data.id === id ? parsed.data : null;
}

/** Below this many pixels of travel a press is a click, not a drag. */
export const DRAG_THRESHOLD = 6;

export type BrowserMark =
  | { kind: "point"; x: number; y: number }
  | { kind: "area"; rect: FrameRect };

/** What a press from `start` to `end` marked, in frame pixels. */
export function markBetween(
  start: { x: number; y: number },
  end: { x: number; y: number },
): BrowserMark {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
    return { kind: "point", x: Math.round(start.x), y: Math.round(start.y) };
  }
  return {
    kind: "area",
    rect: {
      x: Math.round(Math.min(start.x, end.x)),
      y: Math.round(Math.min(start.y, end.y)),
      width: Math.round(Math.abs(dx)),
      height: Math.round(Math.abs(dy)),
    },
  };
}

/** The point to inspect for a mark: the click, or the middle of the area. */
export function markCenter(mark: BrowserMark): { x: number; y: number } {
  return mark.kind === "point"
    ? { x: mark.x, y: mark.y }
    : {
        x: Math.round(mark.rect.x + mark.rect.width / 2),
        y: Math.round(mark.rect.y + mark.rect.height / 2),
      };
}

/** The box a mark draws: the element it landed on, the area, or a dot. */
export function markBox(
  mark: BrowserMark,
  element: InspectedElement | null,
): FrameRect {
  if (mark.kind === "area") return mark.rect;
  if (element) return element.rect;
  return { x: mark.x - 8, y: mark.y - 8, width: 16, height: 16 };
}

export interface BrowserComment {
  url: string;
  /** Set for a session asset: the comment names the file, not a URL. */
  asset?: string;
  mark: BrowserMark;
  /** The frame's size in CSS pixels. */
  view: { width: number; height: number };
  /** From the page's own answer, when it gave one. */
  inspected: InspectReply | null;
  text: string;
}

const px = (n: number) => Math.round(n);

function oneLine(text: string, max = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max
    ? `${compact.slice(0, max).trimEnd()}...`
    : compact;
}

function scaleMark(mark: BrowserMark, ratio: number): BrowserMark {
  return mark.kind === "point"
    ? { kind: "point", x: mark.x * ratio, y: mark.y * ratio }
    : {
        kind: "area",
        rect: {
          x: mark.rect.x * ratio,
          y: mark.rect.y * ratio,
          width: mark.rect.width * ratio,
          height: mark.rect.height * ratio,
        },
      };
}

/**
 * The chat message for a comment: where it was made as a quoted header, then
 * what the person wrote. The header is plain enough for the agent to open the
 * same page at the same size and find the spot again.
 */
export function browserCommentMessage(comment: BrowserComment): string {
  const { inspected } = comment;
  // Marks are made in the layer's pixels. A page drawn scaled (an inline
  // asset shown at desktop width) has its own, and those are what the agent
  // can find the spot again in.
  const viewport = inspected?.viewport;
  const ratio =
    viewport && comment.view.width > 0
      ? viewport.width / comment.view.width
      : 1;
  const scaled = Math.abs(ratio - 1) > 0.02;
  const mark = scaled ? scaleMark(comment.mark, ratio) : comment.mark;
  const view = scaled && viewport ? viewport : comment.view;
  const where =
    mark.kind === "point"
      ? `Point at (${px(mark.x)}, ${px(mark.y)})`
      : `Area ${px(mark.rect.width)}×${px(mark.rect.height)} at (${px(mark.rect.x)}, ${px(mark.rect.y)})`;
  const scroll = inspected?.scroll;
  const scrolled =
    scroll && (scroll.x || scroll.y)
      ? `, scrolled to (${px(scroll.x)}, ${px(scroll.y)})`
      : "";
  const lines = [
    comment.asset
      ? `Comment on asset \`${comment.asset.replaceAll("`", "'")}\``
      : `Browser comment on ${comment.url}`,
    `${where} in a ${px(view.width)}×${px(view.height)} view${scrolled}`,
  ];
  const element = inspected?.element;
  if (element) {
    const text = element.text ? oneLine(element.text) : "";
    const selector = element.selector.replaceAll("`", "'");
    lines.push(`Element \`${selector}\`${text ? `: "${text}"` : ""}`);
  }
  const header = lines.map((line) => `> ${line}`).join("\n");
  return `${header}\n\n${comment.text.trim()}`;
}
