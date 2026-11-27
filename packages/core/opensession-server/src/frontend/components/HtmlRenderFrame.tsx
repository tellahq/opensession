import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  htmlResult,
  htmlThemeFragment,
  htmlThemeMessage,
  readHtmlContentHeight,
  readHtmlLinkRequest,
  type HtmlRenderReference,
} from "@tellahq/opensession-protocol/html-render";
import { BASE_PATH } from "../lib/base";
import { openBlockExpand } from "../lib/block-expand";
import { readHtmlTheme } from "../lib/html-theme";
import { onThemeChanged } from "../lib/theme";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { IconExpand } from "./icons";

/**
 * The page runs its own script, with an opaque origin: no allow-same-origin,
 * so it never reaches the app's cookies, storage, DOM or API (the asset
 * route also serves it with a CSP sandbox, for a page opened on its own).
 * No popups or modals: links come out as `open-link` requests, which the
 * client opens itself, and a page that loads with the transcript must not
 * raise a blocking dialog.
 */
export const HTML_RENDER_SANDBOX = "allow-scripts allow-forms allow-downloads";
const ALLOW = "clipboard-write; fullscreen";

function frameSrc(ref: HtmlRenderReference): string {
  return `${BASE_PATH}${ref.url}${htmlThemeFragment(readHtmlTheme())}`;
}

/** Answer a page's messages: fit to its height, open its links. */
function listen(
  frame: () => HTMLIFrameElement | null,
  onHeight?: (height: number) => void,
): () => void {
  const onMessage = (event: MessageEvent) => {
    const target = frame()?.contentWindow;
    if (!target || event.source !== target) return;
    const height = readHtmlContentHeight(event.data);
    if (height !== undefined) {
      onHeight?.(height);
      return;
    }
    const link = readHtmlLinkRequest(event.data);
    if (link) {
      window.open(link.url, "_blank", "noopener,noreferrer");
      target.postMessage(htmlResult(link.id), "*");
    }
  };
  // Theme changes reach a mounted page as a message; its URL keeps the
  // theme it loaded with, so the page never reloads.
  const offTheme = onThemeChanged(() =>
    frame()?.contentWindow?.postMessage(htmlThemeMessage(readHtmlTheme()), "*"),
  );
  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("message", onMessage);
    offTheme();
  };
}

function createFrame(ref: HtmlRenderReference): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", HTML_RENDER_SANDBOX);
  frame.setAttribute("allow", ALLOW);
  frame.referrerPolicy = "no-referrer";
  frame.title = ref.title;
  frame.className = "md-artifact-frame";
  frame.src = frameSrc(ref);
  return frame;
}

/**
 * An agent's HTML render inline in the transcript: the page itself on the
 * transcript's background, at the server's measured height for this width
 * until the page reports its own, so nothing below it moves while it loads.
 */
export function HtmlRenderFrame({ render }: { render: HtmlRenderReference }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const [contentHeight, setContentHeight] = useState<number>();
  // The page keeps the URL (and so the theme fragment) it first loaded with.
  const [src] = useState(() => frameSrc(render));

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => listen(() => frameRef.current, setContentHeight), []);

  const height = htmlRenderFrameHeight(render, width, contentHeight);

  const expand = () =>
    openBlockExpand({
      title: render.title,
      fill: true,
      mount(host) {
        const frame = createFrame(render);
        frame.dataset.fill = "";
        host.append(frame);
        const stop = listen(() => frame);
        return () => {
          stop();
          host.replaceChildren();
        };
      },
    });

  return (
    <figure className="mx-0 my-2" data-html-render={render.path}>
      <div ref={boxRef} style={{ height }}>
        <iframe
          ref={frameRef}
          src={src}
          title={render.title}
          sandbox={HTML_RENDER_SANDBOX}
          allow={ALLOW}
          referrerPolicy="no-referrer"
          className="block size-full border-0 bg-transparent"
        />
      </div>
      {/* Under the page, never over it: a frame takes the pointer, so the
          transcript cannot reveal a control on hover there. */}
      <figcaption className="flex min-h-8 items-center gap-2 text-meta text-faint">
        <span className="min-w-0 flex-1 truncate">{render.title}</span>
        <Tooltip label="Expand">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconExpand size={20} />}
            aria-label={`Expand ${render.title}`}
            onClick={expand}
          />
        </Tooltip>
      </figcaption>
    </figure>
  );
}
