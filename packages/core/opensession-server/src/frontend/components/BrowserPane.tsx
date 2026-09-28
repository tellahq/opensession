import {
  type ReactNode,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getKeptFrame,
  hideKeptFrame,
  loadKeptFrame,
  showKeptFrame,
  subscribeKeptFrames,
  stepKeptFrame,
} from "../lib/kept-frames";
import {
  type BrowserHistory,
  canStep,
  currentAddress,
  startHistory,
  stepHistory,
  visitAddress,
} from "../lib/browser-history";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PageLoader } from "../ui/page-loader";
import {
  IconArrowUpRight,
  IconChevronLeft,
  IconChevronRight,
  IconRestore,
} from "./icons";

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

interface BrowserPaneProps {
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
  /**
   * Keeps the page loaded after this pane unmounts, so coming back to it
   * (another tab, another session) finds it where it was. See kept-frames.ts.
   */
  keepAliveKey?: string;
}

/**
 * A framed page with a browser's toolbar: back and forward, reload, an
 * address bar, and a
 * break-out to a real browser tab. Portals and preview deployments share it.
 */
export function BrowserPane(props: BrowserPaneProps) {
  return props.keepAliveKey ? (
    <KeptBrowserPane {...props} keepAliveKey={props.keepAliveKey} />
  ) : (
    <OwnedBrowserPane {...props} />
  );
}

/** The frame lives and dies with this pane. */
function OwnedBrowserPane({
  url,
  name,
  frameTitle,
  leading,
  actions,
  openWindowName,
  allow,
  sandbox,
}: BrowserPaneProps) {
  // The frame's own navigation is cross-origin and invisible to us, so the
  // address bar tracks what this pane loaded: the given URL, or one typed in.
  const [base, setBase] = useState(url);
  const [history, setHistory] = useState(() => startHistory(url));
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  if (base !== url) {
    setBase(url);
    setHistory(startHistory(url));
    setLoading(true);
  }
  const address = currentAddress(history);

  function show(next: BrowserHistory) {
    setHistory(next);
    setLoading(true);
    setReloadNonce((nonce) => nonce + 1);
  }

  return (
    <div className={BROWSER_PANE}>
      <BrowserToolbar
        name={name}
        history={history}
        onLoad={(next) => show(visitAddress(history, next))}
        onStep={(delta) => show(stepHistory(history, delta))}
        leading={leading}
        actions={actions}
        openWindowName={openWindowName}
      />
      <div className="relative min-h-0 flex-1 bg-white">
        {loading ? <BrowserLoading name={name} /> : null}
        <iframe
          key={`${address}#${reloadNonce}`}
          className={BROWSER_FRAME}
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

/**
 * The frame lives in KeptFrameLayer; this pane only marks where it goes. The
 * slot is not positioned, so the layer's frame paints over it.
 */
function KeptBrowserPane({
  url,
  name,
  frameTitle,
  leading,
  actions,
  openWindowName,
  allow,
  sandbox,
  keepAliveKey: key,
}: BrowserPaneProps & { keepAliveKey: string }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const read = () => getKeptFrame(key);
  const frame = useSyncExternalStore(subscribeKeptFrames, read, read);
  useLayoutEffect(() => {
    if (!slot) return;
    return () => hideKeptFrame(key, slot);
  }, [key, slot]);
  useLayoutEffect(() => {
    if (!slot) return;
    showKeptFrame(key, { url, name, title: frameTitle, allow, sandbox }, slot);
  }, [key, slot, url, name, frameTitle, allow, sandbox]);

  return (
    <div className={BROWSER_PANE}>
      <BrowserToolbar
        name={name}
        history={frame?.url === url ? frame.history : startHistory(url)}
        onLoad={(next) => loadKeptFrame(key, next)}
        onStep={(delta) => stepKeptFrame(key, delta)}
        leading={leading}
        actions={actions}
        openWindowName={openWindowName}
      />
      <div ref={setSlot} className="min-h-0 flex-1 bg-white" />
    </div>
  );
}

const BROWSER_PANE = "flex h-full min-h-0 flex-col bg-panel";
export const BROWSER_FRAME = "block h-full w-full border-0 bg-white";

export function BrowserLoading({ name }: { name: string }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${name}`}
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-panel"
    >
      <PageLoader className="text-dim" />
    </div>
  );
}

function BrowserToolbar({
  name,
  history,
  onLoad,
  onStep,
  leading,
  actions,
  openWindowName = "_blank",
}: {
  name: string;
  history: BrowserHistory;
  onLoad: (address: string) => void;
  onStep: (delta: -1 | 1) => void;
  leading?: ReactNode;
  actions?: ReactNode;
  openWindowName?: string;
}) {
  const address = currentAddress(history);
  const [shown, setShown] = useState(address);
  const [draft, setDraft] = useState(address);
  if (shown !== address) {
    setShown(address);
    setDraft(address);
  }

  return (
    <div className="flex min-h-11 items-center gap-1.5 border-b border-divider px-3 py-1.5">
      {leading}
      <Button
        variant="ghost"
        size="md"
        icon={<IconChevronLeft size={16} />}
        onClick={() => onStep(-1)}
        disabled={!canStep(history, -1)}
        aria-label={`Back in ${name}`}
        title="Back"
      />
      <Button
        variant="ghost"
        size="md"
        icon={<IconChevronRight size={16} />}
        onClick={() => onStep(1)}
        disabled={!canStep(history, 1)}
        aria-label={`Forward in ${name}`}
        title="Forward"
      />
      <Button
        variant="ghost"
        size="md"
        icon={<IconRestore size={16} />}
        onClick={() => onLoad(address)}
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
            setDraft(next ?? address);
            if (next) onLoad(next);
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
  );
}
