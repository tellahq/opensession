import { motion, useReducedMotion } from "motion/react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type BrowserMark,
  type FrameRect,
  INSPECT_REQUEST,
  type InspectReply,
  type InspectedElement,
  browserCommentMessage,
  inspectReply,
  markBetween,
  markBox,
  markCenter,
} from "../lib/browser-annotation";
import { captureMarkedFrame } from "../lib/browser-annotation-capture";
import { submitPageComment } from "../lib/image-region-comment-registry";
import { anchoredCommentPosition } from "../lib/image-region-comment";
import { errorMessage } from "../lib/error-message";
import { randomUUID } from "../lib/random-uuid";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { duration } from "../ui/motion";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { IconArrowUp, IconX } from "./icons";

/** How long a page gets to answer an inspect request before we go without. */
const INSPECT_TIMEOUT_MS = 250;

/** Ask the framed page what is at (x, y). Null when it does not answer. */
function inspectFrame(
  frame: HTMLIFrameElement | null,
  point: { x: number; y: number },
): Promise<InspectReply | null> {
  const target = frame?.contentWindow;
  if (!target) return Promise.resolve(null);
  const id = randomUUID();
  return new Promise((resolve) => {
    const done = (reply: InspectReply | null) => {
      window.removeEventListener("message", listener);
      clearTimeout(timer);
      resolve(reply);
    };
    const listener = (event: MessageEvent) => {
      const reply = inspectReply(event, target, id);
      if (reply) done(reply);
    };
    const timer = setTimeout(() => done(null), INSPECT_TIMEOUT_MS);
    window.addEventListener("message", listener);
    target.postMessage({ type: INSPECT_REQUEST, id, ...point }, "*");
  });
}

interface Pending {
  mark: BrowserMark;
  inspected: InspectReply | null;
  view: { width: number; height: number };
  screenshot: File | null;
}

/**
 * Annotate mode over a framed page: hover names the element under the
 * pointer (when the page answers inspect requests), a click marks it or a
 * point, a drag marks an area, and the comment card sends it to the chat.
 */
