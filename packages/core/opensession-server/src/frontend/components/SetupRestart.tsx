import { mergeStylexProps } from "../ui/cn";
import React from "react";
import type { SetupController } from "../hooks/useSetupStatus";
import { Button } from "../ui/button";
import { LoadingState } from "../ui/state";
import { Code } from "./setup-shared";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  sticky: {
    position: "sticky",
  },
  bottom3: {
    bottom: "calc(4px * 3)",
  },
  z20: {
    zIndex: "20",
  },
  mt8: {
    marginTop: "calc(4px * 8)",
  },
  flex: {
    display: "flex",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gapX4: {
    columnGap: "calc(4px * 4)",
  },
  gapY2: {
    rowGap: "calc(4px * 2)",
  },
  roundedLg: {
    borderRadius: "calc(14px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  smoothShadowSoft: {
    boxShadow:
      "0 3px 10px -3px color-mix(in srgb, var(--smooth-shadow-color) 4%, transparent), 0 20px 56px -16px color-mix(in srgb, var(--smooth-shadow-color) 12%, transparent)",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  absolute: {
    position: "absolute",
  },
  inset0: {
    inset: "0",
  },
  z30: {
    zIndex: "30",
  },
  bgBg75: {
    backgroundColor: "color-mix(in oklab, var(--bg) 75%, transparent)",
  },
  top30vh: {
    top: "30vh",
  },
  pb8: {
    paddingBottom: "calc(4px * 8)",
  },
});

// The "changes saved — restart to apply" banner, and the veil it puts over the
// page while the server is down. Any page that can save a credential or an
// enable flag renders one, so the offer to apply the change is always where
// the change was made. The parent must be `relative` — the veil is absolute.

export function SetupRestart({ setup }: { setup: SetupController }) {
  // First-run setup applies live-readable settings as it progresses. Do not
  // interrupt /welcome with a restart prompt between steps.
  if (
    typeof window !== "undefined" &&
    /\/welcome\/?$/.test(window.location.pathname)
  ) {
    return null;
  }
  const { restartNeeded, restartState, restartServer } = setup;
  return (
    <>
      {restartNeeded && restartState !== "working" && (
        <div
          {...stylex.props(
            sx.sticky,
            sx.bottom3,
            sx.z20,
            sx.mt8,
            sx.flex,
            sx.flexWrap,
            sx.itemsCenter,
            sx.gapX4,
            sx.gapY2,
            sx.roundedLg,
            sx.border,
            sx.borderLine,
            sx.bgPanel,
            sx.px4,
            sx.py3,
            sx.smoothShadowSoft,
          )}
        >
          <div {...stylex.props(sx.minW0, sx.flex1)}>
            <div
              {...stylex.props(
                sx.fontMedium,
                sx.textFg,
                typography.controlLabel,
              )}
            >
              Changes saved. Restart to apply.
            </div>
            <div {...stylex.props(sx.mt05, sx.textDim, typography.supporting)}>
              {restartState === "failed" ? (
                <>
                  Still not back. Check <Code>opensession logs</Code>.
                </>
              ) : (
                "The server reads credentials and enable flags on boot. Restarts take a few seconds; running engine turns keep going."
              )}
            </div>
          </div>
          {restartState === "failed" ? (
            <Button onClick={() => restartServer(false)}>Check again</Button>
          ) : (
            <Button variant="primary" onClick={() => restartServer()}>
              Restart server
            </Button>
          )}
        </div>
      )}
      {restartState === "working" && (
        <div
          {...mergeStylexProps(
            "backdrop-blur-[2px]",
            sx.absolute,
            sx.inset0,
            sx.z30,
            sx.roundedLg,
            sx.bgBg75,
          )}
        >
          <div {...stylex.props(sx.sticky, sx.top30vh, sx.pb8)}>
            <LoadingState>Restarting…</LoadingState>
          </div>
        </div>
      )}
    </>
  );
}
