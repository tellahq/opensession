/**
 * Preparing a rendered mermaid diagram for the media lightbox.
 *
 * The viewer shows the LIVE SVG rather than a rasterized copy: a diagram is
 * zoomed to read the labels on it, and a bitmap scaled up eight times is
 * exactly the thing you cannot read. So the markup is re-sized on the way in.
 * Mermaid fits its root <svg> to the column it first rendered into (width
 * "100%" plus an inline max-width), which would otherwise pin the diagram to
 * transcript width in the middle of a full-screen viewer, and an inline style
 * beats any class the viewer could add. Both come off here.
 *
 * Markup in, markup out, so this stays testable without a DOM: the caller
 * hands over the rendered element's outerHTML.
 */

export interface DiagramMedia {
  /** Standalone SVG markup, carrying its own intrinsic size. */
  svg: string;
  /** That size, so the viewer can letterbox the diagram like a picture. */
  size: { w: number; h: number };
}

const OPEN_TAG = /^\s*<svg\b([^>]*)>/i;

/** The lookbehind keeps `width` from also matching `stroke-width`. */
function attrPattern(name: string, flags: string): RegExp {
  return new RegExp(`(?<![-\\w])${name}\\s*=\\s*("[^"]*"|'[^']*')`, flags);
}

function attrValue(attrs: string, name: string): string | null {
  const match = attrPattern(name, "i").exec(attrs);
  return match ? match[1].slice(1, -1) : null;
}

function withoutAttrs(attrs: string, names: string[]): string {
  return names
    .reduce((rest, name) => rest.replace(attrPattern(name, "gi"), " "), attrs)
    .replace(/\s+/g, " ")
    .trim();
}

/** The diagram's own coordinate size. The viewBox is the honest one; the
 * width/height attributes describe the column mermaid rendered into. */
function intrinsicSize(attrs: string): { w: number; h: number } | null {
  const view = (attrValue(attrs, "viewBox") ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (view.length === 4 && view[2] > 0 && view[3] > 0)
    return { w: view[2], h: view[3] };
  const w = Number.parseFloat(attrValue(attrs, "width") ?? "");
  const h = Number.parseFloat(attrValue(attrs, "height") ?? "");
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Drop just the max-width declaration, keeping any other inline style. */
function withoutMaxWidth(attrs: string): string {
  const style = attrValue(attrs, "style");
  if (style === null) return attrs;
  const kept = style
    .split(";")
    .filter((rule) => rule.trim() && !/^\s*max-width\s*:/i.test(rule))
    .join("; ")
    .trim();
  const rest = withoutAttrs(attrs, ["style"]);
  return kept ? `${rest} style="${kept}"` : rest;
}

/**
 * Re-size one rendered diagram so it can be shown at any size, or null if the
 * markup is not an <svg> that declares how big it is.
 *
 * Everything else about the markup is left alone on purpose: mermaid scopes
 * its own <style> block by the root's id and references its arrowheads with
 * url(#id), so the id has to survive the trip. That does mean two copies of
 * one diagram share an id while the viewer is open. They are identical, so the
 * refs resolve to the same shapes either way.
 */
export function readDiagramSvg(markup: string): DiagramMedia | null {
  const open = OPEN_TAG.exec(markup);
  if (!open) return null;
  const size = intrinsicSize(open[1]);
  if (!size) return null;
  const attrs = withoutMaxWidth(
    withoutAttrs(open[1], ["width", "height", "preserveAspectRatio"]),
  );
  const tag =
    `<svg ${attrs} width="${size.w}" height="${size.h}"` +
    ` preserveAspectRatio="xMidYMid meet">`;
  return { svg: tag + markup.slice(open[0].length), size };
}

/** The diagram as a file, for Download. encodeURIComponent rather than btoa:
 * a label can hold anything, and btoa throws on anything outside Latin-1. */
export function diagramDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
