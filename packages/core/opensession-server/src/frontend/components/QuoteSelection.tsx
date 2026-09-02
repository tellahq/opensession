import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { newQuote, type Quote } from "../lib/quotes";
import {
  placeQuoteOffer,
  type OfferRect,
  type OfferPlacement,
} from "../lib/quote-offer";
import { Button } from "../ui/button";
import { duration, ease } from "../ui/motion";
import { IconBrowserTab, IconCursor } from "./icons";

interface Props {
  /** The region whose text can be quoted: the transcript scroller. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** The one passage currently riding along with the next message. */
  quote: Quote | null;
  /** Attaches a passage as context: only ever from the pill. */
  onQuote: (quote: Quote) => void;
  /** Opens a sibling chat with the passage already quoted. */
  onStartNewChat: (quote: Quote) => void;
  /** Clears the current context and native selection. */
  onClear: () => void;
  /** Focuses the composer: after a passage is added, and when typing or
   *  pasting outside the composer indicates input intent. */
  onInputIntent?: () => HTMLTextAreaElement | null;
  /** Read-only viewers (no composer to carry the quote into) pass true. */
  disabled?: boolean;
}

/** Registry name for the staged passage's own highlight. See base.css. */
const QUOTE_HIGHLIGHT = "quote";

/** The offered passage: what it says, and the two line boxes it hangs off. */
interface Offer {
  text: string;
  first: OfferRect;
  last: OfferRect;
}

/** First and last line box of a selection. `null` for a range that paints
 *  nothing, which is what a selection collapsed by a re-render looks like. */
function lineBoxes(range: Range): { first: OfferRect; last: OfferRect } | null {
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length === 0) return null;
  return { first: rects[0]!, last: rects[rects.length - 1]! };
}

/**
 * Transcript context, on request: releasing a selection floats an "Add to
 * chat" pill above it, and pressing that pill, nothing else, stages the
 * passage for the next message. Selecting to copy, or to re-read a line, costs
 * nothing; the composer only changes shape when someone asked it to.
 *
 * Attaching takes the native selection away and paints the passage with our
 * own Custom Highlight instead. That is both what keeps ONE band under the
 * words (the two selections stack otherwise, our accent under the browser's
 * grey inactive one) and what survives the click into the composer, which
 * collapses the real selection.
 */
