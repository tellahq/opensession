import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
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

import React, { useEffect, useState } from "react";
import { marked } from "marked";
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
import { openLightbox } from "../lib/media-lightbox";
import {
  IconArrowDown,
  IconArrowUpRight,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDotsHorizontal,
  IconLink,
  IconMessage,
  IconTrash,
  IconX,
} from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  minH7: {
    minHeight: "calc(4px * 7)",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  gap1: {
    gap: "4px",
  },
  minW10: {
    minWidth: "calc(4px * 10)",
  },
  px1: {
    paddingInline: "4px",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  p1: {
    padding: "4px",
  },
  leadingNone: {
    lineHeight: "1",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  textRed: {
    color: "var(--red)",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  textCenter: {
    textAlign: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  textWhite55: {
    color: "color-mix(in oklab, var(--color-white) 55%, transparent)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  lineClamp2: {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: "2",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  size7: {
    width: "calc(4px * 7)",
    height: "calc(4px * 7)",
  },
  px0: {
    paddingInline: "0",
  },
  hFull: {
    height: "100%",
  },
  wFull: {
    width: "100%",
  },
  bgWhite: {
    backgroundColor: "var(--color-white)",
  },
  overflowAuto: {
    overflow: "auto",
  },
  p3: {
    padding: "calc(4px * 3)",
  },
  maxHFull: {
    maxHeight: "100%",
  },
  cursorZoomIn: {
    cursor: "zoom-in",
  },
  objectContain: {
    objectFit: "contain",
  },
  p4: {
    padding: "calc(4px * 4)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  whitespacePreWrap: {
    whiteSpace: "pre-wrap",
  },
  breakWords: {
    overflowWrap: "break-word",
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
  leading15: {
    lineHeight: "1.5",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  px12: {
    paddingInline: "calc(4px * 12)",
  },
  pb2: {
    paddingBottom: "calc(4px * 2)",
  },
  minH0: {
    minHeight: "0",
  },
  px6: {
    paddingInline: "calc(4px * 6)",
  },
  textWhite60: {
    color: "color-mix(in oklab, var(--color-white) 60%, transparent)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  pt2: {
    paddingTop: "calc(4px * 2)",
  },
  pb4: {
    paddingBottom: "calc(4px * 4)",
  },
  absolute: {
    position: "absolute",
  },
  right3: {
    right: "calc(4px * 3)",
  },
  top3: {
    top: "calc(4px * 3)",
  },
  z20: {
    zIndex: "20",
  },
  grid: {
    display: "grid",
  },
  size11: {
    width: "calc(4px * 11)",
    height: "calc(4px * 11)",
  },
  placeItemsCenter: {
    placeItems: "center",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgWhite15: {
    backgroundColor: "color-mix(in oklab, var(--color-white) 15%, transparent)",
  },
  textWhite: {
    color: "var(--color-white)",
  },
  transitionTransformBackgroundColor: {
    transitionProperty: "transform,background-color",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  activeScale096: {
    ":active": {
      scale: "0.96",
    },
  },
  hoverBgWhite20: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor:
          "color-mix(in oklab, var(--color-white) 20%, transparent)",
      },
    },
  },
  right0: {
    right: "0",
  },
  top0: {
    top: "0",
  },
  size10: {
    width: "calc(4px * 10)",
    height: "calc(4px * 10)",
  },
});

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
      {...stylex.props(
        sx.flex,
        sx.minH7,
        sx.shrink0,
        sx.itemsCenter,
        sx.justifyCenter,
        sx.gap1,
      )}
    >
      {arrows && (
        <Tooltip label="Previous asset (Left arrow)">
          <Button
            variant="ghost"
            size="sm"
            icon={<IconChevronLeft size={16} />}
            aria-label="Previous asset"
            className={cn(
              utilityClassName("size-9"),
              onDark &&
                utilityClassName(
                  "text-white/60 hover:bg-white/15 hover:text-white",
                ),
            )}
            onClick={onPrevious}
          />
        </Tooltip>
      )}
      <div
        aria-label={positionLabel}
        title={positionLabel}
        {...stylex.props(
          sx.flex,
          sx.minW10,
          sx.itemsCenter,
          sx.justifyCenter,
          sx.px1,
        )}
      >
        {count <= 10 ? (
          Array.from({ length: count }, (_, dot) => (
            <button
              key={dot}
              type="button"
              onClick={() => onSelect(dot)}
              aria-label={`Show ${dot + 1} of ${count}`}
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
                    "block size-1.5 rounded-full transition-colors",
                  ),
                  dot === index
                    ? onDark
                      ? utilityClassName("bg-white")
                      : utilityClassName("bg-fg")
                    : onDark
                      ? utilityClassName("bg-white/35 group-hover:bg-white/70")
                      : utilityClassName("bg-line-strong group-hover:bg-dim"),
                )}
              />
            </button>
          ))
        ) : (
          <span
            role="status"
            className={cn(
              utilityClassName("px-1 text-meta tabular-nums"),
              onDark
                ? utilityClassName("text-white/60")
                : utilityClassName("text-faint"),
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
              utilityClassName("size-9"),
              onDark &&
                utilityClassName(
                  "text-white/60 hover:bg-white/15 hover:text-white",
                ),
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
          utilityClassName(
            "absolute top-1/2 z-20 size-10 -translate-y-1/2 rounded-full bg-raised smooth-shadow-sm",
          ),
          previous
            ? utilityClassName("right-full mr-3")
            : utilityClassName("left-full ml-3"),
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
          utilityClassName(
            "flex shrink-0 items-center justify-center border-0",
          ),
          bar
            ? cn(
                utilityClassName(
                  "size-10 rounded-full bg-transparent transition-[transform,background-color,color] active:scale-[0.96] phone:size-11",
                ),
                phone
                  ? utilityClassName(
                      "text-white/55 hover:bg-white/10 hover:text-white/80 data-[popup-open]:bg-white/10 data-[popup-open]:text-white/80",
                    )
                  : utilityClassName(
                      "text-white/60 hover:bg-white/15 hover:text-white data-[popup-open]:bg-white/15 data-[popup-open]:text-white",
                    ),
              )
            : phone
              ? utilityClassName(
                  "size-11 rounded-full bg-panel text-dim active:bg-pressed data-[popup-open]:bg-pressed data-[popup-open]:text-fg",
                )
              : utilityClassName(
                  "size-7 rounded-control bg-transparent text-dim hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg",
                ),
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
              <IconArrowDown
                size={18}
                className={mergeStylexOverrideClassName("", sx.textFaint)}
              />
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
              <IconArrowUpRight
                size={18}
                className={mergeStylexOverrideClassName("", sx.textFaint)}
              />
              {nativeShare ? "Open or share" : "Open in a browser tab"}
            </Menu.Item>
            <Menu.Item
              onClick={() =>
                copyToClipboard(absoluteLink(stableUrl), () =>
                  toast("Link copied"),
                )
              }
            >
              <IconCopy
                size={18}
                className={mergeStylexOverrideClassName("", sx.textFaint)}
              />
              Copy link
            </Menu.Item>
            <Menu.Separator />
          </>
        )}
        <Menu.Item
          onClick={onDelete}
          className={mergeStylexOverrideClassName("", sx.textRed)}
        >
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
  phone,
}: {
  sessionId: string;
  file: SessionAssetFile;
  refresh: () => void;
  onClose: () => void;
  onOpenAsTab?: () => void;
  phone: boolean;
}) {
  const rawUrl = sessionAssetPreviewUrl(sessionId, file);
  const stableUrl = sessionAssetRawUrl(sessionId, file.path);
  const downloadUrl = sessionAssetDownloadUrl(sessionId, file);
  const nativeShare = canUseNativeIOSShare();
  const name = file.path.split("/").pop() || "asset";
  const commentable = assetPreviewKind(file.path) === "image";
  const actionClass = cn(
    utilityClassName("shrink-0 cursor-pointer"),
    phone &&
      utilityClassName(
        "size-11 rounded-full px-0 text-xs text-white/55 hover:bg-white/10 hover:text-white/80",
      ),
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
        utilityClassName("flex items-center justify-center gap-1"),
        phone &&
          utilityClassName(
            "rounded-full bg-white/10 p-1 ring-1 ring-white/10 backdrop-blur-xl",
          ),
      )}
    >
      {commentable && (
        <Button
          variant="overlay"
          size={actionSize}
          icon={<IconMessage size={phone ? 24 : 20} />}
          className={actionClass}
          aria-label={phone ? "Comment" : undefined}
          onClick={() =>
            openLightbox(
              [
                {
                  kind: "image",
                  src: rawUrl,
                  sessionTitle: file.path,
                  description: file.description,
                  commentSessionId: sessionId,
                },
              ],
              0,
              null,
              { startCommenting: true },
            )
          }
        >
          {actionLabel("Comment")}
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
        utilityClassName(
          "z-20 flex shrink-0 flex-col items-center gap-1 px-3 py-2",
        ),
        !phone && utilityClassName("absolute left-0 right-0 top-full mt-2"),
      )}
    >
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
          <div
            className={cn(
              utilityClassName("max-w-full truncate font-medium text-white"),
              phone
                ? utilityClassName("text-label")
                : utilityClassName("text-sm"),
            )}
            title={file.path}
          >
            {name}
          </div>
          {showSize && (
            <span
              {...stylex.props(sx.shrink0, sx.textWhite55, typography.meta)}
            >
              {formatAssetSize(file.size)}
            </span>
          )}
        </div>
        {file.description && (
          <div
            className={cn(
              utilityClassName(
                "max-w-[min(720px,90vw)] line-clamp-2 leading-snug text-white/75",
              ),
              phone
                ? utilityClassName("text-supporting")
                : utilityClassName("text-sm"),
            )}
          >
            {file.description}
          </div>
        )}
      </div>
      <div
        {...stylex.props(
          sx.flex,
          sx.maxWFull,
          sx.itemsCenter,
          sx.justifyCenter,
          sx.gap2,
        )}
      >
        {navigation && (
          <AssetPager navigation={navigation} arrows={phone} onDark />
        )}
      </div>
    </div>
  );
}

