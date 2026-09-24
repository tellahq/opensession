import { type ReactNode, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PageLoader } from "../ui/page-loader";
import { IconArrowUpRight, IconRestore } from "./icons";

/**
 * What the person typed, as a URL the frame can load. A bare host gets https,
 * except a local one, which gets http as a browser would.
 */
export function browserAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text)
    ? text
    : `${local.test(text) ? "http" : "https"}://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * A framed page with a browser's toolbar: an address bar, reload, and a
 * break-out to a real browser tab. Portals and preview deployments share it.
 */
export function BrowserPane({
  url,
  name,
  frameTitle,
  leading,
  actions,
  openWindowName = "_blank",
  allow,
  sandbox,
}: {
  url: string;
  /** Names the page in control labels ("Reload Simulator"). */
  name: string;
  frameTitle: string;
  /** Status to the left of the address bar. */
  leading?: ReactNode;
  /** Extra controls after the built-in ones. */
  actions?: ReactNode;
  openWindowName?: string;
  allow?: string;
  sandbox?: string;
}) {
  // The frame's own navigation is cross-origin and invisible to us, so the
  // address bar tracks what this pane loaded: the given URL, or one typed in.
  const [base, setBase] = useState(url);
  const [address, setAddress] = useState(url);
  const [draft, setDraft] = useState(url);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  if (base !== url) {
    setBase(url);
    setAddress(url);
    setDraft(url);
    setLoading(true);
  }

  function load(next: string) {
    setAddress(next);
    setDraft(next);
    setLoading(true);
    setReloadNonce((nonce) => nonce + 1);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex min-h-11 items-center gap-1.5 border-b border-divider px-3 py-1.5">
        {leading}
        <Button
          variant="ghost"
          size="md"
          icon={<IconRestore size={16} />}
          onClick={() => load(address)}
          aria-label={`Reload ${name}`}
          title="Reload"
        />
        <Input
          size="md"
          type="text"
          inputMode="url"
          enterKeyHint="go"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={`${name} address`}
          className="min-w-0 flex-1 text-supporting text-dim focus:text-fg"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.target.select()}
          onBlur={() => setDraft(address)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              const next = browserAddress(draft);
              if (next) load(next);
              else setDraft(address);
            } else if (event.key === "Escape") {
              setDraft(address);
              event.currentTarget.blur();
            }
          }}
        />
        <Button
          variant="ghost"
          size="md"
          icon={<IconArrowUpRight size={16} />}
          onClick={() => window.open(address, openWindowName, "noopener")}
          aria-label={`Open ${name} in a new browser tab`}
          title="Open in browser"
        />
        {actions}
      </div>
      <div className="relative min-h-0 flex-1 bg-white">
        {loading ? (
          <div
            role="status"
            aria-label={`Loading ${name}`}
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-panel"
          >
            <PageLoader className="text-dim" />
          </div>
        ) : null}
        <iframe
          key={`${address}#${reloadNonce}`}
          className="block h-full w-full border-0 bg-white"
          src={address}
          title={frameTitle}
          onLoad={() => setLoading(false)}
          allow={allow}
          sandbox={sandbox}
        />
      </div>
    </div>
  );
}