export function QuoteSelection({
  containerRef,
  quote,
  onQuote,
  onStartNewChat,
  onClear,
  onInputIntent,
  disabled,
}: Props) {
  const stagedRef = useRef<Range | null>(null);
  const offerRangeRef = useRef<Range | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [placement, setPlacement] = useState<OfferPlacement | null>(null);

  const clear = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    stagedRef.current = null;
    onClear();
  }, [onClear]);

  const capture = useCallback(() => {
    const container = containerRef.current;
    if (!container || disabled) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed ||
      text.length < 2
    ) {
      setOffer(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer)
    )
      return;
    const boxes = lineBoxes(range);
    if (!boxes) return;
    offerRangeRef.current = range.cloneRange();
    setOffer({ text, ...boxes });
  }, [containerRef, disabled]);

  const add = () => {
    const range = offerRangeRef.current;
    if (!range || !offer) return;
    stagedRef.current = range;
    onQuote(newQuote(offer.text));
    window.getSelection()?.removeAllRanges();
    setOffer(null);
    onInputIntent?.();
  };

  const startNewChat = () => {
    if (!offer) return;
    window.getSelection()?.removeAllRanges();
    setOffer(null);
    onStartNewChat(newQuote(offer.text));
  };

  useEffect(() => {
    if (disabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (event: Event) => {
      if (event instanceof MouseEvent || event instanceof TouchEvent) {
        if (event instanceof MouseEvent && event.button !== 0) return;
        const container = containerRef.current;
        const target = event.target;
        if (
          !container ||
          !(target instanceof Node) ||
          !container.contains(target)
        )
          return;
        if (event instanceof MouseEvent) {
          capture();
          return;
        }
      }
      if (event instanceof KeyboardEvent && event.key !== "Shift") return;
      clearTimeout(timer);
      timer = setTimeout(capture, event.type === "touchend" ? 250 : 0);
    };
    document.addEventListener("mouseup", settle);
    document.addEventListener("touchend", settle);
    document.addEventListener("keyup", settle);
    return () => {
      document.removeEventListener("mouseup", settle);
      document.removeEventListener("touchend", settle);
      document.removeEventListener("keyup", settle);
      clearTimeout(timer);
    };
  }, [capture, containerRef, disabled]);

  // Measured, not guessed: the pill's width decides whether it fits beside a
  // passage that ends near the right edge, and its own label is what sets
  // that width. A layout effect lands the position before the browser paints.
  useLayoutEffect(() => {
    const actions = actionsRef.current;
    if (!offer || !actions) {
      setPlacement(null);
      return;
    }
    setPlacement(
      placeQuoteOffer(
        offer.first,
        offer.last,
        { width: actions.offsetWidth, height: actions.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [offer]);

  // The pill points at words, so it follows them: scrolling the transcript
  // moves it, and scrolling the passage out of the transcript withdraws the
  // offer rather than leaving a pill pointing at a header.
  const offered = offer !== null;
  useEffect(() => {
    if (!offered) return;
    const follow = () => {
      const range = offerRangeRef.current;
      const container = containerRef.current;
      const boxes = range ? lineBoxes(range) : null;
      if (!boxes || !container) return setOffer(null);
      const bounds = container.getBoundingClientRect();
      if (boxes.last.bottom < bounds.top || boxes.first.top > bounds.bottom)
        return setOffer(null);
      setOffer((current) => (current ? { ...current, ...boxes } : current));
    };
    document.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      document.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [offered, containerRef]);

  // Any press that isn't on the pill withdraws the offer: it is either the
  // start of a new selection (which offers itself on release) or a decision
  // not to take this one. Escape says the same thing from the keyboard.
  useEffect(() => {
    if (!offered) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && actionsRef.current?.contains(target))
        return;
      setOffer(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOffer(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [offered]);

  // Mark the staged passage independently of focus and of the native
  // selection, both of which the next click takes away. Browsers without the
  // Custom Highlight API simply lose the mark once you click; the chip in the
  // composer still says what is attached.
  useEffect(() => {
    const highlights = CSS.highlights;
    if (!highlights || typeof Highlight === "undefined") return;
    const range = stagedRef.current;
    if (!quote || !range) {
      highlights.delete(QUOTE_HIGHLIGHT);
      return;
    }
    highlights.set(QUOTE_HIGHLIGHT, new Highlight(range));
    return () => {
      highlights.delete(QUOTE_HIGHLIGHT);
    };
  }, [quote]);

  useEffect(() => {
    if (!quote) stagedRef.current = null;
  }, [quote]);

  useEffect(() => {
    if (!quote) return;
    const isTextEditor = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") return clear();
      const target = event.target;
      if (isTextEditor(target)) return;
      const container = containerRef.current;
      if (
        target instanceof Node &&
        target !== document.body &&
        target !== document.documentElement &&
        !container?.contains(target)
      )
        return;
      if (
        target instanceof Element &&
        target.closest(
          "button, a, select, [role='button'], [role='link'], [role='menuitem'], [role='option']",
        )
      )
        return;
      const modifier = event.metaKey || event.ctrlKey;
      if (event.key === "Enter") {
        const textarea = onInputIntent?.();
        if (!textarea) return;
        event.preventDefault();
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: event.key,
            code: event.code,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
          }),
        );
        return;
      }
      const startsInput =
        (!modifier && !event.altKey && event.key.length === 1) ||
        (modifier && !event.altKey && event.key.toLowerCase() === "v") ||
        (!modifier &&
          !event.altKey &&
          event.shiftKey &&
          event.key === "Insert");
      if (startsInput) onInputIntent?.();
    };
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || isTextEditor(event.target)) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      const textarea = onInputIntent?.();
      if (!textarea) return;
      event.preventDefault();
      if (document.execCommand("insertText", false, text)) return;
      textarea.setRangeText(
        text,
        textarea.selectionStart,
        textarea.selectionEnd,
        "end",
      );
      textarea.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: text,
          inputType: "insertFromPaste",
        }),
      );
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("paste", onPaste);
    };
  }, [quote, clear, containerRef, onInputIntent]);

  if (!offer) return null;

  return createPortal(
    <motion.div
      ref={actionsRef}
      role="group"
      aria-label="Selected text actions"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "tween", duration: duration.micro, ease }}
      className="fixed z-1000 inline-flex min-h-8 items-stretch overflow-hidden whitespace-nowrap rounded-[999px] bg-popup text-label font-semibold text-fg [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-sm"
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        // One frame before the measurement lands. Hidden rather than
        // unmounted: the pill has to be in the DOM to be measured.
        visibility: placement ? "visible" : "hidden",
      }}
      // The press must not collapse the selection it is about to attach:
      // the passage stays visibly selected right up to the click.
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button
        variant="ghost"
        size="md"
        icon={<IconCursor size={20} />}
        onClick={add}
        className="rounded-none text-fg hover:text-fg focus-visible:z-[1]"
      >
        Add to chat
      </Button>
      <Button
        variant="ghost"
        size="md"
        icon={<IconBrowserTab size={20} />}
        onClick={startNewChat}
        className="rounded-none border-l-line-strong text-fg hover:text-fg focus-visible:z-[1]"
      >
        Start new chat
      </Button>
    </motion.div>,
    document.body,
  );
}
