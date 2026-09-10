/**
 * The DOM half of an artifact block: the sandboxed frame, its header row
 * (label, Source toggle, expand) and the height grip under it. The
 * document inside the frame and the policy on it come from
 * artifact-document.ts, which is where the security lives; this file only
 * puts that document into an <iframe sandbox> and never reads out of it.
 *
 * Height: a frame cannot report its content's height (scripts are off), so
 * it starts at the default and has a grip to drag; an SVG is sized to its
 * own aspect ratio up front.
 */

import { expandIconMarkup } from "../components/icons";
import {
  ARTIFACT_DEFAULT_HEIGHT,
  ARTIFACT_SANDBOX,
  artifactHtmlDocument,
  artifactSvgDocument,
  clampArtifactHeight,
  svgArtifactSize,
  type ArtifactTheme,
} from "./artifact-document";
import { openBlockExpand } from "./block-expand";

const WRAP_CLASS = "md-artifact-wrap";
const FRAME_CLASS = "md-artifact-frame";
const FRAME_SELECTOR = `iframe.${FRAME_CLASS}`;

interface FrameSpec {
  srcdoc: string;
  label: string;
}

/** The page's tokens, resolved, for the document's base style. The system
 *  colours are the fallback when a token is missing: they follow the
 *  document's color-scheme rather than pinning a colour here. */
function readTheme(): ArtifactTheme {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    bg: token("--bg", "Canvas"),
    text: token("--text", "CanvasText"),
    link: token("--link", "LinkText"),
    font: token("--sans", "system-ui, sans-serif"),
    scheme:
      document.documentElement.dataset.theme === "light" ? "light" : "dark",
  };
}

function frameSpec(source: string, lang: string): FrameSpec {
  const theme = readTheme();
  return lang === "svg"
    ? { srcdoc: artifactSvgDocument(source, theme), label: "SVG" }
    : { srcdoc: artifactHtmlDocument(source, theme), label: "Artifact" };
}

/**
 * A frame loads exactly once, with the artifact. A later load means the
 * document navigated itself, which with scripts off and every link aimed
 * at a window the sandbox refuses takes a click on a link the author
 * marked `_self`; the frame goes back to the artifact, same size, same
 * place. The grip and the dialog find the frame through its container, so
 * the swap is invisible to them.
 */
function createFrame(spec: FrameSpec): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = FRAME_CLASS;
  frame.title = `${spec.label} preview`;
  // The attribute is set before srcdoc so the document never loads outside
  // the sandbox.
  frame.setAttribute("sandbox", ARTIFACT_SANDBOX);
  frame.referrerPolicy = "no-referrer";
  frame.srcdoc = spec.srcdoc;
  let loaded = false;
  frame.addEventListener("load", () => {
    if (!loaded) {
      loaded = true;
      return;
    }
    const fresh = createFrame(spec);
    fresh.style.cssText = frame.style.cssText;
    if (frame.dataset.fill !== undefined) fresh.dataset.fill = "";
    frame.replaceWith(fresh);
  });
  return frame;
}

function button(
  className: string,
  label: string,
  html: string,
): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.title = label;
  el.setAttribute("aria-label", label);
  el.innerHTML = html;
  return el;
}

/** Drag or arrow the frame's height. The grip is a real button so it is in
 *  the tab order; pointer capture keeps a drag alive over the frame. */
function attachGrip(
  grip: HTMLButtonElement,
  body: HTMLElement,
  wrap: HTMLElement,
): void {
  const frame = () => body.querySelector<HTMLIFrameElement>(FRAME_SELECTOR);
  const height = () => frame()?.getBoundingClientRect().height ?? 0;
  const setHeight = (next: number) => {
    const el = frame();
    if (!el) return;
    el.style.height = `${clampArtifactHeight(next)}px`;
    wrap.dataset.sized = "manual";
  };
  let start: { y: number; height: number } | null = null;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    start = { y: e.clientY, height: height() };
    grip.setPointerCapture(e.pointerId);
    wrap.dataset.resizing = "";
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!start) return;
    setHeight(start.height + (e.clientY - start.y));
  });
  const end = () => {
    start = null;
    delete wrap.dataset.resizing;
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowDown") setHeight(height() + step);
    else if (e.key === "ArrowUp") setHeight(height() - step);
    else return;
    e.preventDefault();
  });
}

/**
 * Replace `pre` with the block, keeping `pre` inside it (hidden) for the
 * Source view and the copy control.
 */
export function mountArtifactBlock(
  pre: HTMLElement,
  source: string,
  lang: string,
): void {
  const spec = frameSpec(source, lang);
  const wrap = document.createElement("div");
  wrap.className = WRAP_CLASS;
  wrap.dataset.view = "preview";

  const head = document.createElement("div");
  head.className = "md-artifact-head";
  const label = document.createElement("span");
  label.className = "md-artifact-label";
  label.textContent = spec.label;
  const spacer = document.createElement("span");
  spacer.className = "md-artifact-spacer";
  const sourceToggle = document.createElement("button");
  sourceToggle.type = "button";
  sourceToggle.className = "md-artifact-btn";
  sourceToggle.textContent = "Source";
  sourceToggle.setAttribute("aria-pressed", "false");
  sourceToggle.addEventListener("click", () => {
    const showing = wrap.dataset.view === "source";
    wrap.dataset.view = showing ? "preview" : "source";
    sourceToggle.setAttribute("aria-pressed", String(!showing));
  });
  const expand = button(
    "md-artifact-btn md-artifact-expand",
    `Expand ${spec.label.toLowerCase()}`,
    expandIconMarkup(16),
  );
  expand.addEventListener("click", () => {
    openBlockExpand({
      title: spec.label,
      fill: true,
      mount(host) {
        const large = createFrame(spec);
        large.dataset.fill = "";
        host.append(large);
        return () => host.replaceChildren();
      },
    });
  });
  head.append(label, spacer, sourceToggle, expand);

  const body = document.createElement("div");
  body.className = "md-artifact-body";
  const frame = createFrame(spec);
  frame.style.height = `${ARTIFACT_DEFAULT_HEIGHT}px`;
  const grip = button("md-artifact-grip", "Resize preview", "");
  body.append(frame, grip);
  attachGrip(grip, body, wrap);

  // The block takes the fence's place first, then takes the fence in: the
  // other way round, `pre` has already left the document by the time it
  // is asked to be replaced.
  pre.replaceWith(wrap);
  wrap.append(head, body, pre);

  // An SVG declares its size, so the frame can take its aspect ratio at the
  // width it landed in. Measured after mounting, which is when there is a
  // width to measure.
  if (lang === "svg") {
    const size = svgArtifactSize(source);
    const width = body.clientWidth;
    if (size && width > 0)
      frame.style.height = `${clampArtifactHeight((width * size.h) / size.w)}px`;
  }
}
