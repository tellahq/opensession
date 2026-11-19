import {
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getKeptFrame,
  hideKeptFrame,
  keptFrameElement,
  keptFrameStepped,
  loadKeptFrame,
  showKeptFrame,
  subscribeKeptFrames,
} from "../lib/kept-frames";
import {
  type FrameHistory,
  canStepFrame,
  frameEntered,
  frameLoaded,
  frameReturned,
  frameStepped,
  freshFrameHistory,
} from "../lib/frame-history";
import { useFrameFocus } from "../hooks/useFrameFocus";
import { useFrameLocation } from "../hooks/useFrameLocation";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Input } from "../ui/input";
import { PageLoader } from "../ui/page-loader";
import { BrowserAnnotationLayer } from "./BrowserAnnotationLayer";
import {
  IconArrowUpRight,
  IconChevronLeft,
  IconChevronRight,
  IconMessage,
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
  /** The session a comment on this page goes to; enables Annotate. */
  commentSessionId?: string;
}

/**
 * A framed page with a browser's toolbar: back and forward, reload, an
 * address bar, and a break-out to a real browser tab. Portals and preview
 * deployments share it.
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
  commentSessionId,
}: BrowserPaneProps) {
  // The frame's own navigation is cross-origin and invisible to us, so the
  // address bar tracks what this pane loaded (the given URL, or one typed in)
  // until the page reports where it went (frame-location.ts).
  const [base, setBase] = useState(url);
  const [address, setAddress] = useState(url);
  const [reported, setReported] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState(() => freshFrameHistory(0));
  const [annotating, setAnnotating] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  useFrameFocus(
    frameRef,
    () => setHistory(frameEntered),
    () => setHistory((h) => frameReturned(h, window.history.length)),
  );
  useFrameLocation(frameRef, setReported);
  if (base !== url) {
    setBase(url);
    setAddress(url);
    setReported(null);
    setLoading(true);
    setHistory((h) => freshFrameHistory(h.length));
  }

  function load(next: string) {
    setAddress(next);
    setReported(null);
    setLoading(true);
    setHistory((h) => freshFrameHistory(h.length));
    setReloadNonce((nonce) => nonce + 1);
  }

  function loaded() {
    const length = window.history.length;
    setHistory((h) =>
      loading ? freshFrameHistory(length) : frameLoaded(h, length),
    );
    setLoading(false);
  }

  return (
    <div className={BROWSER_PANE}>
      <BrowserToolbar
        name={name}
        address={reported ?? address}
        history={history}
        onLoad={load}
        onStep={(delta, length) =>
          setHistory((h) => frameStepped(h, delta, length))
        }
        leading={leading}
        actions={actions}
        openWindowName={openWindowName}
        annotating={commentSessionId ? annotating : undefined}
        onAnnotate={setAnnotating}
      />
      <div className="relative min-h-0 flex-1 bg-white">
        {loading ? <BrowserLoading name={name} /> : null}
        {commentSessionId && annotating ? (
          <BrowserAnnotationLayer
            sessionId={commentSessionId}
            url={reported ?? address}
            frame={() => frameRef.current}
            onExit={() => setAnnotating(false)}
          />
        ) : null}
        <iframe
          key={`${address}#${reloadNonce}`}
          ref={frameRef}
          className={BROWSER_FRAME}
          src={address}
          title={frameTitle}
          onLoad={loaded}
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
  commentSessionId,
}: BrowserPaneProps & { keepAliveKey: string }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [annotating, setAnnotating] = useState(false);
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

  const address = frame?.url === url ? (frame.location ?? frame.address) : url;

  return (
    <div className={BROWSER_PANE}>
      <BrowserToolbar
        name={name}
        address={address}
        history={frame?.url === url ? frame.history : undefined}
        onLoad={(next) => loadKeptFrame(key, next)}
        onStep={(delta, length) => keptFrameStepped(key, delta, length)}
        leading={leading}
        actions={actions}
        openWindowName={openWindowName}
        annotating={commentSessionId ? annotating : undefined}
        onAnnotate={setAnnotating}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={setSlot} className="min-h-0 flex-1 bg-white" />
        {commentSessionId && annotating ? (
          <BrowserAnnotationLayer
            sessionId={commentSessionId}
            url={address}
            frame={() => keptFrameElement(key)}
            onExit={() => setAnnotating(false)}
          />
        ) : null}
      </div>
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
  address,
  history,
  onLoad,
  onStep,
  leading,
  actions,
  openWindowName = "_blank",
  annotating,
  onAnnotate,
}: {
  name: string;
  address: string;
  history: FrameHistory | undefined;
  onLoad: (address: string) => void;
  /**
   * Records a step at the window's current `history.length`; the toolbar
   * itself moves the window's history.
   */
  onStep: (delta: -1 | 1, length: number) => void;
  leading?: ReactNode;
  actions?: ReactNode;
  openWindowName?: string;
  /** Annotate mode, or undefined when this page takes no comments. */
  annotating?: boolean;
  onAnnotate?: (on: boolean) => void;
}) {
  const [shown, setShown] = useState(address);
  const [draft, setDraft] = useState(address);
  if (shown !== address) {
    setShown(address);
    setDraft(address);
  }
  // The frame's navigations are in the window's history, so stepping it
  // steps the frame, as the browser's own Back button would. Once the app has
  // pushed its own entries after the frame's, a step would move the app.
  const canStep = (delta: -1 | 1) =>
    !!history &&
    canStepFrame(history, delta) &&
    history.length === window.history.length;
  const step = (delta: -1 | 1) => {
    const go = canStep(delta);
    onStep(delta, window.history.length);
    if (go) window.history.go(delta);
  };

  return (
    <div className="flex min-h-11 items-center gap-1.5 border-b border-divider px-3 py-1.5">
      {leading}
      <Button
        variant="ghost"
        size="md"
        className="rounded-control"
        icon={<IconChevronLeft size={16} />}
        onClick={() => step(-1)}
        disabled={!canStep(-1)}
        aria-label={`Back in ${name}`}
        title="Back"
      />
      <Button
        variant="ghost"
        size="md"
        className="rounded-control"
        icon={<IconChevronRight size={16} />}
        onClick={() => step(1)}
        disabled={!canStep(1)}
        aria-label={`Forward in ${name}`}
        title="Forward"
      />
      <Button
        variant="ghost"
        size="md"
        className="rounded-control"
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
      {annotating !== undefined ? (
        <Button
          variant="ghost"
          size="md"
          // On reads as a light wash, not the soft plate: the toolbar already
          // sits on a grey strip, where the soft fill went heavy.
          className={cn(
            "rounded-control",
            annotating && "bg-hover text-fg hover:bg-pressed",
          )}
          icon={<IconMessage size={16} />}
          onClick={() => onAnnotate?.(!annotating)}
          aria-pressed={annotating}
          aria-label={
            annotating ? `Stop annotating ${name}` : `Annotate ${name}`
          }
          title={annotating ? "Stop annotating" : "Annotate"}
        />
      ) : null}
      <Button
        variant="ghost"
        size="md"
        className="rounded-control"
        icon={<IconArrowUpRight size={16} />}
        onClick={() => window.open(address, openWindowName, "noopener")}
        aria-label={`Open ${name} in a new browser tab`}
        title="Open in browser"
      />
      {actions}
    </div>
  );
}