/**
 * The Assets tab's file header and operations, in one row.
 *
 * The promotion into a tab earns a place on the surface. File operations
 * live behind the overflow, because a header of six
 * peer-looking text links makes the destructive one exactly as easy to hit as
 * the harmless ones. Omit `onOpenAsTab` where the tab IS the surface.
 */
export function AssetActions({
  sessionId,
  file,
  refresh,
  onOpenAsTab,
  onClose,
  showMenu = true,
  showSize = false,
  className,
}: {
  sessionId: string;
  file: SessionAssetFile;
  /** Re-list the folder after a delete. */
  refresh?: () => void;
  /** Optionally promote this file into the workspace's Assets tab. */
  onOpenAsTab?: () => void;
  /** Dismiss the surface — the overlay's ✕. Also called after a delete, since
   *  there is nothing left to show. */
  onClose?: () => void;
  /** Hide this menu when another row owns the file actions. */
  showMenu?: boolean;
  /** False for a chip path whose folder listing has not caught up yet. */
  showSize?: boolean;
  className?: string;
}) {
  const name = file.path.split("/").pop() || file.path;
  const folder = file.path.includes("/")
    ? file.path.slice(0, file.path.lastIndexOf("/"))
    : null;

  return (
    <div
      className={cn(
        utilityClassName(
          "flex shrink-0 items-center gap-2 border-b border-divider px-3 py-2",
        ),
        className,
      )}
    >
      <div {...stylex.props(sx.minW0, sx.flex1)} title={file.path}>
        <div
          {...stylex.props(
            sx.truncate,
            sx.fontMedium,
            sx.textFg,
            typography.label,
          )}
        >
          {name}
        </div>
        {file.description && (
          <div
            {...stylex.props(
              sx.lineClamp2,
              sx.leadingSnug,
              sx.textDim,
              typography.supporting,
            )}
          >
            {file.description}
          </div>
        )}
        {folder && (
          <div {...stylex.props(sx.truncate, sx.textFaint, typography.meta)}>
            {folder}
          </div>
        )}
      </div>
      {showSize && (
        <span {...stylex.props(sx.shrink0, sx.textFaint, typography.meta)}>
          {formatAssetSize(file.size)}
        </span>
      )}
      {onOpenAsTab && (
        <Button
          variant="ghost"
          size="sm"
          className={mergeStylexOverrideClassName("", sx.shrink0)}
          onClick={onOpenAsTab}
        >
          Open as tab
        </Button>
      )}
      {showMenu && (
        <AssetMenu
          sessionId={sessionId}
          file={file}
          refresh={refresh}
          onClose={onClose}
        />
      )}
      {onClose && (
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close"
          className={mergeStylexOverrideClassName(
            "",
            sx.size7,
            sx.shrink0,
            sx.justifyCenter,
            sx.px0,
          )}
          onClick={onClose}
        >
          <IconX size={16} />
        </Button>
      )}
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
}: {
  sessionId: string;
  file: SessionAssetFile;
  /** A link inside an HTML asset that spells out a new session — the artifact
   *  can hand work back to the app it was written in. */
  onOpenNewSession: (prefill: NewSessionPrefill) => void;
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
    <div
      className={cn(
        utilityClassName("min-h-0 flex-1 overflow-auto"),
        className,
      )}
    >
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
              const link = (clickEvent.target as Element | null)?.closest?.(
                "a",
              );
              const prefill = link ? parseNewSessionLink(link.href) : null;
              if (!prefill) return;
              clickEvent.preventDefault();
              onOpenNewSession(prefill);
            });
          }}
          {...stylex.props(sx.hFull, sx.wFull, sx.border0, sx.bgWhite)}
        />
      ) : kind === "pdf" ? (
        // No sandbox: Chrome's built-in PDF viewer won't render in a
        // sandboxed iframe.
        <iframe
          key={rawUrl}
          title={file.path}
          src={rawUrl}
          {...stylex.props(sx.hFull, sx.wFull, sx.border0)}
        />
      ) : kind === "image" ? (
        <div
          {...stylex.props(
            sx.flex,
            sx.hFull,
            sx.itemsCenter,
            sx.justifyCenter,
            sx.overflowAuto,
            sx.p3,
          )}
          onClick={onBackdropClick}
        >
          <button
            type="button"
            {...stylex.props(
              sx.flex,
              sx.maxHFull,
              sx.maxWFull,
              sx.cursorZoomIn,
              sx.border0,
              sx.bgTransparent,
            )}
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
              {...stylex.props(sx.maxHFull, sx.maxWFull, sx.objectContain)}
            />
          </button>
        </div>
      ) : kind === "video" ? (
        <video src={rawUrl} controls {...stylex.props(sx.hFull, sx.wFull)} />
      ) : kind === "audio" ? (
        <div {...stylex.props(sx.p4)}>
          <audio src={rawUrl} controls {...stylex.props(sx.wFull)} />
        </div>
      ) : kind === "markdown" ? (
        textFailed ? (
          <div {...stylex.props(sx.p4, sx.textFaint, typography.label)}>
            Could not load this file.
          </div>
        ) : text === null ? (
          <div {...stylex.props(sx.p4, sx.textFaint, typography.label)}>
            Loading…
          </div>
        ) : (
          <MarkdownBody
            className={mergeStylexOverrideClassName(
              "markdown",
              sx.px4,
              sx.py3,
              typography.label,
            )}
            html={marked.parse(text, { async: false }) as string}
          />
        )
      ) : kind === "text" ? (
        textFailed ? (
          <div {...stylex.props(sx.p4, sx.textFaint, typography.label)}>
            Could not load this file.
          </div>
        ) : text === null ? (
          <div {...stylex.props(sx.p4, sx.textFaint, typography.label)}>
            Loading…
          </div>
        ) : (
          <pre
            {...stylex.props(
              sx.whitespacePreWrap,
              sx.breakWords,
              sx.px4,
              sx.py3,
              sx.fontMono,
              sx.leading15,
              sx.textFg,
              typography.label,
            )}
          >
            {text}
            {file.size > ASSET_TEXT_CAP ? "\n… (truncated preview)" : ""}
          </pre>
        )
      ) : (
        <div
          {...stylex.props(
            sx.flex,
            sx.hFull,
            sx.itemsCenter,
            sx.justifyCenter,
            sx.textFaint,
            typography.label,
          )}
        >
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
  useEffect(() => {
    if (path) {
      setLastPath(path);
      setMissingPath(null);
    }
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
      modalClassName={utilityClassName(
        "h-[min(820px,78vh)] w-[min(1120px,84vw)] max-w-none overflow-visible bg-transparent [box-shadow:none]!",
      )}
      sheetClassName={utilityClassName(
        "top-0 h-[100dvh] max-h-none bg-black [border-radius:0]! [box-shadow:none]!",
      )}
      backdropClassName={utilityClassName("bg-black/85")}
      showPhoneGrabber={false}
    >
      <div
        className={cn(
          utilityClassName("flex min-h-0 flex-1 flex-col overflow-hidden"),
          isPhone && utilityClassName("bg-black"),
        )}
      >
        {/* Desktop keeps the centered action bar above the asset. Phones put
				    the same controls at the bottom, beside the caption and pager. */}
        {!isPhone && (
          <div
            {...stylex.props(
              sx.flex,
              sx.minH10,
              sx.shrink0,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.px12,
              sx.pb2,
            )}
          >
            {actions}
          </div>
        )}
        <div
          className={cn(
            utilityClassName("relative flex min-h-0 flex-1"),
            !visual &&
              utilityClassName(
                "m-3 overflow-hidden rounded-xl bg-surface text-fg",
              ),
          )}
        >
          {missingPath === file.path ? (
            <div
              {...stylex.props(
                sx.flex,
                sx.minH0,
                sx.flex1,
                sx.itemsCenter,
                sx.justifyCenter,
                sx.px6,
                sx.textCenter,
                sx.textWhite60,
                typography.label,
              )}
            >
              This file is no longer available.
            </div>
          ) : (
            <AssetPreview
              sessionId={sessionId}
              file={file}
              onBackdropClick={onClose}
              onOpenNewSession={(prefill) => {
                onClose();
                onOpenNewSession(prefill);
              }}
            />
          )}
        </div>
        {isPhone && footer}
        {isPhone && (
          <div
            {...stylex.props(
              sx.flex,
              sx.shrink0,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.px5,
              sx.pt2,
              sx.pb4,
            )}
          >
            {actions}
          </div>
        )}
      </div>
      {!isPhone && footer}
      {isPhone ? (
        <button
          type="button"
          aria-label="Close"
          {...mergeStylexProps(
            "backdrop-blur-xl",
            sx.absolute,
            sx.right3,
            sx.top3,
            sx.z20,
            sx.grid,
            sx.size11,
            sx.placeItemsCenter,
            sx.roundedFull,
            sx.border0,
            sx.bgWhite15,
            sx.textWhite,
            sx.transitionTransformBackgroundColor,
            sx.activeScale096,
            sx.hoverBgWhite20,
          )}
          onClick={onClose}
        >
          <IconX size={24} />
        </button>
      ) : (
        <Tooltip label="Close">
          <button
            type="button"
            aria-label="Close"
            {...mergeStylexProps(
              "backdrop-blur-xl",
              sx.absolute,
              sx.right0,
              sx.top0,
              sx.z20,
              sx.grid,
              sx.size10,
              sx.placeItemsCenter,
              sx.roundedFull,
              sx.border0,
              sx.bgWhite15,
              sx.textWhite,
              sx.transitionTransformBackgroundColor,
              sx.activeScale096,
              sx.hoverBgWhite20,
            )}
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
