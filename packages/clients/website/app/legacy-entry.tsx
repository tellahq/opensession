"use client";

import { useEffect } from "react";

export function LandingEntry() {
  useEffect(() => {
    void import("../main");
  }, []);

  return <div id="root" />;
}

export function SetupEntry() {
  useEffect(() => {
    document.body.classList.add("setup-body");
    void import("../setup-main");
    return () => document.body.classList.remove("setup-body");
  }, []);

  return <div id="root" />;
}

const applyPreviewTheme = () => {
  document.documentElement.dataset.theme = window.matchMedia(
    "(prefers-color-scheme: dark)",
  ).matches
    ? "dark"
    : "light";
};

export function ProductDemoEntry() {
  useEffect(() => {
    applyPreviewTheme();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", applyPreviewTheme);
    void import("../product-demo-main");
    return () => media.removeEventListener("change", applyPreviewTheme);
  }, []);

  return (
    <>
      <div id="root" />
      <div className="demo-status-bar" aria-hidden="true">
        <time>9:41</time>
        <span className="demo-status-icons">
          <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor">
            <rect x="0" y="7.5" width="3" height="3.5" rx="1" />
            <rect x="4.6" y="5.5" width="3" height="5.5" rx="1" />
            <rect x="9.2" y="3" width="3" height="8" rx="1" />
            <rect x="13.8" y="0" width="3" height="11" rx="1" />
          </svg>
          <svg
            width="15"
            height="11"
            viewBox="0 0 15 11"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
          >
            <path d="M1.1 3.5a9.2 9.2 0 0 1 12.8 0" strokeWidth="1.9" />
            <path d="M3.6 6.2a5.7 5.7 0 0 1 7.8 0" strokeWidth="1.9" />
            <path d="M6.1 8.9a2.1 2.1 0 0 1 2.8 0" strokeWidth="1.9" />
          </svg>
          <svg width="25" height="12" viewBox="0 0 25 12" fill="none">
            <rect
              x="0.6"
              y="0.6"
              width="21"
              height="10.8"
              rx="3.2"
              stroke="currentColor"
              strokeOpacity="0.38"
              strokeWidth="1.1"
            />
            <path
              d="M23.1 4.3v3.4a1.9 1.9 0 0 0 0-3.4Z"
              fill="currentColor"
              fillOpacity="0.38"
            />
            <rect
              x="2.2"
              y="2.2"
              width="17.8"
              height="7.6"
              rx="2"
              fill="currentColor"
            />
          </svg>
        </span>
      </div>
    </>
  );
}
