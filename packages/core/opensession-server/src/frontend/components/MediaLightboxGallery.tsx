import { mergeStylexProps } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  canUseNativeIOSShare,
  nativeShareWasCancelled,
  saveFileWithNativeShare,
  shareURL,
} from "../lib/native-file-save";
import { copyImageToClipboard } from "../lib/image-clipboard";
import { copyToClipboard } from "../lib/share-link";
import { isApple } from "../lib/platform";
import { eventChord } from "../lib/shortcut-chord";
import { fullTime } from "../lib/time";
import {
  WALKTHROUGH_LABEL_CLASS,
  WALKTHROUGH_LABEL_TEXT,
  WALKTHROUGH_LABEL_TONE,
} from "../lib/walkthrough-label";
import { useIsPhone } from "../hooks/useIsPhone";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { toast } from "../ui/toast";
import {
  anchoredCommentPosition,
  type ImageRegion,
  type ScreenRect,
} from "../lib/image-region-comment";
import {
  canCommentOnImageRegion,
  submitImageRegionComment,
} from "../lib/image-region-comment-registry";
import {
  type FocusOptionsWithVisible,
  type ImageRegionAnnotation,
  type LightboxItem,
  mediaDownloadHref,
  shareableMediaSrc,
  suggestedMediaName,
} from "../lib/media-lightbox";
import {
  LIGHTBOX_ACTION_CLASS,
  LIGHTBOX_PREVIEW_LABEL,
  MAX_VISIBLE_LIGHTBOX_DOTS,
} from "../lib/media-lightbox-gallery";
import { MediaLightboxViewer } from "./MediaLightboxViewer";
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowUpRight,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconLink,
  IconMessage,
  IconShare,
  IconX,
} from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  fixed: {
    position: "fixed",
  },
  inset0: {
    inset: "0",
  },
  z11000: {
    zIndex: "11000",
  },
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  bgBlack85: {
    backgroundColor: "color-mix(in oklab, var(--color-black) 85%, transparent)",
  },
  phoneH100dvh: {
    "@media (max-width: 720px)": {
      height: "100dvh",
    },
  },
  phoneBgBlack: {
    "@media (max-width: 720px)": {
      backgroundColor: "var(--color-black)",
    },
  },
  minH0: {
    minHeight: "0",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  selfStretch: {
    alignSelf: "stretch",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  maxHFull: {
    maxHeight: "100%",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  rounded2xl: {
    borderRadius: "calc(22px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderWhite20: {
    borderColor: "color-mix(in oklab, var(--color-white) 20%, transparent)",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  px6: {
    paddingInline: "calc(4px * 6)",
  },
  textCenter: {
    textAlign: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  lineClamp2: {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: "2",
  },
  textSm: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-sm--line-height))",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textWhite: {
    color: "var(--color-white)",
  },
  textWhite75: {
    color: "color-mix(in oklab, var(--color-white) 75%, transparent)",
  },
  h12: {
    height: "calc(4px * 12)",
  },
  gap1: {
    gap: "4px",
  },
  overflowXAuto: {
    overflowX: "auto",
  },
  pxCalc5022px: {
    paddingInline: "calc(50% - 22px)",
  },
  ScrollbarWidthNone: {
    scrollbarWidth: "none",
  },
  grid: {
    display: "grid",
  },
  size11: {
    width: "calc(4px * 11)",
    height: "calc(4px * 11)",
  },
  shrink0: {
    flexShrink: "0",
  },
  snapCenter: {
    scrollSnapAlign: "center",
  },
  placeItemsCenter: {
    placeItems: "center",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  p0: {
    padding: "0",
  },
  sizeFull: {
    width: "100%",
    height: "100%",
  },
  objectCover: {
    objectFit: "cover",
  },
  gridCols3: {
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  justifySelfStart: {
    justifySelf: "flex-start",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  insetX0: {
    insetInline: "0",
  },
  bottomCalc16pxEnvSafeAreaInsetBottom: {
    bottom: "calc(16px + env(safe-area-inset-bottom))",
  },
  z20: {
    zIndex: "20",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  pointerEventsAuto: {
    pointerEvents: "auto",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  borderWhite10: {
    borderColor: "color-mix(in oklab, var(--color-white) 10%, transparent)",
  },
  bgBlack55: {
    backgroundColor: "color-mix(in oklab, var(--color-black) 55%, transparent)",
  },
  py1: {
    paddingBlock: "4px",
  },
  pl4: {
    paddingLeft: "calc(4px * 4)",
  },
  pr1: {
    paddingRight: "4px",
  },
  minH9: {
    minHeight: "calc(4px * 9)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  textWhite70: {
    color: "color-mix(in oklab, var(--color-white) 70%, transparent)",
  },
  hoverBgWhite10: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor:
          "color-mix(in oklab, var(--color-white) 10%, transparent)",
      },
    },
  },
  hoverTextWhite: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--color-white)",
      },
    },
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  cursorText: {
    cursor: "text",
  },
  rounded22px: {
    borderRadius: "22px",
    cornerShape: "var(--cs)",
  },
  p15: {
    padding: "calc(4px * 1.5)",
  },
  itemsEnd: {
    alignItems: "flex-end",
  },
  block: {
    display: "block",
  },
  wFull: {
    width: "100%",
  },
  resizeNone: {
    resize: "none",
  },
  appearanceNone: {
    appearance: "none",
  },
  px25: {
    paddingInline: "calc(4px * 2.5)",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  outlineNone: {
    outlineStyle: "none",
  },
  placeholderTextWhite45: {
    "::placeholder": {
      color: "color-mix(in oklab, var(--color-white) 45%, transparent)",
    },
  },
  phoneTextInputPhone: {
    "@media (max-width: 720px)": {
      fontSize: "var(--type-input-phone)",
    },
  },
  size9: {
    width: "calc(4px * 9)",
    height: "calc(4px * 9)",
  },
  textWhite60: {
    color: "color-mix(in oklab, var(--color-white) 60%, transparent)",
  },
  phoneSize11: {
    "@media (max-width: 720px)": {
      width: "calc(4px * 11)",
      height: "calc(4px * 11)",
    },
  },
  bgAccent: {
    backgroundColor: "var(--accent)",
  },
  transitionTransform: {
    transitionProperty: "transform, translate, scale, rotate",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  activeScale096: {
    ":active": {
      scale: "0.96",
    },
  },
  disabledBgWhite15: {
    ":disabled": {
      backgroundColor:
        "color-mix(in oklab, var(--color-white) 15%, transparent)",
    },
  },
  disabledTextWhite40: {
    ":disabled": {
      color: "color-mix(in oklab, var(--color-white) 40%, transparent)",
    },
  },
  pb1: {
    paddingBottom: "4px",
  },
  textRed: {
    color: "var(--red)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  maxWMin720px90vw: {
    maxWidth: "min(720px, 90vw)",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  p1: {
    padding: "4px",
  },
  leadingNone: {
    lineHeight: "1",
  },
  textWhite50: {
    color: "color-mix(in oklab, var(--color-white) 50%, transparent)",
  },
});

export function MediaLightboxGallery({
  items,
  index,
  onIndex,
  onClose,
  useHeroTransition,
  startCommenting = false,
  heroTransitionName,
}: {
  items: LightboxItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: (allowHeroTransition?: boolean) => void;
  useHeroTransition: boolean;
  startCommenting?: boolean;
  heroTransitionName?: string;
}) {
  const isPhone = useIsPhone();
  const item = items[index];
  const many = items.length > 1;
  const [chromeVisible, setChromeVisible] = useState(true);
  const [phoneBottomHeight, setPhoneBottomHeight] = useState(0);
  const phoneBottomRef = useRef<HTMLDivElement>(null);
  const filmstripRef = useRef<HTMLDivElement>(null);
  const filmstripIndexRef = useRef(index);
  const dotStart = Math.min(
    Math.max(0, index - Math.floor(MAX_VISIBLE_LIGHTBOX_DOTS / 2)),
    Math.max(0, items.length - MAX_VISIBLE_LIGHTBOX_DOTS),
  );
  const dotIndexes = Array.from(
    { length: Math.min(items.length, MAX_VISIBLE_LIGHTBOX_DOTS) },
    (_, offset) => dotStart + offset,
  );
  const [imageZoomed, setImageZoomed] = useState(false);
  // Which file the copy receipt belongs to, so a page turn shows the fresh
  // "Copy link" for the item now on screen rather than a stale "Copied".
  const [copiedSrc, setCopiedSrc] = useState<string | null>(null);
  const copied = !!item && copiedSrc === item.src;
  const [savingSrc, setSavingSrc] = useState<string | null>(null);
  const nativeShare = canUseNativeIOSShare();
  const saving = savingSrc === item.src;
  // Which way the last page turn went, so the arriving item slides in from
  // the side it came from — set by the arrows and the keyboard too, not just
  // by the drag, so every route through the gallery reads the same.
  const [direction, setDirection] = useState<-1 | 0 | 1>(0);
  const [commenting, setCommenting] = useState(startCommenting);
  const [selection, setSelection] = useState<ImageRegion | null>(null);
  /** Where that selection sits on screen, reported by the viewer. */
  const [selectionRect, setSelectionRect] = useState<ScreenRect | null>(null);
  const [commentCardSize, setCommentCardSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));
  const [commentText, setCommentText] = useState("");
  const [editingAnnotation, setEditingAnnotation] =
    useState<ImageRegionAnnotation | null>(null);
  const [annotationsByIndex, setAnnotationsByIndex] = useState(() =>
    items.map((entry) => entry.regionAnnotations ?? []),
  );
  const annotations = annotationsByIndex[index] ?? [];
  const [commentError, setCommentError] = useState<string | null>(null);
  const [sendingComment, setSendingComment] = useState(false);
  const sendingCommentRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentCardRef = useRef<HTMLFormElement>(null);
  /** The field is as tall as its own text, between one line and a bar that
   *  would start to cover the picture. Measured from scrollHeight, so it is
   *  the wrapped line count rather than the character count that decides. */
  const fitCommentField = (field: HTMLTextAreaElement) => {
    const min = isPhone ? 44 : 36;
    // Zero, not "auto": a textarea's auto height is its `rows` height, so
    // scrollHeight read against it never falls back below one row and the bar
    // cannot shrink again when the text is deleted.
    field.style.height = "0px";
    field.style.height = `${Math.min(Math.max(field.scrollHeight, min), 132)}px`;
  };
  const effectFitCommentField = useEffectEvent(fitCommentField);
  const reduceMotion = useReducedMotion();
  const resetComment = () => {
    setChromeVisible(true);
    setCommenting(false);
    setSelection(null);
    setSelectionRect(null);
    setCommentCardSize(null);
    setCommentText("");
    setEditingAnnotation(null);
    setCommentError(null);
  };
  const prev = () => {
    setImageZoomed(false);
    resetComment();
    setDirection(-1);
    onIndex((index - 1 + items.length) % items.length);
  };
  const next = () => {
    setImageZoomed(false);
    resetComment();
    setDirection(1);
    onIndex((index + 1) % items.length);
  };
  const go = (i: number) => {
    if (i === index) return;
    setImageZoomed(false);
    resetComment();
    setDirection(i > index ? 1 : -1);
    onIndex(i);
  };
  const requestClose = () => onClose(!imageZoomed);
  // The scrim lifts with a dismissal drag, so what is underneath is already
  // showing through before the finger leaves the glass. Written straight to
  // the element like the drag transform itself: a re-render per pointer move
  // is what this whole surface is built to avoid. A rejected drag restores the
  // scrim over the same quarter-second that returns the picture.
  const dragScrim = (progress: number) => {
    const el = dialogRef.current;
    if (!el) return;
    el.style.transition =
      progress === 0 && !reduceMotion
        ? "background-color 0.24s ease-out"
        : "none";
    el.style.backgroundColor = progress
      ? `rgb(0 0 0 / ${(1 - progress * 0.55).toFixed(3)})`
      : "";
  };
  const togglePhoneChrome = () => {
    if (!isPhone || commenting) return;
    setChromeVisible((visible) => !visible);
  };
  const saveItem = async () => {
    if (saving) return;
    setSavingSrc(item.src);
    await (async () => {
      await saveFileWithNativeShare(
        mediaDownloadHref(item),
        suggestedMediaName(item),
      );
    })()
      .catch(async (error) => {
        if (!nativeShareWasCancelled(error)) toast("Could not save that file");
      })
      .finally(async () => {
        setSavingSrc(null);
      });
  };
  const openItem = async () => {
    await (async () => {
      await shareURL(item.src);
    })().catch(async (error) => {
      if (!nativeShareWasCancelled(error)) toast("Could not share that link");
    });
  };
  const copyImage = () => {
    void copyImageToClipboard(item.src).then(
      () => setCopiedSrc(item.src),
      () => toast("Could not copy that image"),
    );
  };
  const commentable =
    item.kind === "image" &&
    (Boolean(item.onRegionComment) ||
      canCommentOnImageRegion(item.commentSessionId));
  const toggleComment = () => {
    if (commenting) resetComment();
    else {
      setChromeVisible(true);
      setCommenting(true);
      setCommentError(null);
    }
  };
  const sendRegionComment = async (keepOpen = false) => {
    const text = commentText.trim();
    const { commentSessionId, onRegionComment, src } = item;
    if (
      (!commentSessionId && !onRegionComment) ||
      !selection ||
      !text ||
      sendingCommentRef.current
    )
      return;
    sendingCommentRef.current = true;
    setSendingComment(true);
    setCommentError(null);
    await (async () => {
      if (onRegionComment) {
        await onRegionComment({
          region: selection,
          text,
          keepOpen,
          ...(editingAnnotation ? { existing: editingAnnotation } : {}),
        });
        const saved: ImageRegionAnnotation = {
          id: editingAnnotation?.id ?? `local-${Date.now()}`,
          region: selection,
          text,
        };
        setAnnotationsByIndex((all) =>
          all.map((entry, itemIndex) =>
            itemIndex !== index
              ? entry
              : editingAnnotation
                ? entry.map((annotation) =>
                    annotation.id === editingAnnotation.id ? saved : annotation,
                  )
                : [...entry, saved],
          ),
        );
      } else if (commentSessionId) {
        await submitImageRegionComment({
          sessionId: commentSessionId,
          src,
          region: selection,
          text,
        });
      }
      if (keepOpen) {
        setSelection(null);
        setSelectionRect(null);
        setCommentCardSize(null);
        setCommentText("");
        setEditingAnnotation(null);
      } else {
        onClose(false);
      }
    })()
      .catch(async (error) => {
        setCommentError(
          error instanceof Error
            ? error.message
            : "Could not send this comment",
        );
      })
      .finally(async () => {
        sendingCommentRef.current = false;
        setSendingComment(false);
      });
  };

  const editAnnotation = (annotation: ImageRegionAnnotation) => {
    setChromeVisible(true);
    setCommenting(true);
    setEditingAnnotation(annotation);
    setSelection(annotation.region);
    setCommentText(annotation.text);
    setCommentError(null);
  };

  const deleteAnnotation = async (annotation: ImageRegionAnnotation) => {
    if (!item.onDeleteRegionComment || sendingCommentRef.current) return;
    sendingCommentRef.current = true;
    setSendingComment(true);
    setCommentError(null);
    await (async () => {
      await item.onDeleteRegionComment?.(annotation);
      setAnnotationsByIndex((all) =>
        all.map((entry, itemIndex) =>
          itemIndex === index
            ? entry.filter((comment) => comment.id !== annotation.id)
            : entry,
        ),
      );
      if (editingAnnotation?.id === annotation.id) resetComment();
    })()
      .catch(async (error) => {
        toast(
          error instanceof Error
            ? error.message
            : "Could not delete this comment",
          { variant: "error" },
        );
      })
      .finally(async () => {
        sendingCommentRef.current = false;
        setSendingComment(false);
      });
  };

  useEffect(() => {
    if (!copiedSrc) return;
    const t = setTimeout(() => setCopiedSrc(null), 1600);
    return () => clearTimeout(t);
  }, [copiedSrc]);

  // The image fits above the phone bar, whose height changes with captions and
  // the home indicator. Measure the rendered bar instead of assuming one size.
  useLayoutEffect(() => {
    if (!isPhone) return;
    const bar = phoneBottomRef.current;
    if (!bar) return;
    const measure = () => {
      const height = bar.getBoundingClientRect().height;
      setPhoneBottomHeight((current) =>
        Math.abs(current - height) < 0.5 ? current : height,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [isPhone]);

  // Swiping the main image and tapping a thumbnail keep the active still in
  // the middle of the strip. The first positioning is immediate.
  useEffect(() => {
    if (!isPhone) return;
    const changed = filmstripIndexRef.current !== index;
    filmstripIndexRef.current = index;
    filmstripRef.current
      ?.querySelector<HTMLElement>(`[data-lightbox-thumb="${index}"]`)
      ?.scrollIntoView({
        behavior: changed && !reduceMotion ? "smooth" : "auto",
        block: "nearest",
        inline: "center",
      });
  }, [index, isPhone, reduceMotion]);

  // A hidden toolbar must not retain focus. Focus the dialog itself so Enter,
  // Space, or a fresh tap can reveal the controls again.
  useEffect(() => {
    if (!isPhone || chromeVisible) return;
    dialogRef.current?.focus({ preventScroll: true });
  }, [chromeVisible, isPhone]);

  // The card is placed against the selection, so it needs the room it is being
  // placed in. visualViewport rather than innerHeight: an open phone keyboard
  // shrinks the first and not the second, and a card measured against the
  // second would sit under the keys the person is typing on.
  useEffect(() => {
    const measure = () =>
      setViewport((current) => {
        const next = {
          width: window.visualViewport?.width ?? window.innerWidth,
          height: window.visualViewport?.height ?? window.innerHeight,
        };
        return Math.abs(current.width - next.width) < 0.5 &&
          Math.abs(current.height - next.height) < 0.5
          ? current
          : next;
      });
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, []);

  // Its own height decides whether it fits below the region, and that height
  // changes as an error appears or the text wraps.
  useLayoutEffect(() => {
    const el = commentCardRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setCommentCardSize((current) =>
        current &&
        Math.abs(current.width - rect.width) < 0.5 &&
        Math.abs(current.height - rect.height) < 0.5
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // selectionRect too: the card only mounts once the viewer has reported
    // where the region is, which is a render after the selection itself.
  }, [commenting, selection, selectionRect]);

  useEffect(() => {
    // The card mounts one render after the selection, once the viewer has
    // reported its viewport position. Waiting for that position keeps this
    // focus attempt from running while the textarea ref is still null.
    if (!selection || !selectionRect) return;
    const frame = requestAnimationFrame(() => {
      const field = commentInputRef.current;
      if (!field) return;
      // Before focus, so the bar is never one frame taller or shorter than
      // the words already in it.
      effectFitCommentField(field);
      field.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [selection, selectionRect]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    // Focus returns to whatever opened the viewer, but the ring only comes
    // back if it was there to begin with: a mouse click on a session image
    // focuses its wrapping <a> silently, and closing with Escape puts the
    // browser in keyboard modality, so a plain focus() would leave an
    // outline around an image nobody deliberately focused.
    const restore: FocusOptionsWithVisible = {
      preventScroll: true,
      focusVisible: !!previousFocus?.matches?.(":focus-visible"),
    };
    const frame = requestAnimationFrame(() =>
      closeRef.current?.focus({ preventScroll: true }),
    );
    return () => {
      cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) previousFocus.focus(restore);
    };
  }, []);

  // Capture-phase so the arrows/Escape don't also drive whatever is behind
  // the modal (composer, session viewer shortcuts).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const editingText = Boolean(
        target?.matches("input, textarea, [contenteditable='true']"),
      );
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        requestClose();
      } else if (
        !editingText &&
        !e.repeat &&
        commentable &&
        eventChord(e, isApple) === "c"
      ) {
        e.preventDefault();
        e.stopPropagation();
        toggleComment();
      } else if (
        isPhone &&
        !chromeVisible &&
        !editingText &&
        (e.key === "Enter" || e.key === " ")
      ) {
        e.preventDefault();
        e.stopPropagation();
        setChromeVisible(true);
      } else if (!editingText && e.key === "ArrowLeft" && many) {
        e.stopPropagation();
        e.preventDefault();
        prev();
      } else if (!editingText && e.key === "ArrowRight" && many) {
        e.stopPropagation();
        e.preventDefault();
        next();
      } else if (e.key === "Tab") {
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])',
          ) || [],
        ).filter(
          (element) =>
            element.getClientRects().length > 0 && !element.closest("[inert]"),
        );
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (
          e.shiftKey &&
          (active === first || !dialogRef.current?.contains(active))
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (active === last || !dialogRef.current?.contains(active))
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!item) return null;
  // When it was taken, the way the rest of the app says it — "Today at 14:32",
  // "Jul 12 at 09:05" — rather than a raw locale stamp with seconds in it.
  const caption = [item.sessionTitle, item.at ? fullTime(item.at) : null]
    .filter(Boolean)
    .join(" · ");
  const description = item.description?.trim();
  // z-10 keeps the chrome floating above a zoomed image, which is free to
  // spread under it across the whole viewport (z-index applies to flex items
  // without needing position).
  const navBtn = utilityClassName(
    "z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full border-0 bg-white/10 p-0 text-white hover:bg-white/20 phone:h-11 phone:w-11",
  );
  // Wide enough for a sentence, never wider than the screen it floats on.
  const commentCardWidth = Math.min(340, Math.max(220, viewport.width - 24));
  const commentAnchor =
    commenting && selection && selectionRect
      ? anchoredCommentPosition(
          selectionRect,
          { width: commentCardWidth, height: commentCardSize?.height ?? 0 },
          viewport,
        )
      : null;
  const phoneStageInset = chromeVisible || imageZoomed || commenting;
  // Photos keeps the still centered on the screen and floats its chrome over it.
  // Using the full bottom bar as one-sided padding made tall images look pulled
  // upward. Preserve the same fitted size, but share that clearance between the
  // top and bottom so the image's center stays at the viewport's center.
  const phoneStagePadding = (68 + phoneBottomHeight) / 2;
  const phoneAction = utilityClassName(
    "grid size-11 shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 text-white transition-[transform,background-color,opacity] duration-[var(--dur-micro)] ease-[var(--ease)] active:scale-[0.96] disabled:opacity-[0.35]",
  );

  return (
    <motion.div
      ref={dialogRef}
      data-media-lightbox=""
      {...stylex.props(
        sx.fixed,
        sx.inset0,
        sx.z11000,
        sx.flex,
        sx.flexCol,
        sx.bgBlack85,
        sx.phoneH100dvh,
        sx.phoneBgBlack,
      )}
      role="dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-label={LIGHTBOX_PREVIEW_LABEL[item.kind]}
      initial={useHeroTransition ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={useHeroTransition ? { opacity: 1 } : { opacity: 0 }}
      transition={
        useHeroTransition
          ? { duration: 0 }
          : { duration: 0.16, ease: "easeOut" }
      }
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        className={cn(
          utilityClassName(
            "pointer-events-none absolute left-[calc(12px+env(safe-area-inset-left))] right-[calc(12px+env(safe-area-inset-right))] top-[calc(12px+env(safe-area-inset-top))] z-10 flex items-center justify-center",
          ),
          isPhone &&
            utilityClassName(
              "transition-[opacity,transform] duration-[var(--dur)] ease-[var(--ease)] motion-reduce:transition-none",
            ),
          isPhone &&
            !chromeVisible &&
            utilityClassName("-translate-y-2 opacity-0"),
        )}
        inert={isPhone && !chromeVisible ? true : undefined}
        aria-hidden={isPhone && !chromeVisible ? true : undefined}
      >
        {/* Keep the actions on the viewport's centerline while Close owns the
				    right corner. Grouping both at the edge made the row read like loose
				    header controls rather than one action bar. */}
        <div
          role="group"
          aria-label="Media actions"
          className={
            isPhone
              ? utilityClassName("hidden")
              : utilityClassName("pointer-events-auto flex items-center gap-1")
          }
        >
          {commentable && (
            <Button
              variant="overlay"
              size="md"
              icon={<IconMessage size={20} />}
              className={cn(
                LIGHTBOX_ACTION_CLASS,
                commenting && utilityClassName("bg-white/15 text-white"),
              )}
              onClick={toggleComment}
              aria-pressed={commenting}
              aria-keyshortcuts="C"
              aria-label={
                commenting ? "Cancel image comment" : "Comment on image"
              }
            >
              Comment
            </Button>
          )}
          {nativeShare ? (
            <Button
              variant="overlay"
              size="md"
              icon={<IconArrowDown size={20} />}
              className={LIGHTBOX_ACTION_CLASS}
              onClick={saveItem}
              disabled={saving}
              aria-label={saving ? "Preparing download" : "Download"}
            >
              {saving ? "Preparing…" : "Download"}
            </Button>
          ) : (
            <Button
              variant="overlay"
              size="md"
              icon={<IconArrowDown size={20} />}
              className={LIGHTBOX_ACTION_CLASS}
              aria-label="Download"
              render={
                <a
                  href={mediaDownloadHref(item)}
                  download={
                    item.src.startsWith("data:") || item.src.startsWith("blob:")
                      ? suggestedMediaName(item)
                      : undefined
                  }
                />
              }
            >
              Download
            </Button>
          )}
          {!item.src.startsWith("data:") && (
            <>
              {/* The file's own URL: what you paste into an upload, a
							    ticket, or a message to someone who can reach this instance. */}
              <Button
                variant="overlay"
                size="md"
                icon={copied ? <IconCheck size={20} /> : <IconLink size={20} />}
                className={LIGHTBOX_ACTION_CLASS}
                aria-label={copied ? "Link copied" : "Copy link"}
                onClick={() =>
                  copyToClipboard(shareableMediaSrc(item), () =>
                    setCopiedSrc(item.src),
                  )
                }
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
              {nativeShare ? (
                <Button
                  variant="overlay"
                  size="md"
                  icon={<IconArrowUpRight size={20} />}
                  className={LIGHTBOX_ACTION_CLASS}
                  onClick={openItem}
                  aria-label="Open or share"
                >
                  Open or share
                </Button>
              ) : (
                <Button
                  variant="overlay"
                  size="md"
                  icon={<IconArrowUpRight size={20} />}
                  className={LIGHTBOX_ACTION_CLASS}
                  aria-label="Open"
                  render={
                    <a
                      href={item.src}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  Open
                </Button>
              )}
            </>
          )}
        </div>
        <button
          ref={closeRef}
          type="button"
          className={cn(
            navBtn,
            utilityClassName("pointer-events-auto absolute right-0"),
          )}
          onClick={requestClose}
          aria-label="Close"
        >
          <IconX size={22} />
        </button>
      </div>

      <div
        className={cn(
          utilityClassName(
            "flex min-h-0 flex-1 items-center justify-center gap-3 px-3 pb-2 pt-[calc(56px+env(safe-area-inset-top))] sm:px-4",
          ),
          isPhone && utilityClassName("gap-0 px-0"),
        )}
        style={
          isPhone
            ? {
                paddingTop: phoneStageInset ? phoneStagePadding : 0,
                paddingBottom: phoneStageInset ? phoneStagePadding : 0,
                transition: reduceMotion
                  ? "none"
                  : "padding 0.25s cubic-bezier(0.77, 0, 0.175, 1)",
              }
            : undefined
        }
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) requestClose();
        }}
      >
        {many && !isPhone && (
          <button
            type="button"
            className={navBtn}
            onClick={prev}
            aria-label="Previous"
          >
            <IconChevronLeft size={24} />
          </button>
        )}
        <motion.div
          {...stylex.props(
            sx.flex,
            sx.minH0,
            sx.minW0,
            sx.flex1,
            sx.selfStretch,
          )}
          initial={
            useHeroTransition
              ? false
              : { opacity: 0, scale: reduceMotion ? 1 : 0.96 }
          }
          animate={{ opacity: 1, scale: 1 }}
          exit={
            useHeroTransition
              ? { opacity: 1, scale: 1 }
              : { opacity: 0, scale: reduceMotion ? 1 : 0.985 }
          }
          transition={
            useHeroTransition
              ? { duration: 0 }
              : reduceMotion
                ? { duration: 0.14, ease: "easeOut" }
                : { type: "spring", duration: 0.28, bounce: 0 }
          }
        >
          {item.kind !== "video" ? (
            <MediaLightboxViewer
              key={item.src}
              src={item.src}
              diagram={item.diagram}
              onTapBackdrop={isPhone ? togglePhoneChrome : requestClose}
              onTapMedia={
                isPhone && item.kind === "image" && !commenting
                  ? togglePhoneChrome
                  : undefined
              }
              onZoomChange={(zoomed) => {
                setImageZoomed(zoomed);
                if (isPhone && zoomed) setChromeVisible(false);
              }}
              onSwipe={
                many && !commenting
                  ? (d) => (d === 1 ? next() : prev())
                  : undefined
              }
              // Drag down to close, the way every photo viewer on a
              // phone does. The picture has already left its thumbnail
              // behind by then, so it fades out from where the finger
              // dropped it rather than flying back.
              onDismiss={
                isPhone && !commenting ? () => onClose(false) : undefined
              }
              onDragProgress={isPhone ? dragScrim : undefined}
              enterFrom={direction}
              viewTransitionName={heroTransitionName}
              commentMode={commenting}
              selection={selection}
              onSelection={(region) => {
                setSelection(region);
                setCommentError(null);
              }}
              onSelectionRect={setSelectionRect}
              annotations={annotations}
              onEditAnnotation={
                item.onRegionComment ? editAnnotation : undefined
              }
              onDeleteAnnotation={
                item.onDeleteRegionComment ? deleteAnnotation : undefined
              }
            />
          ) : (
            // The video never fills the stage, so the space beside it has to
            // close too. Without this, only the thin strip outside this
            // wrapper was a backdrop and the lightbox felt stuck.
            <div
              {...stylex.props(
                sx.flex,
                sx.minH0,
                sx.minW0,
                sx.flex1,
                sx.itemsCenter,
                sx.justifyCenter,
                sx.selfStretch,
              )}
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) requestClose();
              }}
            >
              <video
                key={item.src}
                src={item.src}
                controls
                autoPlay
                muted
                playsInline
                // Same hairline as the photo: a dark first frame needs
                // an edge against the scrim just as much.
                {...stylex.props(
                  sx.minH0,
                  sx.minW0,
                  sx.maxHFull,
                  sx.maxWFull,
                  sx.rounded2xl,
                  sx.border,
                  sx.borderWhite20,
                )}
              />
            </div>
          )}
        </motion.div>
        {many && !isPhone && (
          <button
            type="button"
            className={navBtn}
            onClick={next}
            aria-label="Next"
          >
            <IconChevronRight size={24} />
          </button>
        )}
      </div>

      {isPhone && (
        <div
          ref={phoneBottomRef}
          className={cn(
            utilityClassName(
              "absolute inset-x-0 bottom-0 z-10 flex flex-col gap-3 bg-linear-to-b from-transparent via-black/85 to-black px-0 pb-[max(14px,env(safe-area-inset-bottom))] pt-8 transition-[opacity,transform] duration-[var(--dur)] ease-[var(--ease)] motion-reduce:transition-none",
            ),
            !chromeVisible &&
              utilityClassName("pointer-events-none translate-y-3 opacity-0"),
          )}
          inert={!chromeVisible ? true : undefined}
          aria-hidden={!chromeVisible ? true : undefined}
        >
          {!commenting && (item.walkthroughLabel || caption || description) && (
            <div
              {...stylex.props(
                sx.flex,
                sx.maxWFull,
                sx.flexCol,
                sx.itemsCenter,
                sx.gap05,
                sx.px6,
                sx.textCenter,
              )}
            >
              <div
                {...stylex.props(
                  sx.flex,
                  sx.maxWFull,
                  sx.itemsCenter,
                  sx.justifyCenter,
                  sx.gap2,
                )}
              >
                {caption && (
                  <div
                    {...stylex.props(
                      sx.lineClamp2,
                      sx.minW0,
                      sx.maxWFull,
                      sx.textSm,
                      sx.fontMedium,
                      sx.leadingSnug,
                      sx.textWhite,
                    )}
                  >
                    {caption}
                  </div>
                )}
                {item.walkthroughLabel && (
                  <span
                    className={cn(
                      WALKTHROUGH_LABEL_CLASS,
                      WALKTHROUGH_LABEL_TONE[item.walkthroughLabel],
                    )}
                  >
                    {WALKTHROUGH_LABEL_TEXT[item.walkthroughLabel]}
                  </span>
                )}
              </div>
              {description && (
                <div
                  {...stylex.props(
                    sx.lineClamp2,
                    sx.maxWFull,
                    sx.textSm,
                    sx.leadingSnug,
                    sx.textWhite75,
                  )}
                >
                  {description}
                </div>
              )}
            </div>
          )}

          {many && (
            <div
              ref={filmstripRef}
              {...mergeStylexProps(
                "snap-x snap-mandatory [&::-webkit-scrollbar]:hidden",
                sx.flex,
                sx.h12,
                sx.itemsCenter,
                sx.gap1,
                sx.overflowXAuto,
                sx.pxCalc5022px,
                sx.ScrollbarWidthNone,
              )}
              role="group"
              aria-label="Media filmstrip"
            >
              {items.map((thumb, thumbIndex) => {
                const active = thumbIndex === index;
                return (
                  <button
                    key={`${thumb.src}-${thumbIndex}`}
                    type="button"
                    data-lightbox-thumb={thumbIndex}
                    {...stylex.props(
                      sx.grid,
                      sx.size11,
                      sx.shrink0,
                      sx.snapCenter,
                      sx.placeItemsCenter,
                      sx.border0,
                      sx.bgTransparent,
                      sx.p0,
                    )}
                    onClick={() => go(thumbIndex)}
                    aria-label={`Show ${thumb.kind} ${thumbIndex + 1} of ${items.length}`}
                    aria-current={active ? "true" : undefined}
                  >
                    <span
                      className={cn(
                        utilityClassName(
                          "block overflow-hidden rounded-sm outline outline-1 outline-offset-1 transition-[width,height,opacity] duration-[var(--dur)] ease-[var(--ease)] motion-reduce:transition-none",
                        ),
                        active
                          ? utilityClassName(
                              "h-11 w-11 opacity-100 outline-white/85",
                            )
                          : utilityClassName(
                              "h-9 w-7 opacity-60 outline-transparent",
                            ),
                      )}
                    >
                      {thumb.kind === "video" ? (
                        <video
                          src={thumb.src}
                          muted
                          playsInline
                          preload="metadata"
                          {...stylex.props(sx.sizeFull, sx.objectCover)}
                        />
                      ) : (
                        <img
                          src={thumb.src}
                          alt=""
                          loading="lazy"
                          {...stylex.props(sx.sizeFull, sx.objectCover)}
                        />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div {...stylex.props(sx.grid, sx.gridCols3, sx.itemsCenter, sx.px5)}>
            <div {...stylex.props(sx.justifySelfStart)}>
              {nativeShare ? (
                <button
                  type="button"
                  className={phoneAction}
                  onClick={saveItem}
                  disabled={saving}
                  aria-label={saving ? "Preparing image" : "Share image"}
                >
                  <IconShare size={21} />
                </button>
              ) : (
                <a
                  href={mediaDownloadHref(item)}
                  download={
                    item.src.startsWith("data:") || item.src.startsWith("blob:")
                      ? suggestedMediaName(item)
                      : undefined
                  }
                  className={phoneAction}
                  aria-label="Download"
                >
                  <IconArrowDown size={21} />
                </a>
              )}
            </div>

            {commentable && (
              <button
                type="button"
                className={cn(
                  phoneAction,
                  utilityClassName("justify-self-center"),
                  commenting && utilityClassName("bg-white/15"),
                )}
                onClick={toggleComment}
                aria-pressed={commenting}
                aria-keyshortcuts="C"
                aria-label={
                  commenting ? "Cancel image comment" : "Comment on image"
                }
              >
                <IconMessage size={21} />
              </button>
            )}

            <button
              type="button"
              className={cn(
                phoneAction,
                utilityClassName("col-start-3 justify-self-end"),
              )}
              onClick={copyImage}
              disabled={item.kind === "video"}
              aria-label={copied ? "Image copied" : "Copy image"}
            >
              {copied ? <IconCheck size={21} /> : <IconCopy size={21} />}
            </button>
          </div>
        </div>
      )}

      {commenting && !selection && (
        <div
          {...stylex.props(
            sx.pointerEventsNone,
            sx.absolute,
            sx.insetX0,
            sx.bottomCalc16pxEnvSafeAreaInsetBottom,
            sx.z20,
            sx.flex,
            sx.justifyCenter,
            sx.px4,
          )}
        >
          <div
            {...mergeStylexProps(
              "shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_12px_44px_rgb(0_0_0/0.5)] backdrop-blur-2xl backdrop-saturate-150",
              sx.pointerEventsAuto,
              sx.flex,
              sx.itemsCenter,
              sx.gap1,
              sx.roundedFull,
              sx.border,
              sx.borderWhite10,
              sx.bgBlack55,
              sx.py1,
              sx.pl4,
              sx.pr1,
            )}
          >
            <span
              {...stylex.props(sx.fontMedium, sx.textWhite, typography.label)}
            >
              Drag over the part you mean
            </span>
            <button
              type="button"
              {...stylex.props(
                sx.minH9,
                sx.roundedFull,
                sx.px3,
                sx.fontMedium,
                sx.textWhite70,
                sx.hoverBgWhite10,
                sx.hoverTextWhite,
                sx.phoneMinH11,
                typography.label,
              )}
              onClick={resetComment}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {commentAnchor && (
        <motion.form
          ref={commentCardRef}
          /* Fixed and placed against the region: the remark and the pixels it
					   is about read as one thing. Kept to a single row, because on a
					   phone a taller card would cover the picture it is describing. */
          {...mergeStylexProps(
            "shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_16px_50px_rgb(0_0_0/0.5)] backdrop-blur-2xl backdrop-saturate-150",
            sx.fixed,
            sx.z20,
            sx.flex,
            sx.cursorText,
            sx.flexCol,
            sx.gap1,
            sx.rounded22px,
            sx.bgBlack55,
            sx.p15,
          )}
          // It grows out of the corner of the region it belongs to, rather
          // than fading in beside it.
          initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", duration: 0.3, bounce: 0.12 }}
          style={{
            left: commentAnchor.left,
            top: commentAnchor.top,
            width: commentCardWidth,
            transformOrigin:
              commentAnchor.placement === "above" ? "bottom left" : "top left",
            // One frame of measurement before it knows which side of the
            // region it fits on. Showing it first would place it, then move it.
            visibility: commentCardSize ? undefined : "hidden",
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void sendRegionComment();
          }}
          // The whole bar is the field, the way a text input is: pressing
          // the padding beside the words puts the caret in them rather than
          // doing nothing. The buttons keep their own presses.
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button, textarea"))
              return;
            event.preventDefault();
            commentInputRef.current?.focus({ preventScroll: true });
          }}
        >
          <div {...stylex.props(sx.flex, sx.itemsEnd, sx.gap1)}>
            <textarea
              ref={commentInputRef}
              value={commentText}
              onChange={(event) => {
                setCommentText(event.target.value);
                fitCommentField(event.target);
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (!event.shiftKey || Boolean(item.onRegionComment)) &&
                  !event.nativeEvent.isComposing &&
                  window.matchMedia("(hover: hover) and (pointer: fine)")
                    .matches
                ) {
                  event.preventDefault();
                  void sendRegionComment(
                    event.shiftKey && Boolean(item.onRegionComment),
                  );
                }
              }}
              rows={1}
              placeholder="What should change here?"
              // No surface of its own: the bar behind it is the input.
              // border-0 explicitly, because this app leaves the browser's
              // own control styling in place rather than importing a
              // preflight, and a bare textarea draws a grey 1px frame.
              // A long remark grows the bar rather than scrolling inside
              // one line, up to the point where it would start covering
              // the picture it is about.
              {...mergeStylexProps(
                "[&::-webkit-scrollbar]:hidden",
                sx.block,
                sx.wFull,
                sx.flex1,
                sx.resizeNone,
                sx.appearanceNone,
                sx.border0,
                sx.bgTransparent,
                sx.px25,
                sx.py2,
                sx.leadingSnug,
                sx.textWhite,
                sx.outlineNone,
                sx.ScrollbarWidthNone,
                sx.placeholderTextWhite45,
                sx.phoneTextInputPhone,
                typography.body,
              )}
              disabled={sendingComment}
            />
            <button
              type="button"
              {...stylex.props(
                sx.grid,
                sx.size9,
                sx.shrink0,
                sx.placeItemsCenter,
                sx.roundedFull,
                sx.border0,
                sx.bgTransparent,
                sx.p0,
                sx.textWhite60,
                sx.hoverBgWhite10,
                sx.hoverTextWhite,
                sx.phoneSize11,
              )}
              onClick={resetComment}
              disabled={sendingComment}
              aria-label="Cancel comment"
            >
              <IconX size={16} />
            </button>
            <button
              type="submit"
              // The filled circle a message is sent with, in the app's own
              // accent rather than a plain white chip.
              {...stylex.props(
                sx.grid,
                sx.size9,
                sx.shrink0,
                sx.placeItemsCenter,
                sx.roundedFull,
                sx.border0,
                sx.bgAccent,
                sx.p0,
                sx.textWhite,
                sx.transitionTransform,
                sx.activeScale096,
                sx.disabledBgWhite15,
                sx.disabledTextWhite40,
                sx.phoneSize11,
              )}
              disabled={!commentText.trim() || sendingComment}
              aria-label={sendingComment ? "Sending comment" : "Send comment"}
            >
              <IconArrowUp size={17} />
            </button>
          </div>
          {commentError && (
            <div
              {...stylex.props(sx.px25, sx.pb1, sx.textRed, typography.label)}
              role="alert"
            >
              {commentError}
            </div>
          )}
        </motion.form>
      )}

      {/* What you are looking at gets its own line directly under the
			    picture, in plain white. Actions live above with Close, so a
			    "Before"/"After" label cannot read as another link. */}
      {!isPhone && (
        <div
          className={cn(
            utilityClassName(
              "z-10 flex flex-col items-center gap-1.5 px-4 pb-4 pt-4",
            ),
            (commenting ||
              (!item.walkthroughLabel && !caption && !description && !many)) &&
              utilityClassName("hidden"),
          )}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) requestClose();
          }}
        >
          {(item.walkthroughLabel || caption || description) && (
            <div
              {...stylex.props(
                sx.flex,
                sx.maxWFull,
                sx.flexCol,
                sx.itemsCenter,
                sx.gap05,
                sx.textCenter,
              )}
            >
              <div
                {...stylex.props(
                  sx.flex,
                  sx.maxWFull,
                  sx.itemsCenter,
                  sx.justifyCenter,
                  sx.gap2,
                )}
              >
                {caption && (
                  <div
                    {...stylex.props(
                      sx.minW0,
                      sx.maxWFull,
                      sx.truncate,
                      sx.textSm,
                      sx.fontMedium,
                      sx.textWhite,
                    )}
                  >
                    {caption}
                  </div>
                )}
                {item.walkthroughLabel && (
                  <span
                    className={cn(
                      WALKTHROUGH_LABEL_CLASS,
                      WALKTHROUGH_LABEL_TONE[item.walkthroughLabel],
                    )}
                  >
                    {WALKTHROUGH_LABEL_TEXT[item.walkthroughLabel]}
                  </span>
                )}
              </div>
              {description && (
                <div
                  {...stylex.props(
                    sx.maxWMin720px90vw,
                    sx.lineClamp2,
                    sx.textSm,
                    sx.leadingSnug,
                    sx.textWhite75,
                  )}
                >
                  {description}
                </div>
              )}
            </div>
          )}
          <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap15)}>
            {many && (
              // Dots provide direct jumps; the counter beside them gives the
              // exact position without making the reader count circles.
              <div {...stylex.props(sx.flex, sx.itemsCenter)}>
                {dotIndexes.map((dot, position) => (
                  <button
                    key={`${dot}-${items[dot].src}`}
                    type="button"
                    onClick={() => go(dot)}
                    aria-label={`Show ${dot + 1} of ${items.length}`}
                    aria-current={dot === index ? "true" : undefined}
                    {...mergeStylexProps(
                      "group",
                      sx.shrink0,
                      sx.cursorPointer,
                      sx.border0,
                      sx.bgTransparent,
                      sx.p1,
                      sx.leadingNone,
                    )}
                  >
                    <span
                      className={cn(
                        utilityClassName(
                          "block size-1.5 rounded-full transition-[scale,background-color]",
                        ),
                        ((position === 0 && dotStart > 0) ||
                          (position === dotIndexes.length - 1 &&
                            dotStart + dotIndexes.length < items.length)) &&
                          utilityClassName("scale-[0.67]"),
                        dot === index
                          ? utilityClassName("bg-white")
                          : utilityClassName(
                              "bg-white/30 group-hover:bg-white/60",
                            ),
                      )}
                    />
                  </button>
                ))}
              </div>
            )}
            {many && (
              <span
                {...mergeStylexProps(
                  "tabular-nums",
                  sx.fontMedium,
                  sx.textWhite50,
                  typography.meta,
                )}
              >
                {index + 1} of {items.length}
              </span>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}
