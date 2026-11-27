/**
 * One scratch asset: how it renders, what you can do to it, and the overlay
 * that lifts it over the conversation.
 *
 * A file an agent wrote is reachable from three places — the chip on the turn
 * that wrote it, the Info panel's list, and the Assets tab — and all three use
 * this preview and action vocabulary, so the file behaves consistently.
 *
 * The overlay is the default way in: an artifact is something you glance at
 * mid-conversation, and an overlay costs nothing to dismiss. The Assets tab
 * stays for when you mean to sit with it — Open in the action bar is the
 * promotion, and the way into the folder around the file.
 */

import React, { useEffect, useRef, useState, type Ref } from "react";
import {
  deleteSessionAssetApi,
  sessionAssetDownloadUrl,
  sessionAssetPreviewUrl,
  sessionAssetRawUrl,
  type SessionAssetFile,
} from "../lib/api";
import {
  ASSET_TEXT_CAP,
  adjacentAssetPath,
  assetFileFor,
  assetPreviewKind,
  formatAssetSize,
} from "../lib/asset-preview";
import {
  parseNewSessionLink,
  type NewSessionPrefill,
} from "../lib/new-session-link";
import {
  canUseNativeIOSShare,
  nativeShareWasCancelled,
  saveFileWithNativeShare,
  shareURL,
} from "../lib/native-file-save";
import { absoluteLink, copyToClipboard } from "../lib/share-link";
import { useIsPhone } from "../hooks/useIsPhone";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Menu } from "../ui/menu";
import { ResponsiveDialog } from "../ui/sheet";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { MarkdownBody } from "./MarkdownBody";
import { renderMarkdown } from "../lib/markdown";
import { openLightbox } from "../lib/media-lightbox";
import { canAnnotateAsset } from "../lib/asset-annotation";
import { AssetAnnotationLayer } from "./AssetAnnotationLayer";
import {
  IconArrowDown,
  IconArrowUpRight,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDotsHorizontal,
  IconLink,
  IconMessage,
  IconRefresh,
  IconTrash,
  IconX,
} from "./icons";

type AssetNavigation = {
  index: number;
  count: number;
  onPrevious: () => void;
  onNext: () => void;
  onSelect: (index: number) => void;
};

function AssetPager({
  navigation,
  arrows = false,
  onDark = false,
}: {
  navigation: AssetNavigation;
  arrows?: boolean;
  /** Desktop overlays sit directly on the dimmed backdrop, like the media lightbox. */
  onDark?: boolean;
}) {
  const { index, count, onPrevious, onNext, onSelect } = navigation;
  const positionLabel = `Asset ${index + 1} of ${count}`;
  return (
    <nav
      aria-label="Asset navigation"
      className="flex min-h-7 shrink-0 items-center justify-center gap-1"
    >
      {arrows && (
        <Tooltip label="Previous asset (Left arrow)">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconChevronLeft size={16} />}
            aria-label="Previous asset"
            className={cn(
              "size-9",
              onDark && "text-white/60 hover:bg-white/15 hover:text-white",
            )}
            onClick={onPrevious}
          />
        </Tooltip>
      )}
      <div
        aria-label={positionLabel}
        title={positionLabel}
        className="flex min-w-10 items-center justify-center px-1"
      >
        {count <= 10 ? (
          Array.from({ length: count }, (_, dot) => (
            <button
              key={dot}
              type="button"
              onClick={() => onSelect(dot)}
              aria-label={`Show ${dot + 1} of ${count}`}
              aria-current={dot === index ? "true" : undefined}
              className="group shrink-0 cursor-pointer border-0 bg-transparent p-1 leading-none"
            >
              <span
                className={cn(
                  "block size-1.5 rounded-full transition-colors",
                  dot === index
                    ? onDark
                      ? "bg-white"
                      : "bg-fg"
                    : onDark
                      ? "bg-white/35 group-hover:bg-white/70"
                      : "bg-line-strong group-hover:bg-dim",
                )}
              />
            </button>
          ))
        ) : (
          <span
            role="status"
            className={cn(
              "px-1 text-meta tabular-nums",
              onDark ? "text-white/60" : "text-faint",
            )}
          >
            {index + 1} / {count}
          </span>
        )}
      </div>
      {arrows && (
        <Tooltip label="Next asset (Right arrow)">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconChevronRight size={16} />}
            aria-label="Next asset"
            className={cn(
              "size-9",
              onDark && "text-white/60 hover:bg-white/15 hover:text-white",
            )}
            onClick={onNext}
          />
        </Tooltip>
      )}
    </nav>
  );
}

