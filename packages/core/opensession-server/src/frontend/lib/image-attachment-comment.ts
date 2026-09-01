import type { ImageRegion } from "./image-region-comment";

const IMAGE_REFERENCE_SOURCE = String.raw`\[Image (\d+) · (\d+)–(\d+)% × (\d+)–(\d+)%\]`;
const IMAGE_REFERENCE_RE = new RegExp(`${IMAGE_REFERENCE_SOURCE}[ \\t]?`, "g");
const IMAGE_COMMENT_RE = new RegExp(
  `${IMAGE_REFERENCE_SOURCE}[ \\t]+([^\\n]+)`,
  "g",
);

function percent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 100)));
}

function unit(value: string): number {
  return Math.min(1, Math.max(0, Number(value) / 100));
}

/** One comment encoded in the draft beside the image it describes. */
export interface ImageAttachmentComment {
  /** Stable while this comment's starting offset does not move. */
  id: string;
  imageIndex: number;
  region: ImageRegion;
  text: string;
  reference: string;
  start: number;
  end: number;
}

/** A compact, model-readable reference to one selected area of an attachment. */
export function imageAttachmentReference(
  index: number,
  region: ImageRegion,
): string {
  const left = percent(region.x);
  const top = percent(region.y);
  const right = percent(region.x + region.width);
  const bottom = percent(region.y + region.height);
  return `[Image ${index + 1} · ${left}–${right}% × ${top}–${bottom}%]`;
}

/** Read every complete image comment directly from the composer draft. */
export function parseImageAttachmentComments(
  text: string,
): ImageAttachmentComment[] {
  if (!text.includes("[Image ")) return [];
  const comments: ImageAttachmentComment[] = [];
  IMAGE_COMMENT_RE.lastIndex = 0;
  for (
    let match = IMAGE_COMMENT_RE.exec(text);
    match;
    match = IMAGE_COMMENT_RE.exec(text)
  ) {
    const left = unit(match[2]);
    const right = unit(match[3]);
    const top = unit(match[4]);
    const bottom = unit(match[5]);
    comments.push({
      id: String(match.index),
      imageIndex: Number(match[1]) - 1,
      region: {
        x: Math.min(left, right),
        y: Math.min(top, bottom),
        width: Math.abs(right - left),
        height: Math.abs(bottom - top),
      },
      text: match[6].trim(),
      reference: match[0].slice(0, match[0].indexOf("]") + 1),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return comments;
}

function oneLine(comment: string): string {
  return comment.trim().replace(/\s+/g, " ");
}

/** Add one complete image comment to the message being composed. */
export function appendImageAttachmentComment(
  text: string,
  index: number,
  region: ImageRegion,
  comment: string,
): string {
  const said = oneLine(comment);
  if (!said) return text;
  const line = `${imageAttachmentReference(index, region)} ${said}`;
  const base = text.replace(/\s+$/, "");
  return base ? `${base}\n${line}` : line;
}

function findComment(
  text: string,
  existing: Pick<
    ImageAttachmentComment,
    "id" | "imageIndex" | "region" | "text"
  >,
): ImageAttachmentComment | undefined {
  const comments = parseImageAttachmentComments(text);
  return (
    comments.find((comment) => comment.id === existing.id) ??
    comments.find(
      (comment) =>
        comment.imageIndex === existing.imageIndex &&
        comment.reference ===
          imageAttachmentReference(existing.imageIndex, existing.region) &&
        comment.text === oneLine(existing.text),
    )
  );
}

/** Replace an existing annotation in place, keeping the rest of the draft. */
export function updateImageAttachmentComment(
  text: string,
  existing: Pick<
    ImageAttachmentComment,
    "id" | "imageIndex" | "region" | "text"
  >,
  region: ImageRegion,
  comment: string,
): string {
  const current = findComment(text, existing);
  const said = oneLine(comment);
  if (!current || !said) return text;
  const line = `${imageAttachmentReference(current.imageIndex, region)} ${said}`;
  return text.slice(0, current.start) + line + text.slice(current.end);
}

/** Delete one annotation line without disturbing prose around it. */
export function deleteImageAttachmentComment(
  text: string,
  existing: Pick<
    ImageAttachmentComment,
    "id" | "imageIndex" | "region" | "text"
  >,
): string {
  const current = findComment(text, existing);
  if (!current) return text;
  let { start, end } = current;
  if (text[end] === "\n") end += 1;
  else if (start > 0 && text[start - 1] === "\n") start -= 1;
  return text.slice(0, start) + text.slice(end);
}

/** Keep later attachment numbers correct when an earlier image is removed.
 * References to the removed image lose their token but keep the person's text. */
export function rebaseImageAttachmentReferences(
  text: string,
  removedIndex: number,
): string {
  const removedNumber = removedIndex + 1;
  IMAGE_REFERENCE_RE.lastIndex = 0;
  return text.replace(IMAGE_REFERENCE_RE, (reference, rawNumber: string) => {
    const number = Number(rawNumber);
    if (number === removedNumber) return "";
    if (number < removedNumber) return reference;
    return reference.replace(`Image ${number}`, `Image ${number - 1}`);
  });
}
