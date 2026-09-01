import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { useEffect, useState, type ReactNode } from "react";
import { BASE_PATH } from "../lib/base";
import { effectiveTheme, onThemeChanged } from "../lib/theme";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import { IconChevronLeft } from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flex: {
    display: "flex",
  },
  minW0: {
    minWidth: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap1: {
    gap: "4px",
  },
  Ml1: {
    marginLeft: "calc(4px * -1)",
  },
  size7: {
    width: "calc(4px * 7)",
    height: "calc(4px * 7)",
  },
  shrink0: {
    flexShrink: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  grid: {
    display: "grid",
  },
  minH0: {
    minHeight: "0",
  },
  flex1: {
    flex: "1",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  desktopGridCols3: {
    "@media (min-width: 721px)": {
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    },
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  desktopGridCols3fr2fr: {
    "@media (min-width: 721px)": {
      gridTemplateColumns: "3fr 2fr",
    },
  },
  relative: {
    position: "relative",
  },
  hFull: {
    height: "100%",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  bgCover: {
    backgroundSize: "cover",
  },
  bgCenter: {
    backgroundPosition: "center",
  },
  pl5: {
    paddingLeft: "calc(4px * 5)",
  },
  pt5: {
    paddingTop: "calc(4px * 5)",
  },
  wFull: {
    width: "100%",
  },
  roundedTlLg: {
    borderTopLeftRadius: "calc(14px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  objectCover: {
    objectFit: "cover",
  },
  objectLeftTop: {
    objectPosition: "left top",
  },
  OutlineOffset1: {
    outlineOffset: "calc(1px * -1)",
  },
  outlineBlack10: {
    outlineColor: "color-mix(in oklab, var(--color-black) 10%, transparent)",
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
  bottom0: {
    bottom: "0",
  },
  h13: {
    height: "calc(1 / 3 * 100%)",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  pt6: {
    paddingTop: "calc(4px * 6)",
  },
  z10: {
    zIndex: "10",
  },
  h130: {
    height: "130%",
  },
  wAuto: {
    width: "auto",
  },
  maxWNone: {
    maxWidth: "none",
  },
  originTop: {
    transformOrigin: "top",
  },
  rounded2xl: {
    borderRadius: "calc(22px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  objectContain: {
    objectFit: "contain",
  },
  objectTop: {
    objectPosition: "top",
  },
  smoothShadowLg: {
    boxShadow:
      "0 4px 12px -4px color-mix(in srgb, var(--smooth-shadow-color) 5%, transparent), 0 18px 48px -14px color-mix(in srgb, var(--smooth-shadow-color) 11%, transparent)",
  },
  z20: {
    zIndex: "20",
  },
  h20rem: {
    height: "20rem",
  },
  flexCol: {
    flexDirection: "column",
  },
  roundedCalc22pxVarRf: {
    borderRadius: "calc(22px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  desktopH22rem: {
    "@media (min-width: 721px)": {
      height: "22rem",
    },
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  pb4: {
    paddingBottom: "calc(4px * 4)",
  },
  desktopPx5: {
    "@media (min-width: 721px)": {
      paddingInline: "calc(4px * 5)",
    },
  },
  desktopPb5: {
    "@media (min-width: 721px)": {
      paddingBottom: "calc(4px * 5)",
    },
  },
  m0: {
    margin: "0",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  leadingTight: {
    lineHeight: "var(--leading-tight)",
  },
  textFg: {
    color: "var(--text)",
  },
  mb4: {
    marginBottom: "calc(4px * 4)",
  },
  mt1: {
    marginTop: "4px",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  minH48: {
    minHeight: "calc(4px * 48)",
  },
  roundedXl: {
    borderRadius: "calc(18px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  p5: {
    padding: "calc(4px * 5)",
  },
  desktopMinH60: {
    "@media (min-width: 721px)": {
      minHeight: "calc(4px * 60)",
    },
  },
  mbAuto: {
    marginBottom: "auto",
  },
  size10: {
    width: "calc(4px * 10)",
    height: "calc(4px * 10)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgAccent: {
    backgroundColor: "var(--accent)",
  },
  textOnAccent: {
    color: "var(--on-accent)",
  },
  mb1: {
    marginBottom: "4px",
  },
  mt6: {
    marginTop: "calc(4px * 6)",
  },
  fontNormal: {
    fontWeight: "var(--font-weight-normal)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
});

/** Apple's mark, for the Mac download. A solid glyph, not part of the stroke set. */
function IconApple({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M16.365 1.43c0 1.14-.417 2.2-1.25 3.06-.99 1.02-2.09 1.61-3.28 1.52a3.3 3.3 0 0 1-.02-.4c0-1.09.47-2.25 1.3-3.09.42-.43.95-.79 1.6-1.08.64-.28 1.25-.44 1.82-.47.02.15.03.3.03.46zM20.6 17.02c-.32.74-.7 1.42-1.14 2.05-.6.86-1.09 1.45-1.47 1.78-.59.54-1.22.82-1.9.84-.48 0-1.07-.14-1.75-.42-.68-.28-1.31-.42-1.89-.42-.6 0-1.25.14-1.94.42-.7.28-1.26.43-1.69.44-.65.03-1.29-.26-1.92-.86-.41-.36-.92-.97-1.53-1.83-.65-.92-1.19-1.98-1.6-3.2-.45-1.31-.68-2.58-.68-3.81 0-1.4.3-2.61.91-3.62a5.35 5.35 0 0 1 1.9-1.93 5.1 5.1 0 0 1 2.57-.72c.51 0 1.18.16 2.02.47.83.31 1.37.47 1.6.47.18 0 .78-.19 1.79-.55.96-.34 1.77-.48 2.43-.42 1.79.14 3.14.85 4.03 2.13-1.6.97-2.39 2.33-2.38 4.07.02 1.36.51 2.49 1.48 3.38.44.42.93.74 1.47.97-.12.34-.24.66-.38.97z" />
    </svg>
  );
}

export function DownloadAppsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [showInstallHelp, setShowInstallHelp] = useState(false);

  useEffect(() => {
    if (!open) setShowInstallHelp(false);
  }, [open]);

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName={utilityClassName("max-w-[48rem]")}>
        <Modal.Header
          title={
            showInstallHelp ? (
              <span
                {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap1)}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<IconChevronLeft size={18} />}
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.Ml1,
                    sx.size7,
                    sx.shrink0,
                  )}
                  onClick={() => setShowInstallHelp(false)}
                  aria-label="Back to apps"
                />
                <span {...stylex.props(sx.truncate)}>Install the web app</span>
              </span>
            ) : (
              "Download apps"
            )
          }
        />
        <DownloadAppsBody
          showInstallHelp={showInstallHelp}
          onShowInstallHelp={() => setShowInstallHelp(true)}
        />
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * The two app cards, or the three PWA steps once the web card is picked. Split
 * out of the dialog so Settings › Downloads can host the same thing inline —
 * one description of what you can install, two places to reach it.
 */
export function DownloadAppsBody({
  showInstallHelp,
  onShowInstallHelp,
}: {
  showInstallHelp: boolean;
  onShowInstallHelp: () => void;
}) {
  const [theme, setTheme] = useState(effectiveTheme);
  useEffect(() => onThemeChanged(() => setTheme(effectiveTheme())), []);
  const backgroundName =
    theme === "dark" ? "download-background-dark" : "download-background";

  if (showInstallHelp)
    return (
      <div
        {...stylex.props(
          sx.grid,
          sx.minH0,
          sx.flex1,
          sx.gap3,
          sx.desktopGridCols3,
        )}
      >
        <InstallStep number="1" title="Open in your browser">
          Use Safari on iPhone or iPad, or Chrome on Android and desktop.
        </InstallStep>
        <InstallStep number="2" title="Open the browser menu">
          On iPhone or iPad, tap Share. Elsewhere, open the browser menu.
        </InstallStep>
        <InstallStep number="3" title="Add Open Session">
          Choose Add to Home Screen, Install app, or Add to Dock.
        </InstallStep>
      </div>
    );

  return (
    <div
      {...stylex.props(
        sx.grid,
        sx.minH0,
        sx.flex1,
        sx.gap4,
        sx.desktopGridCols3fr2fr,
      )}
    >
      <AppCard
        preview={
          <div
            {...stylex.props(
              sx.relative,
              sx.hFull,
              sx.overflowHidden,
              sx.bgCover,
              sx.bgCenter,
              sx.pl5,
              sx.pt5,
            )}
            style={{
              backgroundImage: `url(${BASE_PATH}/${backgroundName}.webp)`,
            }}
          >
            <img
              src={`${BASE_PATH}/download-mac.webp`}
              alt="Open Session running on Mac"
              {...mergeStylexProps(
                "outline outline-1",
                sx.hFull,
                sx.wFull,
                sx.roundedTlLg,
                sx.objectCover,
                sx.objectLeftTop,
                sx.OutlineOffset1,
                sx.outlineBlack10,
              )}
            />
            <div
              {...mergeStylexProps(
                "bg-gradient-to-b from-transparent to-surface",
                sx.pointerEventsNone,
                sx.absolute,
                sx.insetX0,
                sx.bottom0,
                sx.h13,
              )}
            />
          </div>
        }
        title="Open Session for Mac"
        subtitle="Apple silicon"
      >
        <Button
          variant="primary"
          size="lg"
          icon={<IconApple size={20} />}
          className={mergeStylexOverrideClassName("", sx.minH10, sx.wFull)}
          render={
            <a
              href={`${BASE_PATH}/api/packages/clients/mac/download/latest.dmg`}
            />
          }
        >
          Download
        </Button>
      </AppCard>

      <AppCard
        preview={
          <div
            {...stylex.props(
              sx.relative,
              sx.flex,
              sx.hFull,
              sx.justifyCenter,
              sx.overflowHidden,
              sx.bgCover,
              sx.bgCenter,
              sx.px3,
              sx.pt6,
            )}
            style={{
              backgroundImage: `url(${BASE_PATH}/${backgroundName}.webp)`,
            }}
          >
            <img
              src={`${BASE_PATH}/download-phone.webp`}
              alt="Open Session installed as a phone web app"
              {...stylex.props(
                sx.relative,
                sx.z10,
                sx.h130,
                sx.wAuto,
                sx.maxWNone,
                sx.originTop,
                sx.rounded2xl,
                sx.objectContain,
                sx.objectTop,
                sx.smoothShadowLg,
              )}
            />
            <div
              {...mergeStylexProps(
                "bg-gradient-to-b from-transparent to-surface",
                sx.pointerEventsNone,
                sx.absolute,
                sx.insetX0,
                sx.bottom0,
                sx.z20,
                sx.h13,
              )}
            />
          </div>
        }
        title="Web"
        subtitle="Install as a PWA"
      >
        <Button
          variant="soft"
          size="lg"
          className={mergeStylexOverrideClassName("", sx.minH10, sx.wFull)}
          onClick={onShowInstallHelp}
        >
          How to install
        </Button>
      </AppCard>
    </div>
  );
}

function AppCard({
  preview,
  title,
  subtitle,
  children,
}: {
  preview: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section
      {...stylex.props(
        sx.flex,
        sx.h20rem,
        sx.flexCol,
        sx.overflowHidden,
        sx.roundedCalc22pxVarRf,
        sx.bgSurface,
        sx.desktopH22rem,
      )}
    >
      <div {...stylex.props(sx.minH0, sx.flex1)}>{preview}</div>
      <div
        {...stylex.props(
          sx.relative,
          sx.z10,
          sx.flex,
          sx.shrink0,
          sx.flexCol,
          sx.px4,
          sx.pb4,
          sx.desktopPx5,
          sx.desktopPb5,
        )}
      >
        <h3
          {...stylex.props(
            sx.m0,
            sx.fontSemibold,
            sx.leadingTight,
            sx.textFg,
            typography.sectionTitle,
          )}
        >
          {title}
        </h3>
        <p
          {...stylex.props(
            sx.mb4,
            sx.mt1,
            sx.fontMedium,
            sx.textDim,
            typography.body,
          )}
        >
          {subtitle}
        </p>
        {children}
      </div>
    </section>
  );
}

function InstallStep({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      {...stylex.props(
        sx.flex,
        sx.minH48,
        sx.flexCol,
        sx.roundedXl,
        sx.bgPanel,
        sx.p5,
        sx.desktopMinH60,
      )}
    >
      <div
        {...stylex.props(
          sx.mbAuto,
          sx.flex,
          sx.size10,
          sx.itemsCenter,
          sx.justifyCenter,
          sx.roundedControl,
          sx.bgAccent,
          sx.fontSemibold,
          sx.textOnAccent,
          typography.body,
        )}
      >
        {number}
      </div>
      <h3
        {...stylex.props(
          sx.mb1,
          sx.mt6,
          sx.fontSemibold,
          sx.leadingTight,
          sx.textFg,
          typography.sectionTitle,
        )}
      >
        {title}
      </h3>
      <p
        {...stylex.props(
          sx.m0,
          sx.fontNormal,
          sx.leadingRelaxed,
          sx.textDim,
          typography.body,
        )}
      >
        {children}
      </p>
    </section>
  );
}
