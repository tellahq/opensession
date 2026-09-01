"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import posterAsset from "./demo-poster.webp";
import posterDarkAsset from "./demo-poster-dark.webp";
import phoneAsset from "./demo-phone.webp";
import phoneDarkAsset from "./demo-phone-dark.webp";
import { assetUrl } from "./asset-url";

const posterUrl = assetUrl(posterAsset);
const posterDarkUrl = assetUrl(posterDarkAsset);
const phoneUrl = assetUrl(phoneAsset);
const phoneDarkUrl = assetUrl(phoneDarkAsset);

/* The product is laid out at a stable desktop width, then scaled to fit the
   hero window. This keeps its real responsive layout from rearranging as the
   marketing page changes size. */
const desktopDemoWidth = 1260;

export function ProductDemo() {
  const previewRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const updateScale = () => {
      const scale = Math.min(1, preview.clientWidth / desktopDemoWidth);
      preview.style.setProperty("--demo-scale", String(scale));
    };
    const observer = new ResizeObserver(updateScale);
    observer.observe(preview);
    updateScale();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.type !== "opensession-demo-ready") return;
      // A route error must never replace the poster. Only reveal a frame that
      // contains the fixture app itself, not merely a same-origin document.
      if (!frameRef.current?.contentDocument?.querySelector(".app")) return;
      setReady(true);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return (
    <>
      <figure ref={previewRef} className="preview-wrap" data-ready={ready}>
        {/* The local poster paints immediately. The fixture-backed app fades in
				    only after it has rendered, so the hero never exposes a loading shell. */}
        <picture>
          <source srcSet={posterDarkUrl} media="(prefers-color-scheme: dark)" />
          <img
            className="product-demo-poster"
            src={posterUrl}
            alt="The Open Session workspace: a list of sessions beside a transcript."
            fetchPriority="high"
            aria-hidden={ready}
          />
        </picture>
        <iframe
          ref={frameRef}
          className="product-demo-frame"
          title="Interactive Open Session product preview"
          aria-hidden={!ready}
          tabIndex={ready ? undefined : -1}
          // Keep the compatibility URL: it works on the Next server and on the
          // static marketing host, where the extensionless route is a 404.
          src="product-demo.html"
          loading="eager"
          onLoad={() => {
            if (!frameRef.current?.contentDocument?.querySelector(".app"))
              setReady(false);
          }}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin"
        />
      </figure>

      {/* The supporting phone stays a local image so the page only boots one
			    copy of the app. */}
      <picture>
        <source srcSet={phoneDarkUrl} media="(prefers-color-scheme: dark)" />
        <img
          className="demo-phone"
          src={phoneUrl}
          alt="The same session open in Open Session on a phone."
        />
      </picture>
    </>
  );
}
