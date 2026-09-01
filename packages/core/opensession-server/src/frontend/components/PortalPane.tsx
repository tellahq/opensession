import { mergeStylexOverrideClassName } from "../ui/cn";
import { useState } from "react";
import type { PortalTarget } from "../lib/portals";
import { Button } from "../ui/button";
import { PageLoader } from "../ui/page-loader";
import { IconArrowUpRight, IconGlobe, IconRestore } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  hFull: {
    height: "100%",
  },
  minH0: {
    minHeight: "0",
  },
  flexCol: {
    flexDirection: "column",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  minH11: {
    minHeight: "calc(4px * 11)",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  h2: {
    height: "calc(4px * 2)",
  },
  w2: {
    width: "calc(4px * 2)",
  },
  shrink0: {
    flexShrink: "0",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgGreen: {
    backgroundColor: "var(--green)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  opacity60: {
    opacity: "60%",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  relative: {
    position: "relative",
  },
  bgWhite: {
    backgroundColor: "var(--color-white)",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  inset0: {
    inset: "0",
  },
  z10: {
    zIndex: "10",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  block: {
    display: "block",
  },
  wFull: {
    width: "100%",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
});

/** Browser-like center pane for one service exposed by a session portal. */
export function PortalPane({ target }: { target: PortalTarget }) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loading, setLoading] = useState(true);

  return (
    <div {...stylex.props(sx.flex, sx.hFull, sx.minH0, sx.flexCol, sx.bgPanel)}>
      <div
        {...stylex.props(
          sx.flex,
          sx.minH11,
          sx.itemsCenter,
          sx.gap2,
          sx.borderB,
          sx.borderDivider,
          sx.px3,
          sx.py15,
        )}
      >
        <span
          {...stylex.props(
            sx.h2,
            sx.w2,
            sx.shrink0,
            sx.roundedFull,
            sx.bgGreen,
          )}
          aria-hidden="true"
        />
        <div
          {...stylex.props(
            sx.flex,
            sx.minW0,
            sx.flex1,
            sx.itemsCenter,
            sx.gap2,
            sx.roundedControl,
            sx.border,
            sx.borderLine,
            sx.bgSurface,
            sx.px3,
            sx.py15,
            sx.textDim,
            typography.supporting,
          )}
          title={target.url}
        >
          <IconGlobe
            size={14}
            className={mergeStylexOverrideClassName(
              "",
              sx.shrink0,
              sx.opacity60,
            )}
          />
          <span {...stylex.props(sx.truncate)}>{target.url}</span>
        </div>
        <Button
          variant="ghost"
          size="md"
          icon={<IconRestore size={16} />}
          onClick={() => {
            setLoading(true);
            setReloadNonce((nonce) => nonce + 1);
          }}
          aria-label={`Reload ${target.name}`}
          title="Reload portal"
        />
        <Button
          variant="ghost"
          size="md"
          icon={<IconArrowUpRight size={16} />}
          onClick={() =>
            window.open(
              target.url,
              `portal-${target.sessionId}-${target.key}`,
              "noopener",
            )
          }
          aria-label={`Open ${target.name} in a separate browser window`}
          title="Open in browser"
        />
      </div>
      <div {...stylex.props(sx.relative, sx.minH0, sx.flex1, sx.bgWhite)}>
        {loading ? (
          <div
            role="status"
            aria-label={`Loading ${target.name}`}
            {...stylex.props(
              sx.pointerEventsNone,
              sx.absolute,
              sx.inset0,
              sx.z10,
              sx.flex,
              sx.itemsCenter,
              sx.justifyCenter,
              sx.bgPanel,
            )}
          >
            <PageLoader
              className={mergeStylexOverrideClassName("", sx.textDim)}
            />
          </div>
        ) : null}
        <iframe
          key={`${target.url}#${reloadNonce}`}
          {...stylex.props(
            sx.block,
            sx.hFull,
            sx.wFull,
            sx.border0,
            sx.bgWhite,
          )}
          src={target.url}
          title={`${target.name} portal`}
          onLoad={() => setLoading(false)}
          allow="clipboard-read; clipboard-write; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads"
        />
      </div>
    </div>
  );
}
