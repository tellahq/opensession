/**
 * The DOM half of an artifact block: the sandboxed frame, its header row
 * (label, Source toggle, expand) and the height control under it. The
 * document inside the frame and the policy on it come from
 * artifact-document.ts, which is where the security lives; this file only
 * puts that document into an <iframe sandbox> and never reads back out of
 * it.
 *
 * Height: a scripted artifact posts its document height (the reporter in
 * artifact-document.ts) and the frame follows it, within limits. A static
 * one cannot report, so it starts at the default and has a grip to drag; an
 * SVG is sized to its own aspect ratio up front. A frame the person has
 * dragged stops following reports.
 */

import { expandIconMarkup } from "../components/icons";
import {
  ARTIFACT_DEFAULT_HEIGHT,
  artifactHtmlDocument,
  artifactOptionsFromInfo,
  artifactSandbox,
  artifactSvgDocument,
  artifactHeightMessageSchema,
  clampArtifactHeight,
  svgArtifactSize,
  type ArtifactTheme,
} from "./artifact-document";
import { openBlockExpand } from "./block-expand";

const WRAP_CLASS = "md-artifact-wrap";
const FRAME_CLASS = "md-artifact-frame";

interface FrameSpec {
  srcdoc: string;
  sandbox: string;
  scripts: boolean;
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

function frameSpec(source: string, lang: string, info: string): FrameSpec {
  const theme = readTheme();
  if (lang === "svg") {
    return {
      srcdoc: artifactSvgDocument(source, theme),
      sandbox: artifactSandbox({ scripts: false }),
      scripts: false,
      label: "SVG",
    };
  }
  const options = artifactOptionsFromInfo(info);
  return {
    srcdoc: artifactHtmlDocument(source, options, theme),
    sandbox: artifactSandbox(options),
    scripts: options.scripts,
    label: "Artifact",
  };
}

function createFrame(spec: FrameSpec): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = FRAME_CLASS;
  frame.title = `${spec.label} preview`;
  // The attribute is set before srcdoc so the document never loads outside
  // the sandbox. An empty value is the fully locked sandbox.
  frame.setAttribute("sandbox", spec.sandbox);
  frame.referrerPolicy = "no-referrer";
  frame.srcdoc = spec.srcdoc;
  return frame;
}

let listening = false;
/** One window listener for every artifact frame on the page. A message is
 *  matched to its frame by source window; the height it carries is clamped
 *  before it touches layout, so a hostile artifact can at most be tall. */
function ensureHeightListener(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent) => {
    const message = artifactHeightMessageSchema.safeParse(event.data);
    if (!message.success) return;
    const height = clampArtifactHeight(message.data.height);
    for (const frame of document.querySelectorAll<HTMLIFrameElement>(
      `iframe.${FRAME_CLASS}`,
    )) {
      if (frame.contentWindow !== event.source) continue;
      const wrap = frame.closest<HTMLElement>(`.${WRAP_CLASS}`);
      if (
        !wrap ||
        wrap.dataset.sized === "manual" ||
        frame.dataset.fill !== undefined
      )
        continue;
      frame.style.height = `${height}px`;
    }
  });
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
  frame: HTMLIFrameElement,
  wrap: HTMLElement,
): void {
  const setHeight = (height: number) => {
    frame.style.height = `${clampArtifactHeight(height)}px`;
    wrap.dataset.sized = "manual";
  };
  let start: { y: number; height: number } | null = null;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    start = { y: e.clientY, height: frame.getBoundingClientRect().height };
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
    const current = frame.getBoundingClientRect().height;
    if (e.key === "ArrowDown") setHeight(current + step);
    else if (e.key === "ArrowUp") setHeight(current - step);
    else return;
    e.preventDefault();
  });
}

/**
 * Replace `pre` with the block, keeping `pre` inside it (hidden) for the
 * Source view and the copy control. `info` is the fence's whole info string
 * when the renderer kept it (`artifact scripts`), else just the language.
 */
export function mountArtifactBlock(
  pre: HTMLElement,
  source: string,
  lang: string,
  info: string,
): void {
  const spec = frameSpec(source, lang, info);
  const wrap = document.createElement("div");
  wrap.className = WRAP_CLASS;
  wrap.dataset.view = "preview";

  const head = document.createElement("div");
  head.className = "md-artifact-head";
  const label = document.createElement("span");
  label.className = "md-artifact-label";
  label.textContent = spec.label;
  head.append(label);
  if (spec.scripts) {
    const tag = document.createElement("span");
    tag.className = "md-artifact-tag";
    tag.textContent = "Scripts on";
    head.append(tag);
  }
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
        return () => large.remove();
      },
    });
  });
  head.append(spacer, sourceToggle, expand);

  const body = document.createElement("div");
  body.className = "md-artifact-body";
  const frame = createFrame(spec);
  frame.style.height = `${ARTIFACT_DEFAULT_HEIGHT}px`;
  const grip = button("md-artifact-grip", "Resize preview", "");
  body.append(frame, grip);
  attachGrip(grip, frame, wrap);
  if (spec.scripts) ensureHeightListener();

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