export function BrowserAnnotationLayer({
  sessionId,
  url,
  frame,
  asset,
  inspect,
  capture,
  scrollBy,
  hint = "Click an element or drag an area",
  onExit,
}: {
  sessionId: string;
  /** The page's current address, as the address bar shows it. */
  url: string;
  /** The framed page, looked up when needed: kept frames live elsewhere. */
  frame?: () => HTMLIFrameElement | null;
  /** A session asset under the layer: the comment names it instead of a URL. */
  asset?: string;
  /** Read what is at a point directly, instead of asking the framed page. */
  inspect?: (
    layer: HTMLElement,
    point: { x: number; y: number },
  ) => InspectReply | null;
  /** The comment's picture, when the default window capture does not fit. */
  capture?: (layer: DOMRect, box: FrameRect) => Promise<File | null>;
  /** Scroll what is under the layer; true when it moved. */
  scrollBy?: (dx: number, dy: number) => boolean;
  hint?: string;
  onExit: () => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [hover, setHover] = useState<InspectedElement | null>(null);
  const [press, setPress] = useState<{
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardSize, setCardSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const hoverBusy = useRef(false);
  const reduceMotion = useReducedMotion();

  const local = (event: ReactPointerEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const reset = () => {
    setPending(null);
    setText("");
    setError(null);
    setCardSize(null);
  };

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    // Esc belongs to the comment layer, not the dialog or chat behind it.
    event.stopPropagation();
    if (pending && !sending) reset();
    else if (!pending) onExit();
  });
  useEffect(() => {
    // Capture phase, so Esc closes the comment before the transcript reads it
    // as the first press of a stop.
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
  // A wheel over the layer scrolls what is under it. Native and non-passive:
  // when the page moved, the chat around it must not scroll too.
  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (scrollBy?.(event.deltaX, event.deltaY)) event.preventDefault();
  });
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const listener = (event: WheelEvent) => onWheel(event);
    layer.addEventListener("wheel", listener, { passive: false });
    return () => layer.removeEventListener("wheel", listener);
  }, []);
  const inspectAt = (point: { x: number; y: number }) => {
    const layer = layerRef.current;
    if (inspect) return Promise.resolve(layer ? inspect(layer, point) : null);
    return inspectFrame(frame?.() ?? null, point);
  };

  useLayoutEffect(() => {
    if (!pending) return;
    const card = cardRef.current;
    if (!card) return;
    const { width, height } = card.getBoundingClientRect();
    setCardSize((size) =>
      size?.width === width && size.height === height
        ? size
        : { width, height },
    );
  }, [pending, text, error]);
  // Focus once the card is placed: it stays hidden for its first measured
  // frame, and a hidden field cannot take focus.
  const placed = Boolean(pending && cardSize);
  useEffect(() => {
    if (placed) inputRef.current?.focus({ preventScroll: true });
  }, [placed]);

  const hoverAt = async (point: { x: number; y: number }) => {
    if (hoverBusy.current || pending) return;
    hoverBusy.current = true;
    const reply = await inspectAt(point);
    hoverBusy.current = false;
    setHover(reply?.element ?? null);
  };

  const finishPress = async (end: { x: number; y: number }) => {
    if (!press) return;
    const mark = markBetween(press.start, end);
    setPress(null);
    setHover(null);
    const layer = layerRef.current?.getBoundingClientRect();
    if (!layer) return;
    const inspected = await inspectAt(markCenter(mark));
    const box = markBox(mark, inspected?.element ?? null);
    const screenshot = await (capture ?? captureMarkedFrame)(layer, box).catch(
      () => null,
    );
    setPending({
      mark,
      inspected,
      view: { width: layer.width, height: layer.height },
      screenshot,
    });
  };

  const send = async () => {
    const typed = text.trim();
    if (!pending || !typed || sending) return;
    setSending(true);
    setError(null);
    await submitPageComment({
      sessionId,
      text: browserCommentMessage({ url, asset, ...pending, text: typed }),
      files: pending.screenshot ? [pending.screenshot] : [],
    }).then(
      () => {
        reset();
        toast("Comment sent to chat");
      },
      (failure) => setError(errorMessage(failure, "Could not send comment")),
    );
    setSending(false);
  };

  const marked: FrameRect | null = pending
    ? markBox(pending.mark, pending.inspected?.element ?? null)
    : press
      ? (() => {
          const mark = markBetween(press.start, press.end);
          return mark.kind === "area" ? mark.rect : null;
        })()
      : (hover?.rect ?? null);
  const anchor =
    pending && marked
      ? anchoredCommentPosition(
          {
            left: marked.x,
            top: marked.y,
            width: marked.width,
            height: marked.height,
          },
          cardSize ?? { width: 320, height: 52 },
          pending.view,
        )
      : null;

  return (
    <div
      ref={layerRef}
      // Over the frame, which paints from KeptFrameLayer: z-10 lifts this
      // above it. A crosshair says the page is not live while this is up.
      className="absolute inset-0 z-10 cursor-crosshair touch-none overflow-hidden select-none"
      data-testid="browser-annotation-layer"
      // A dialog around the layer leaves Esc to it (ui/sheet.tsx).
      data-consumes-escape=""
      onPointerMove={(event) => {
        if (press) {
          setPress({ ...press, end: local(event) });
        } else if (event.pointerType === "mouse") {
          void hoverAt(local(event));
        }
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return;
        if (pending) {
          // A press outside the card while one is open dismisses it, unless
          // something is written: losing words to a stray click is worse.
          if (!text.trim() && !sending) reset();
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        const at = local(event);
        setPress({ start: at, end: at });
      }}
      onPointerUp={(event) => {
        if (press) void finishPress(local(event));
      }}
      onPointerCancel={() => setPress(null)}
    >
      {!pending && !press ? (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <div className="rounded-[999px] bg-popup-glass px-3 py-1.5 text-label text-fg [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-md">
            {hint}
          </div>
        </div>
      ) : null}
      {marked ? (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute rounded-sm border-2 border-blue",
            pending || press ? "bg-blue/10" : "bg-blue/5",
          )}
          style={{
            left: marked.x,
            top: marked.y,
            width: marked.width,
            height: marked.height,
          }}
        />
      ) : null}
      {pending && anchor ? (
        <motion.form
          ref={cardRef}
          className="absolute flex w-[min(340px,calc(100%-24px))] cursor-text flex-col gap-1 rounded-popup bg-popup-glass p-1.5 [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-md"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", duration: duration.base, bounce: 0 }}
          style={{
            left: anchor.left,
            top: anchor.top,
            transformOrigin:
              anchor.placement === "above" ? "bottom left" : "top left",
            visibility: cardSize ? undefined : "hidden",
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className="flex items-end gap-1">
            <textarea
              ref={inputRef}
              value={text}
              rows={1}
              placeholder="What should change here?"
              aria-label="Comment"
              disabled={sending}
              onChange={(event) => {
                setText(event.target.value);
                const field = event.target;
                field.style.height = "0px";
                field.style.height = `${Math.min(field.scrollHeight, 132)}px`;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  window.matchMedia("(hover: hover) and (pointer: fine)")
                    .matches
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
              className="block min-h-9 w-full flex-1 resize-none appearance-none border-0 bg-transparent px-2.5 py-2 text-body leading-snug text-fg outline-none [scrollbar-width:none] placeholder:text-faint phone:min-h-11 phone:text-input-phone [&::-webkit-scrollbar]:hidden"
            />
            <Tooltip label="Cancel" shortcut={["Esc"]}>
              <Button
                variant="ghost"
                size="lg"
                icon={<IconX size={16} />}
                className="shrink-0 rounded-[999px]"
                onClick={reset}
                disabled={sending}
                aria-label="Cancel comment"
              />
            </Tooltip>
            <Tooltip label="Send" shortcut={["↵"]}>
              <Button
                type="submit"
                variant="primary"
                size="lg"
                icon={<IconArrowUp size={17} />}
                className="shrink-0 rounded-[999px]"
                disabled={!text.trim() || sending}
                aria-label={sending ? "Sending comment" : "Send comment"}
              />
            </Tooltip>
          </div>
          {error ? (
            <div className="px-2.5 pb-1 text-label text-red" role="alert">
              {error}
            </div>
          ) : null}
        </motion.form>
      ) : null}
    </div>
  );
}