function AssetSideButton({
  direction,
  onClick,
}: {
  direction: "previous" | "next";
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous asset" : "Next asset";
  return (
    <Tooltip label={`${label} (${previous ? "Left" : "Right"} arrow)`}>
      <Button
        variant="default"
        size="lg"
        icon={
          previous ? (
            <IconChevronLeft size={22} />
          ) : (
            <IconChevronRight size={22} />
          )
        }
        aria-label={label}
        className={cn(
          "absolute top-1/2 z-20 size-10 -translate-y-1/2 rounded-full bg-raised smooth-shadow-sm",
          previous ? "right-full mr-3" : "left-full ml-3",
        )}
        onClick={onClick}
      />
    </Tooltip>
  );
}

function AssetMenu({
  sessionId,
  file,
  refresh,
  onClose,
  phone = false,
  deleteOnly = false,
  bar = false,
}: {
  sessionId: string;
  file: SessionAssetFile;
  refresh?: () => void;
  onClose?: () => void;
  phone?: boolean;
  /** The overlay exposes its safe actions directly and keeps only Delete here. */
  deleteOnly?: boolean;
  /** Match the overlay's centered action-bar controls. */
  bar?: boolean;
}) {
  const rawUrl = sessionAssetPreviewUrl(sessionId, file);
  const stableUrl = sessionAssetRawUrl(sessionId, file.path);
  const nativeShare = canUseNativeIOSShare();
  const name = file.path.split("/").pop() || "asset";

  async function onDownload() {
    await (async () => {
      await saveFileWithNativeShare(
        sessionAssetDownloadUrl(sessionId, file),
        name,
      );
    })().catch(async (error) => {
      if (!nativeShareWasCancelled(error)) toast("Could not save that file");
    });
  }

  async function onOpen() {
    await (async () => {
      await shareURL(rawUrl);
    })().catch(async (error) => {
      if (!nativeShareWasCancelled(error)) toast("Could not share that link");
    });
  }

  async function onDelete() {
    if (!confirm(`Delete ${file.path}?`)) return;
    await (async () => {
      await deleteSessionAssetApi(sessionId, file.path);
      refresh?.();
      onClose?.();
    })().catch(async () => {
      toast("Could not delete that file");
    });
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={deleteOnly ? "More asset actions" : "Asset actions"}
        className={cn(
          "flex shrink-0 items-center justify-center border-0",
          bar
            ? cn(
                "size-10 rounded-full bg-transparent transition-[transform,background-color,color] active:scale-[0.96] phone:size-11",
                phone
                  ? "text-white/55 hover:bg-white/10 hover:text-white/80 data-[popup-open]:bg-white/10 data-[popup-open]:text-white/80"
                  : "text-white/60 hover:bg-white/15 hover:text-white data-[popup-open]:bg-white/15 data-[popup-open]:text-white",
              )
            : phone
              ? "size-11 rounded-full bg-panel text-dim active:bg-pressed data-[popup-open]:bg-pressed data-[popup-open]:text-fg"
              : "size-7 rounded-control bg-transparent text-dim hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg",
        )}
      >
        <IconDotsHorizontal size={phone ? 24 : 16} />
      </Menu.Trigger>
      <Menu.Popup align="end">
        {!deleteOnly && (
          <>
            <Menu.Item
              {...(nativeShare
                ? { onClick: onDownload }
                : {
                    render: (
                      <a href={sessionAssetDownloadUrl(sessionId, file)} />
                    ),
                  })}
            >
              <IconArrowDown size={18} className="text-faint" />
              Download
            </Menu.Item>
            <Menu.Item
              {...(nativeShare
                ? { onClick: onOpen }
                : {
                    render: (
                      <a href={rawUrl} target="_blank" rel="noreferrer" />
                    ),
                  })}
            >
              <IconArrowUpRight size={18} className="text-faint" />
              {nativeShare ? "Open or share" : "Open in a browser tab"}
            </Menu.Item>
            <Menu.Item
              onClick={() =>
                copyToClipboard(absoluteLink(stableUrl), () =>
                  toast("Link copied"),
                )
              }
            >
              <IconCopy size={18} className="text-faint" />
              Copy link
            </Menu.Item>
            {/* The folder follows writes live (assets_changed); this is for
                files an agent wrote straight to disk, which send no event. */}
            {refresh && (
              <Menu.Item onClick={refresh}>
                <IconRefresh size={18} className="text-faint" />
                Refresh files
              </Menu.Item>
            )}
            <Menu.Separator />
          </>
        )}
        <Menu.Item onClick={onDelete} className="text-red">
          <IconTrash size={18} />
          Delete
        </Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  );
}

/** Safe file actions stay visible in the overlay, matching the media
 * lightbox. Delete remains behind More so a destructive action never reads as
 * a peer of Comment, Download, Copy link, and Open. */
function AssetOverlayActionBar({
  sessionId,
  file,
  refresh,
  onClose,
  onOpenAsTab,
  annotating,
  onAnnotate,
  phone,
}: {
  sessionId: string;
  file: SessionAssetFile;
  refresh: () => void;
  onClose: () => void;
  onOpenAsTab?: () => void;
  /** Annotate mode, or undefined when this file takes no comments. */
  annotating?: boolean;
  onAnnotate: (on: boolean) => void;
  phone: boolean;
}) {
  const rawUrl = sessionAssetPreviewUrl(sessionId, file);
  const stableUrl = sessionAssetRawUrl(sessionId, file.path);
  const downloadUrl = sessionAssetDownloadUrl(sessionId, file);
  const nativeShare = canUseNativeIOSShare();
  const name = file.path.split("/").pop() || "asset";
  const actionClass = cn(
    "shrink-0 cursor-pointer",
    phone &&
      "size-11 rounded-full px-0 text-xs text-white/55 hover:bg-white/10 hover:text-white/80",
  );
  const actionSize: "sm" | "md" = phone ? "sm" : "md";
  const actionLabel = (label: string) => (phone ? null : label);

  async function download() {
    await (async () => {
      await saveFileWithNativeShare(downloadUrl, name);
    })().catch(async (error) => {
      if (!nativeShareWasCancelled(error)) toast("Could not save that file");
    });
  }

  async function open() {
    await (async () => {
      await shareURL(rawUrl);
    })().catch(async (error) => {
      if (!nativeShareWasCancelled(error)) toast("Could not share that link");
    });
  }

  return (
    <div
      role="group"
      aria-label="Asset actions"
      className={cn(
        "flex items-center justify-center gap-1",
        phone &&
          "rounded-full bg-white/10 p-1 ring-1 ring-white/10 backdrop-blur-xl",
      )}
    >
      {annotating !== undefined && (
        <Button
          variant="overlay"
          size={actionSize}
          icon={<IconMessage size={phone ? 24 : 20} />}
          className={cn(
            actionClass,
            annotating && (phone ? "bg-white/20 text-white" : "bg-white/20"),
          )}
          aria-label={phone ? "Annotate" : undefined}
          aria-pressed={annotating}
          onClick={() => onAnnotate(!annotating)}
        >
          {actionLabel(annotating ? "Done" : "Annotate")}
        </Button>
      )}
      {nativeShare ? (
        <Button
          variant="overlay"
          size={actionSize}
          icon={<IconArrowDown size={phone ? 24 : 20} />}
          className={actionClass}
          aria-label={phone ? "Download" : undefined}
          onClick={download}
        >
          {actionLabel("Download")}
        </Button>
      ) : (
        <Button
          variant="overlay"
          size={actionSize}
          icon={<IconArrowDown size={phone ? 24 : 20} />}
          className={actionClass}
          aria-label={phone ? "Download" : undefined}
          render={<a href={downloadUrl} />}
        >
          {actionLabel("Download")}
        </Button>
      )}
      <Button
        variant="overlay"
        size={actionSize}
        icon={<IconLink size={phone ? 24 : 20} />}
        className={actionClass}
        aria-label={phone ? "Copy link" : undefined}
        onClick={() =>
          copyToClipboard(absoluteLink(stableUrl), () => toast("Link copied"))
        }
      >
        {actionLabel("Copy link")}
      </Button>
      {onOpenAsTab ? (
        <Button
          variant="overlay"
          size={actionSize}
          icon={<IconArrowUpRight size={phone ? 24 : 20} />}
          className={actionClass}
          aria-label={phone ? "Open" : undefined}
          onClick={onOpenAsTab}
        >
          {actionLabel("Open")}
        </Button>
      ) : nativeShare ? (
        <Button
          variant="overlay"
          size={actionSize}
          icon={<IconArrowUpRight size={phone ? 24 : 20} />}
          className={actionClass}
          aria-label={phone ? "Open or share" : undefined}
          onClick={open}
        >
          {actionLabel("Open or share")}
        </Button>
      ) : (
        <Button
          variant="overlay"
          size={actionSize}
          icon={<IconArrowUpRight size={phone ? 24 : 20} />}
          className={actionClass}
          aria-label={phone ? "Open" : undefined}
          render={<a href={rawUrl} target="_blank" rel="noreferrer" />}
        >
          {actionLabel("Open")}
        </Button>
      )}
      <AssetMenu
        sessionId={sessionId}
        file={file}
        refresh={refresh}
        onClose={onClose}
        phone={phone}
        deleteOnly
        bar
      />
    </div>
  );
}

/**
 * What you are looking at, under the file — name, then description, then the
 * pager. The same stack the media lightbox puts under a picture, because an
 * asset and a screenshot are the same gesture: glance at one thing lifted over
 * the conversation. Actions stay in their own toolbar, so this stack remains
 * a description rather than another row of controls.
 */
function AssetOverlayFooter({
  file,
  navigation,
  phone,
  showSize,
}: {
  file: SessionAssetFile;
  navigation: AssetNavigation | null;
  phone: boolean;
  showSize: boolean;
}) {
  const name = file.path.split("/").pop() || file.path;
  return (
    <div
      className={cn(
        "z-20 flex shrink-0 flex-col items-center gap-1 px-3 py-2",
        !phone && "absolute left-0 right-0 top-full mt-2",
      )}
    >
      <div className="flex max-w-full flex-col items-center gap-0.5 text-center">
        <div className="flex max-w-full items-center justify-center gap-2">
          <div
            className={cn(
              "max-w-full truncate font-medium text-white",
              phone ? "text-label" : "text-sm",
            )}
            title={file.path}
          >
            {name}
          </div>
          {showSize && (
            <span className="shrink-0 text-meta text-white/55">
              {formatAssetSize(file.size)}
            </span>
          )}
        </div>
        {file.description && (
          <div
            className={cn(
              "max-w-[min(720px,90vw)] line-clamp-2 leading-snug text-white/75",
              phone ? "text-supporting" : "text-sm",
            )}
          >
            {file.description}
          </div>
        )}
      </div>
      <div className="flex max-w-full items-center justify-center gap-2">
        {navigation && (
          <AssetPager navigation={navigation} arrows={phone} onDark />
        )}
      </div>
    </div>
  );
}

/**
 * The Assets tab's header: the file's name (a switcher when the folder holds
 * more than one), then Annotate, Open in browser and the overflow menu. The
 * tab is the file at full size, so the header is the only chrome it has.
 */
export function AssetActions({
  sessionId,
  file,
  files,
  onSelectPath,
  refresh,
  annotating,
  onAnnotate,
  showSize = false,
  className,
}: {
  sessionId: string;
  file: SessionAssetFile;
  /** The folder, for the name's switcher. */
  files: SessionAssetFile[];
  onSelectPath: (path: string) => void;
  /** Re-list the folder after a delete, or on request. */
  refresh?: () => void;
  /** Annotate mode, or undefined when this file takes no comments. */
  annotating?: boolean;
  onAnnotate?: (on: boolean) => void;
  /** False for a chip path whose folder listing has not caught up yet. */
  showSize?: boolean;
  className?: string;
}) {
  const name = file.path.split("/").pop() || file.path;
  const folder = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/"))
    : null;
  const rawUrl = sessionAssetPreviewUrl(sessionId, file);
  const nativeShare = canUseNativeIOSShare();
  const title = (
    <>
      <span className="truncate text-item-title font-semibold text-fg">
        {name}
      </span>
      {folder && (
        <span className="min-w-0 shrink truncate text-label text-faint">
          {folder}
        </span>
      )}
    </>
  );

  return (
    <div
      className={cn(
        "flex min-h-[var(--desktop-header-h)] shrink-0 items-center gap-1 border-b border-divider py-1.5 pr-2 pl-2",
        className,
      )}
    >
      <div className="min-w-0 flex-1" title={file.path}>
        {files.length > 1 ? (
          <Menu.Root>
            <Menu.Trigger
              aria-label={`${name}, switch file`}
              className="focus-ring flex max-w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-control border-0 bg-transparent px-2 py-1 text-left hover:bg-hover data-[popup-open]:bg-hover phone:min-h-11 phone:items-center"
            >
              {title}
              <IconChevronDown
                size={14}
                className="shrink-0 self-center text-faint"
              />
            </Menu.Trigger>
            <Menu.Popup
              align="start"
              className="max-h-[min(420px,70vh)] max-w-[min(420px,90vw)] min-w-[240px]"
            >
              <Menu.RadioGroup
                value={file.path}
                onValueChange={(path: string) => onSelectPath(path)}
              >
                {files.map((candidate) => (
                  <Menu.RadioItem
                    key={candidate.path}
                    value={candidate.path}
                    closeOnClick
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {candidate.path}
                    </span>
                    <Menu.Check on={candidate.path === file.path} />
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Root>
        ) : (
          <div className="flex min-w-0 items-baseline gap-2 px-2 py-1">
            {title}
          </div>
        )}
      </div>
      {showSize && (
        <span className="mr-1 shrink-0 text-meta tabular-nums text-faint phone:hidden">
          {formatAssetSize(file.size)}
        </span>
      )}
      {annotating !== undefined && (
        <Tooltip label={annotating ? "Stop annotating" : "Annotate"}>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconMessage size={16} />}
            className={cn(
              "shrink-0 phone:size-11",
              annotating && "bg-hover text-fg hover:bg-pressed",
            )}
            aria-pressed={annotating}
            aria-label={annotating ? "Stop annotating" : "Annotate"}
            onClick={() => onAnnotate?.(!annotating)}
          />
        </Tooltip>
      )}
      <Tooltip label={nativeShare ? "Open or share" : "Open in browser"}>
        <Button
          variant="ghost"
          size="sm"
          icon={<IconArrowUpRight size={16} />}
          className="shrink-0 phone:size-11"
          aria-label={nativeShare ? "Open or share" : "Open in browser"}
          {...(nativeShare
            ? {
                onClick: () =>
                  void shareURL(rawUrl).catch((error) => {
                    if (!nativeShareWasCancelled(error))
                      toast("Could not share that link");
                  }),
              }
            : { render: <a href={rawUrl} target="_blank" rel="noreferrer" /> })}
        />
      </Tooltip>
      <AssetMenu
        sessionId={sessionId}
        file={file}
        refresh={refresh}
        phone={false}
      />
    </div>
  );
}

/**
 * The file itself. HTML goes in an iframe served from the path-based raw
 * route, so a multi-file artifact's relative references (./style.css,
 * ./data.json) resolve to its siblings.
 */
export function AssetPreview({
  sessionId,
  file,
  onOpenNewSession,
  onBackdropClick,
  className,
  ref,
}: {
  sessionId: string;
  file: SessionAssetFile;
  /** The scrolling root, which an annotation layer reads and scrolls. */
  ref?: Ref<HTMLDivElement>;
  /** A link inside an HTML asset that spells out a new session — the artifact
   *  can hand work back to the app it was written in. */
  onOpenNewSession?: (prefill: NewSessionPrefill) => void;
  /** Dismiss an overlay when the letterboxed image canvas is clicked. */
  onBackdropClick?: () => void;
  className?: string;
}) {
  const kind = assetPreviewKind(file.path);
  const rawUrl = sessionAssetPreviewUrl(sessionId, file);

  // Text-ish previews fetch the body themselves.
  const [text, setText] = useState<string | null>(null);
  const [textFailed, setTextFailed] = useState(false);
  useEffect(() => {
    setText(null);
    setTextFailed(false);
    if (kind !== "text" && kind !== "markdown") return;
    let alive = true;
    fetch(rawUrl)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((t) => {
        if (alive)
          setText(t.length > ASSET_TEXT_CAP ? t.slice(0, ASSET_TEXT_CAP) : t);
      })
      .catch(() => {
        if (alive) setTextFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [rawUrl, kind]);

  return (
    <div ref={ref} className={cn("min-h-0 flex-1 overflow-auto", className)}>
      {kind === "html" ? (
        // allow-same-origin so the page can fetch() sibling assets
        // (./data.json); the sandbox still blocks top navigation. The
        // content is our own agents' output on a tailnet-only UI.
        <iframe
          key={rawUrl}
          title={file.path}
          src={rawUrl}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals allow-downloads"
          onLoad={(event) => {
            const document = event.currentTarget.contentDocument;
            if (!document) return;
            document.addEventListener("click", (clickEvent) => {
              const link =
                clickEvent.target instanceof Element
                  ? clickEvent.target.closest("a")
                  : null;
              const prefill = link ? parseNewSessionLink(link.href) : null;
              if (!prefill || !onOpenNewSession) return;
              clickEvent.preventDefault();
              onOpenNewSession(prefill);
            });
          }}
          className="h-full w-full border-0 bg-white"
        />
      ) : kind === "pdf" ? (
        // No sandbox: Chrome's built-in PDF viewer won't render in a
        // sandboxed iframe.
        <iframe
          key={rawUrl}
          title={file.path}
          src={rawUrl}
          className="h-full w-full border-0"
        />
      ) : kind === "image" ? (
        <div
          className="flex h-full items-center justify-center overflow-auto p-3"
          onClick={onBackdropClick}
        >
          <button
            type="button"
            className="flex max-h-full max-w-full cursor-zoom-in border-0 bg-transparent"
            onClick={(event) => {
              event.stopPropagation();
              openLightbox(
                [
                  {
                    kind: "image",
                    src: rawUrl,
                    sessionTitle: file.path,
                    description: file.description,
                  },
                ],
                0,
                event.currentTarget,
              );
            }}
            aria-label={`Zoom ${file.path}`}
          >
            <img
              src={rawUrl}
              alt={file.path}
              className="max-h-full max-w-full object-contain"
            />
          </button>
        </div>
      ) : kind === "video" ? (
        <video src={rawUrl} controls className="h-full w-full" />
      ) : kind === "audio" ? (
        <div className="p-4">
          <audio src={rawUrl} controls className="w-full" />
        </div>
      ) : kind === "markdown" ? (
        textFailed ? (
          <div className="p-4 text-label text-faint">
            Could not load this file.
          </div>
        ) : text === null ? (
          <div className="p-4 text-label text-faint">Loading…</div>
        ) : (
          <div className="@container min-h-full bg-raised px-6 py-10 sm:px-12 sm:py-14">
            <MarkdownBody
              className="markdown markdown-doc"
              html={renderMarkdown(text)}
              wrapCode={false}
            />
          </div>
        )
      ) : kind === "text" ? (
        textFailed ? (
          <div className="p-4 text-label text-faint">
            Could not load this file.
          </div>
        ) : text === null ? (
          <div className="p-4 text-label text-faint">Loading…</div>
        ) : (
          <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-label leading-[1.5] text-fg">
            {text}
            {file.size > ASSET_TEXT_CAP ? "\n… (truncated preview)" : ""}
          </pre>
        )
      ) : (
        <div className="flex h-full items-center justify-center text-label text-faint">
          No inline preview for this file type. Use Download.
        </div>
      )}
    </div>
  );
}

/**
 * One asset, over the conversation.
 *
 * `path` null means closed; the last file stays rendered while the panel
 * animates away, so a dismissal doesn't blink to an empty box on its way out.
 */
export function AssetOverlay({
  sessionId,
  path,
  files,
  refresh,
  onClose,
  onSelectPath,
  onOpenAsTab,
  onOpenNewSession,
}: {
  sessionId: string;
  path: string | null;
  files: SessionAssetFile[];
  refresh: () => void;
  onClose: () => void;
  /** Show another file in this overlay. */
  onSelectPath: (path: string) => void;
  /** Promote the open file into the Assets tab (and dismiss). */
  onOpenAsTab?: (path: string) => void;
  onOpenNewSession: (prefill: NewSessionPrefill) => void;
}) {
  const isPhone = useIsPhone();
  // Survives `path` going null so the exit animation has something to show.
  // While open, render directly from the controlled path so repeated arrow
  // presses never paint the previous asset for a frame.
  const [lastPath, setLastPath] = useState<string | null>(path);
  const [listedPath, setListedPath] = useState<string | null>(null);
  const [missingPath, setMissingPath] = useState<string | null>(null);
  // The file being annotated: moving to another file leaves the mode.
  const [annotatingPath, setAnnotatingPath] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (path) {
      setLastPath(path);
      setMissingPath(null);
    } else setAnnotatingPath(null);
  }, [path]);
  useEffect(() => {
    if (!path) return;
    if (files.some((candidate) => candidate.path === path)) {
      setListedPath(path);
      setMissingPath(null);
      return;
    }
    if (listedPath === path) {
      onClose();
      return;
    }
    const timeout = window.setTimeout(() => setMissingPath(path), 1_500);
    return () => window.clearTimeout(timeout);
  }, [path, files, listedPath, onClose]);
  useEffect(() => {
    if (!path || files.length < 2) return;
    const paths = files.map((file) => file.path);
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return;
      // Menus and controls use these keys themselves. Embedded HTML/PDF content
      // lives in its own document and keeps its own keyboard interactions too.
      if (document.querySelector(".app-menu-popup")) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          Boolean(
            target.closest(
              "input, textarea, select, audio, video, [contenteditable='true']",
            ),
          ))
      )
        return;
      const next = adjacentAssetPath(
        paths,
        path,
        event.key === "ArrowLeft" ? -1 : 1,
      );
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      onSelectPath(next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [path, files, onSelectPath]);
  const shown = path ?? lastPath;
  if (!shown) return null;
  const file = assetFileFor(shown, files);
  const name = file.path.split("/").pop() || file.path;
  const kind = assetPreviewKind(file.path);
  const visual = kind === "image" || kind === "video";
  const annotating = Boolean(path) && annotatingPath === file.path;
  const listed = files.some((candidate) => candidate.path === shown);
  const listedIndex = files.findIndex((candidate) => candidate.path === shown);
  const navigate = (direction: -1 | 1) => {
    const next = adjacentAssetPath(
      files.map((candidate) => candidate.path),
      shown,
      direction,
    );
    if (next) onSelectPath(next);
  };
  const navigation: AssetNavigation | null =
    listedIndex >= 0 && files.length > 1
      ? {
          index: listedIndex,
          count: files.length,
          onPrevious: () => navigate(-1),
          onNext: () => navigate(1),
          onSelect: (index) => {
            const selected = files[index]?.path;
            if (selected) onSelectPath(selected);
          },
        }
      : null;
  const footer = (
    <AssetOverlayFooter
      file={file}
      navigation={navigation}
      phone={isPhone}
      showSize={listed}
    />
  );
  const actions = (
    <AssetOverlayActionBar
      sessionId={sessionId}
      file={file}
      refresh={refresh}
      onClose={onClose}
      onOpenAsTab={onOpenAsTab ? () => onOpenAsTab(file.path) : undefined}
      annotating={canAnnotateAsset(kind) ? annotating : undefined}
      onAnnotate={(on) => setAnnotatingPath(on ? file.path : null)}
      phone={isPhone}
    />
  );

  return (
    <ResponsiveDialog
      open={Boolean(path)}
      onClose={onClose}
      phone={isPhone}
      label={`Preview ${name}`}
      // Assets float directly on the scrim, like transcript media. Files
      // that need a page surface bring their own inside the stage below.
      modalClassName="h-[min(820px,78vh)] w-[min(1120px,84vw)] max-w-none overflow-visible bg-transparent [box-shadow:none]!"
      sheetClassName="top-0 h-[100dvh] max-h-none bg-black pt-[env(safe-area-inset-top,0px)] [border-radius:0]! [box-shadow:none]!"
      backdropClassName="bg-black/85"
      showPhoneGrabber={false}
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden",
          isPhone && "bg-black",
        )}
      >
        {/* Desktop keeps the centered action bar above the asset. Phones put
				    the same controls at the bottom, beside the caption and pager. */}
        {!isPhone && (
          <div className="flex min-h-10 shrink-0 items-center justify-center px-12 pb-2">
            {actions}
          </div>
        )}
        <div
          className={cn(
            "relative flex min-h-0 flex-1",
            !visual && "m-3 overflow-hidden rounded-xl bg-surface text-fg",
          )}
        >
          {missingPath === file.path ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-label text-white/60">
              This file is no longer available.
            </div>
          ) : (
            <AssetPreview
              ref={previewRef}
              sessionId={sessionId}
              file={file}
              onBackdropClick={onClose}
              onOpenNewSession={(prefill) => {
                onClose();
                onOpenNewSession(prefill);
              }}
            />
          )}
          {annotating && (
            <AssetAnnotationLayer
              sessionId={sessionId}
              path={file.path}
              preview={previewRef}
              onExit={() => setAnnotatingPath(null)}
            />
          )}
        </div>
        {isPhone && footer}
        {isPhone && (
          <div className="flex shrink-0 items-center justify-center px-5 pt-2 pb-4">
            {actions}
          </div>
        )}
      </div>
      {!isPhone && footer}
      {isPhone ? (
        <button
          type="button"
          aria-label="Close"
          className="absolute right-[calc(12px+env(safe-area-inset-right,0px))] top-[calc(12px+env(safe-area-inset-top,0px))] z-20 grid size-11 place-items-center rounded-full border-0 bg-white/15 text-white backdrop-blur-xl transition-[transform,background-color] active:scale-[0.96] hover:bg-white/20"
          onClick={onClose}
        >
          <IconX size={24} />
        </button>
      ) : (
        <Tooltip label="Close">
          <button
            type="button"
            aria-label="Close"
            className="absolute right-0 top-0 z-20 grid size-10 place-items-center rounded-full border-0 bg-white/15 text-white backdrop-blur-xl transition-[transform,background-color] active:scale-[0.96] hover:bg-white/20"
            onClick={onClose}
          >
            <IconX size={20} />
          </button>
        </Tooltip>
      )}
      {!isPhone && navigation && (
        <>
          <AssetSideButton
            direction="previous"
            onClick={navigation.onPrevious}
          />
          <AssetSideButton direction="next" onClick={navigation.onNext} />
        </>
      )}
    </ResponsiveDialog>
  );
}
