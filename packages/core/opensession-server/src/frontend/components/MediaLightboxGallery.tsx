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
import { diagramCanvasColor } from "../lib/diagram-media";
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
import { Menu, MENU_ICON } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
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
  LIGHTBOX_COMPOSER_SELECTOR,
  LIGHTBOX_PREVIEW_LABEL,
  LIGHTBOX_ROUND_BUTTON_CLASS,
  LIGHTBOX_SCRIM_CLASS,
  LIGHTBOX_TOOL_CLASS,
  LIGHTBOX_TOOLBAR_CLASS,
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

/** Desktop's actions: plain icons, named by their tooltips. */
const LIGHTBOX_ICON_TOOL_CLASS =
  "size-10 rounded-full text-fg/70 hover:text-fg aria-pressed:bg-hover aria-pressed:text-fg";

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
  const [imageZoomed, setImageZoomed] = useState(false);
  // Which file the copy receipt belongs to, so a page turn shows the fresh
  // "Copy link" for the item now on screen rather than a stale "Copied".
  const [copiedSrc, setCopiedSrc] = useState<string | null>(null);
  const copied = !!item && copiedSrc === item.src;
  const [copiedImageSrc, setCopiedImageSrc] = useState<string | null>(null);
  const copiedImage = !!item && copiedImageSrc === item.src;
  // The session input stays usable over a desktop viewer: the picture and
  // its tools fit above it, centred on its column, and the scrim leaves it
  // lit (LIGHTBOX_COMPOSER_SELECTOR). Null where the page has no input.
  const [composerBox, setComposerBox] = useState<{
    top: number;
    centerX: number;
  } | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
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
  const scrimRef = useRef<HTMLDivElement>(null);
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
    const el = scrimRef.current;
    if (!el) return;
    el.style.transition =
      progress === 0 && !reduceMotion ? "opacity 0.24s ease-out" : "none";
    el.style.opacity = progress ? (1 - progress * 0.55).toFixed(3) : "";
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
    const background =
      item.kind === "diagram" ? diagramCanvasColor() : undefined;
    void copyImageToClipboard(item.src, { background }).then(
      () => setCopiedImageSrc(item.src),
      () => toast("Could not copy that image"),
    );
  };
  const copyLink = () =>
    copyToClipboard(shareableMediaSrc(item), () => setCopiedSrc(item.src));
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
        const request: Parameters<
          NonNullable<LightboxItem["onRegionComment"]>
        >[0] = {
          region: selection,
          text,
          keepOpen,
        };
        if (editingAnnotation) request.existing = editingAnnotation;
        await onRegionComment(request);
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
    if (!copiedSrc && !copiedImageSrc) return;
    const t = setTimeout(() => {
      setCopiedSrc(null);
      setCopiedImageSrc(null);
    }, 1600);
    return () => clearTimeout(t);
  }, [copiedSrc, copiedImageSrc]);

  useLayoutEffect(() => {
    if (isPhone) return;
    const composer = Array.from(
      document.querySelectorAll<HTMLElement>(LIGHTBOX_COMPOSER_SELECTOR),
    ).find((element) => element.getClientRects().length > 0);
    if (!composer) return;
    composerRef.current = composer;
    const root = document.documentElement;
    root.dataset.lightboxComposer = "";
    const measure = () => {
      const rect = composer.getBoundingClientRect();
      const next = { top: rect.top, centerX: rect.left + rect.width / 2 };
      setComposerBox((current) =>
        current &&
        Math.abs(current.top - next.top) < 0.5 &&
        Math.abs(current.centerX - next.centerX) < 0.5
          ? current
          : next,
      );
    };
    measure();
    // The input grows upward as a draft wraps, and the window can reflow it.
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      delete root.dataset.lightboxComposer;
      composerRef.current = null;
      setComposerBox(null);
    };
  }, [isPhone]);

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
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
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
      // Typing in the input is where the person went next: leave them there.
      if (composerRef.current?.contains(document.activeElement)) return;
      if (previousFocus?.isConnected) previousFocus.focus(restore);
    };
  }, []);

  // Capture-phase so the arrows/Escape don't also drive whatever is behind
  // the modal (composer, session viewer shortcuts).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const editingText = Boolean(
        target?.matches("input, textarea, [contenteditable='true']"),
      );
      // A diagram's right-click menu sits over the viewer and takes its
      // own keys: Escape there closes the menu, not the viewer.
      // The input's own suggestion list takes its keys the same way.
      if (target?.closest('[role="menu"], [role="listbox"]')) return;
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
        // The input kept above the scrim is part of the viewer for Tab.
        const focusable = [dialogRef.current, composerRef.current]
          .flatMap((scope) =>
            Array.from(
              scope?.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), video[controls], [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
              ) || [],
            ),
          )
          .filter(
            (element) =>
              element.getClientRects().length > 0 &&
              !element.closest("[inert]"),
          );
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const active = document.activeElement;
        // Composer owns Tab while its field is focused (a prediction takes
        // it); its own buttons still wrap back here at the end.
        if (editingText && composerRef.current?.contains(active)) return;
        // Stepped by hand: the dialog and the input are not neighbours in the
        // document, so the browser's own order would leave between them.
        const at = focusable.findIndex((element) => element === active);
        e.preventDefault();
        const step = e.shiftKey ? -1 : 1;
        const nextIndex =
          at === -1
            ? e.shiftKey
              ? focusable.length - 1
              : 0
            : (at + step + focusable.length) % focusable.length;
        focusable[nextIndex].focus();
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
  // Desktop centres the picture and its tools on the input's column rather
  // than the window, so the three stay in line when the sidebars push the
  // input off centre. The shift is paid as extra padding on the far side.
  const columnShift =
    !isPhone && composerBox ? composerBox.centerX - viewport.width / 2 : 0;
  const columnPadding = !isPhone
    ? {
        paddingLeft: 16 + Math.max(0, 2 * columnShift),
        paddingRight: 16 + Math.max(0, -2 * columnShift),
      }
    : undefined;
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
  const phoneAction =
    "grid size-11 shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 text-fg transition-[transform,background-color,opacity] duration-[var(--dur-micro)] ease-[var(--ease)] active:scale-[0.96] disabled:opacity-[0.35]";

  const canCopyImage = item.kind !== "video";
  const canCopyLink = !item.src.startsWith("data:");
  const copiedAny = copied || copiedImage;
  const downloadName =
    item.src.startsWith("data:") || item.src.startsWith("blob:")
      ? suggestedMediaName(item)
      : undefined;
  // Desktop's actions: centred in the top bar over the picture they act on,
  // so the bottom of the viewer is free for the description and filmstrip.
  const tool = (
    label: string,
    icon: React.ReactNode,
    props: Omit<React.ComponentProps<typeof Button>, "icon" | "variant">,
  ) => (
    <Tooltip label={label} side="bottom">
      <Button
        variant="ghost"
        icon={icon}
        className={LIGHTBOX_ICON_TOOL_CLASS}
        {...props}
      />
    </Tooltip>
  );
  const tools = (
    <div
      role="group"
      aria-label="Media actions"
      className="pointer-events-auto flex items-center gap-0.5"
    >
      {commentable &&
        tool(
          commenting ? "Cancel comment" : "Comment",
          <IconMessage size={20} />,
          {
            onClick: toggleComment,
            "aria-pressed": commenting,
            "aria-keyshortcuts": "C",
            "aria-label": commenting
              ? "Cancel image comment"
              : "Comment on image",
          },
        )}
      {/* One Copy for both things a picture can be copied as: its pixels
          for a paste into a document, its URL for a ticket or a message. */}
      {canCopyImage && canCopyLink ? (
        <Menu.Root>
          <Tooltip label={copiedAny ? "Copied" : "Copy"} side="bottom">
            <Menu.Trigger
              render={
                <Button
                  variant="ghost"
                  icon={
                    copiedAny ? <IconCheck size={20} /> : <IconCopy size={20} />
                  }
                  className={cn(
                    LIGHTBOX_ICON_TOOL_CLASS,
                    "data-[popup-open]:bg-hover data-[popup-open]:text-fg",
                  )}
                  aria-label={copiedAny ? "Copied" : "Copy"}
                />
              }
            />
          </Tooltip>
          <Menu.Popup side="bottom" align="center" sideOffset={6}>
            <Menu.Item onClick={copyImage}>
              <IconCopy size={18} className={MENU_ICON} />
              Copy image
            </Menu.Item>
            <Menu.Item onClick={copyLink}>
              <IconLink size={18} className={MENU_ICON} />
              Copy link
            </Menu.Item>
          </Menu.Popup>
        </Menu.Root>
      ) : canCopyImage ? (
        tool(
          copiedImage ? "Copied" : "Copy image",
          copiedImage ? <IconCheck size={20} /> : <IconCopy size={20} />,
          {
            onClick: copyImage,
            "aria-label": copiedImage ? "Image copied" : "Copy image",
          },
        )
      ) : canCopyLink ? (
        tool(
          copied ? "Copied" : "Copy link",
          copied ? <IconCheck size={20} /> : <IconLink size={20} />,
          {
            onClick: copyLink,
            "aria-label": copied ? "Link copied" : "Copy link",
          },
        )
      ) : null}
      {nativeShare
        ? tool(
            saving ? "Preparing…" : "Download",
            <IconArrowDown size={20} />,
            {
              onClick: saveItem,
              disabled: saving,
              "aria-label": saving ? "Preparing download" : "Download",
            },
          )
        : tool("Download", <IconArrowDown size={20} />, {
            "aria-label": "Download",
            render: (
              <a href={mediaDownloadHref(item)} download={downloadName} />
            ),
          })}
      {!item.src.startsWith("data:") &&
        (nativeShare
          ? tool("Open or share", <IconArrowUpRight size={20} />, {
              onClick: openItem,
              "aria-label": "Open or share",
            })
          : tool("Open", <IconArrowUpRight size={20} />, {
              "aria-label": "Open",
              render: (
                <a href={item.src} target="_blank" rel="noopener noreferrer" />
              ),
            }))}
    </div>
  );
  // The other pictures in the set, the current one centred and full size.
  // The phone keeps it above its actions; desktop has it under the picture.
  const filmstrip = (
    <div
      ref={filmstripRef}
      className="flex h-12 w-full max-w-2xl snap-x snap-mandatory items-center gap-1 overflow-x-auto px-[calc(50%_-_22px)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
            className="grid size-11 shrink-0 snap-center place-items-center border-0 bg-transparent p-0"
            onClick={() => go(thumbIndex)}
            aria-label={`Show ${thumb.kind} ${thumbIndex + 1} of ${items.length}`}
            aria-current={active ? "true" : undefined}
          >
            <span
              className={cn(
                "block overflow-hidden rounded-sm outline outline-1 outline-offset-1 transition-[width,height,opacity] duration-[var(--dur)] ease-[var(--ease)] motion-reduce:transition-none",
                active
                  ? "h-11 w-11 opacity-100 outline-fg/85"
                  : "h-9 w-7 opacity-60 outline-transparent hover:opacity-90",
              )}
            >
              {thumb.kind === "video" ? (
                <video
                  src={thumb.src}
                  muted
                  playsInline
                  preload="metadata"
                  className="size-full object-cover"
                />
              ) : (
                <img
                  src={thumb.src}
                  alt=""
                  loading="lazy"
                  className="size-full object-cover"
                />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );

  // Comment mode swaps the tools for its one instruction until a region is
  // drawn; the card beside the region takes over from there.
  const commentHint =
    commenting && !selection ? (
      <div className={cn(LIGHTBOX_TOOLBAR_CLASS, "gap-1 py-1 pl-4 pr-1")}>
        <span className="text-label font-medium">
          Drag over the part you mean
        </span>
        <Button
          variant="ghost"
          className={cn(LIGHTBOX_TOOL_CLASS, "phone:min-h-11")}
          onClick={resetComment}
        >
          Cancel
        </Button>
      </div>
    ) : null;

  return (
    <motion.div
      ref={dialogRef}
      data-media-lightbox=""
      className="fixed inset-0 z-[11000] flex flex-col phone:h-[100dvh]"
      role="dialog"
      tabIndex={-1}
      // Not modal while the session input stays usable beside it.
      aria-modal={composerBox ? undefined : "true"}
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
      <div ref={scrimRef} className={LIGHTBOX_SCRIM_CLASS} aria-hidden />
      <div
        className={cn(
          "pointer-events-none absolute left-[calc(16px+env(safe-area-inset-left))] [html.wco_&]:left-[max(16px,calc(env(titlebar-area-x,78px)+8px))] right-[calc(12px+env(safe-area-inset-right))] top-[calc(12px+env(safe-area-inset-top))] z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3",
          isPhone &&
            "transition-[opacity,transform] duration-[var(--dur)] ease-[var(--ease)] motion-reduce:transition-none",
          isPhone && !chromeVisible && "-translate-y-2 opacity-0",
        )}
        inert={isPhone && !chromeVisible ? true : undefined}
        aria-hidden={isPhone && !chromeVisible ? true : undefined}
      >
        {/* Where it came from, quietly in the corner. What it shows is
            described under the picture itself. */}
        <div className="flex min-w-0 items-baseline gap-2">
          {!isPhone && caption && (
            <div className="min-w-0 truncate text-sm font-medium text-fg">
              {caption}
            </div>
          )}
          {many && !isPhone && (
            <span className="shrink-0 text-meta font-medium tabular-nums text-dim">
              {index + 1} of {items.length}
            </span>
          )}
        </div>
        {/* Over the picture's column rather than the window's middle: the
            margin is the same shift the stage pays as padding. */}
        <div
          style={
            !isPhone
              ? {
                  marginLeft: Math.max(0, 2 * columnShift),
                  marginRight: Math.max(0, -2 * columnShift),
                }
              : undefined
          }
        >
          {!isPhone && tools}
        </div>
        <div className="flex min-w-0 items-center justify-self-end gap-2">
          <Button
            ref={closeRef}
            variant="default"
            icon={<IconX size={20} />}
            className={cn(LIGHTBOX_ROUND_BUTTON_CLASS, "pointer-events-auto")}
            onClick={requestClose}
            aria-label="Close"
          />
        </div>
      </div>

      <div
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center gap-3 pb-3 pt-[calc(64px+env(safe-area-inset-top))]",
          isPhone && "gap-0 px-0",
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
            : columnPadding
        }
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) requestClose();
        }}
      >
        {many && !isPhone && (
          <Button
            variant="default"
            icon={<IconChevronLeft size={22} />}
            className={LIGHTBOX_ROUND_BUTTON_CLASS}
            onClick={prev}
            aria-label="Previous"
          />
        )}
        <motion.div
          className="flex min-h-0 min-w-0 flex-1 self-stretch"
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
              className="flex min-h-0 min-w-0 flex-1 items-center justify-center self-stretch"
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
                className="min-h-0 min-w-0 max-h-full max-w-full rounded-2xl border border-line smooth-shadow-md"
              />
            </div>
          )}
        </motion.div>
        {many && !isPhone && (
          <Button
            variant="default"
            icon={<IconChevronRight size={22} />}
            className={LIGHTBOX_ROUND_BUTTON_CLASS}
            onClick={next}
            aria-label="Next"
          />
        )}
      </div>

      {isPhone && (
        <div
          ref={phoneBottomRef}
          className={cn(
            "absolute inset-x-0 bottom-0 z-10 flex flex-col gap-3 bg-linear-to-b from-transparent via-bg/85 to-bg px-0 pb-[max(14px,env(safe-area-inset-bottom))] pt-8 transition-[opacity,transform] duration-[var(--dur)] ease-[var(--ease)] motion-reduce:transition-none",
            !chromeVisible && "pointer-events-none translate-y-3 opacity-0",
          )}
          inert={!chromeVisible ? true : undefined}
          aria-hidden={!chromeVisible ? true : undefined}
        >
          {!commenting && (item.walkthroughLabel || caption || description) && (
            <div className="flex max-w-full flex-col items-center gap-0.5 px-6 text-center">
              <div className="flex max-w-full items-center justify-center gap-2">
                {caption && (
                  <div className="line-clamp-2 min-w-0 max-w-full text-sm font-medium leading-snug text-fg">
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
                <div className="line-clamp-2 max-w-full text-sm leading-snug text-dim">
                  {description}
                </div>
              )}
            </div>
          )}

          {many && filmstrip}

          <div className="grid grid-cols-3 items-center px-5">
            <div className="justify-self-start">
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
                  download={downloadName}
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
                  "justify-self-center",
                  commenting && "bg-fg/10",
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
              className={cn(phoneAction, "col-start-3 justify-self-end")}
              onClick={copyImage}
              disabled={item.kind === "video"}
              aria-label={copiedImage ? "Image copied" : "Copy image"}
            >
              {copiedImage ? <IconCheck size={21} /> : <IconCopy size={21} />}
            </button>
          </div>
        </div>
      )}

      {isPhone && commentHint && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(16px+env(safe-area-inset-bottom))] z-20 flex justify-center px-4">
          {commentHint}
        </div>
      )}

      {commentAnchor && (
        <motion.form
          ref={commentCardRef}
          /* Fixed and placed against the region: the remark and the pixels it
					   is about read as one thing. Kept to a single row, because on a
					   phone a taller card would cover the picture it is describing. */
          className="fixed z-20 flex cursor-text flex-col gap-1 rounded-[22px] bg-black/55 p-1.5 shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_16px_50px_rgb(0_0_0/0.5)] backdrop-blur-2xl backdrop-saturate-150"
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
            if (
              event.target instanceof HTMLElement &&
              event.target.closest("button, textarea")
            )
              return;
            event.preventDefault();
            commentInputRef.current?.focus({ preventScroll: true });
          }}
        >
          <div className="flex items-end gap-1">
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
              className="block w-full flex-1 resize-none appearance-none border-0 bg-transparent px-2.5 py-2 text-body leading-snug text-white outline-none [scrollbar-width:none] placeholder:text-white/45 phone:text-input-phone [&::-webkit-scrollbar]:hidden"
              disabled={sendingComment}
            />
            <button
              type="button"
              className="grid size-9 shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 text-white/60 hover:bg-white/10 hover:text-white phone:size-11"
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
              className="grid size-9 shrink-0 place-items-center rounded-full border-0 bg-accent p-0 text-white transition-transform active:scale-[0.96] disabled:bg-white/15 disabled:text-white/40 phone:size-11"
              disabled={!commentText.trim() || sendingComment}
              aria-label={sendingComment ? "Sending comment" : "Send comment"}
            >
              <IconArrowUp size={17} />
            </button>
          </div>
          {commentError && (
            <div className="px-2.5 pb-1 text-label text-red" role="alert">
              {commentError}
            </div>
          )}
        </motion.form>
      )}

      {!isPhone && (
        <div
          className="z-10 flex shrink-0 justify-center"
          style={{
            ...columnPadding,
            // Rests just above the input, or on the window's edge without one.
            paddingBottom: composerBox
              ? Math.max(16, viewport.height - composerBox.top + 16)
              : 20,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) requestClose();
          }}
        >
          <div className="flex w-full max-w-2xl min-w-0 flex-col items-center gap-3">
            {/* What the picture shows, read straight under it. Before or
                After names the picture too, so it leads the line. */}
            {!commenting && (item.walkthroughLabel || description) && (
              <div className="flex max-w-full flex-col items-center gap-1.5 px-4 text-center">
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
                {description && (
                  <p className="m-0 line-clamp-3 max-w-full text-sm leading-snug text-dim">
                    {description}
                  </p>
                )}
              </div>
            )}
            {commentHint ?? (many ? filmstrip : null)}
          </div>
        </div>
      )}
    </motion.div>
  );
}
