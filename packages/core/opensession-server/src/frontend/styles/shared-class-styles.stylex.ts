/**
 * StyleX declarations used by legacy shared class-string maps.
 *
 * These are the remaining utilities the mechanical conversion could not see
 * through an imported class constant. Keep them as compiled styles so cn()
 * can resolve conflicts across shared maps instead of falling back to CSS
 * source order.
 */
import * as stylex from "@stylexjs/stylex";

export const sharedClassStyles = stylex.create({
  activeBgColorMixInSrgbCurrentColor18Transparent: {
    ":active": {
      backgroundColor: "color-mix(in srgb,currentColor 18%,transparent)",
    },
  },
  beforeWebkitMaskImageLinearGradientToTopVarColorBlack0VarColorBlack62Transparent100:
    {
      "::before": {
        content: '""',
        WebkitMaskImage:
          "linear-gradient(to top,var(--color-black) 0%,var(--color-black) 62%,transparent 100%)",
      },
    },
  beforeBackgroundLinearGradientToTopColorMixInSrgbVarBg88Transparent0ColorMixInSrgbVarBg76Transparent55ColorMixInSrgbVarBg45Transparent78Transparent100:
    {
      "::before": {
        content: '""',
        background:
          "linear-gradient(to top,color-mix(in srgb,var(--bg) 88%,transparent) 0%,color-mix(in srgb,var(--bg) 76%,transparent) 55%,color-mix(in srgb,var(--bg) 45%,transparent) 78%,transparent 100%)",
      },
    },
  beforeCornerShapeVarCs: {
    "::before": { content: '""', cornerShape: "var(--cs)" },
  },
  beforeMaskImageLinearGradientToTopVarColorBlack0VarColorBlack62Transparent100:
    {
      "::before": {
        content: '""',
        maskImage:
          "linear-gradient(to top,var(--color-black) 0%,var(--color-black) 62%,transparent 100%)",
      },
    },
  beforeAbsolute: { "::before": { content: '""', position: "absolute" } },
  beforeBgLinearGradientToBottomTransparent0VarBg48: {
    "::before": {
      content: '""',
      backgroundImage:
        "linear-gradient(to bottom,transparent 0%,var(--bg) 48%)",
    },
  },
  beforeContent: { "::before": { content: '""' } },
  beforeInset1: { "::before": { content: '""', inset: "4px" } },
  beforeRoundedControl: {
    "::before": { content: '""', borderRadius: "calc(12px * var(--rf))" },
  },
  beforeTransitionBackgroundBoxShadow: {
    "::before": { content: '""', transitionProperty: "background, box-shadow" },
  },
  beforeZ0: { "::before": { content: '""', zIndex: 0 } },
  bgColorMixInSrgbVarAccent18Transparent: {
    backgroundColor: "color-mix(in srgb,var(--accent) 18%,transparent)",
  },
  bgColorMixInSrgbVarBg92Transparent: {
    backgroundColor: "color-mix(in srgb,var(--bg) 92%,transparent)",
  },
  bgColorMixInSrgbVarGreen11Transparent: {
    backgroundColor: "color-mix(in srgb,var(--green) 11%,transparent)",
  },
  bgColorMixInSrgbVarPurple10Transparent: {
    backgroundColor: "color-mix(in srgb,var(--purple) 10%,transparent)",
  },
  bgColorMixInSrgbVarRed11Transparent: {
    backgroundColor: "color-mix(in srgb,var(--red) 11%,transparent)",
  },
  bgColorMixInSrgbVarTabColor22VarBgPanel: {
    backgroundColor: "color-mix(in srgb,var(--tab-color) 22%,var(--bg-panel))",
  },
  bgColorMixInSrgbVarTabColor9Transparent: {
    backgroundColor: "color-mix(in srgb,var(--tab-color) 9%,transparent)",
  },
  bgColorMixInSrgbVarYellow10Transparent: {
    backgroundColor: "color-mix(in srgb,var(--yellow) 10%,transparent)",
  },
  bgColorMixInSrgbVarYellow9Transparent: {
    backgroundColor: "color-mix(in srgb,var(--yellow) 9%,transparent)",
  },
  desktopPlCalcVarSidebarIconLeft16pxVarSidebarNavX6px: {
    paddingLeft: {
      default: null,
      "@media (min-width: 721px)":
        "calc(var(--sidebar-icon-left,16px) - var(--sidebar-nav-x,6px))",
    },
  },
  hoverBeforeBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        "::before": { content: '""', backgroundColor: "var(--hover)" },
      },
    },
  },
  hoverBgColorMixInSrgbCurrentColor12Transparent: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "color-mix(in srgb,currentColor 12%,transparent)",
      },
    },
  },
  hoverBgColorMixInSrgbVarTabColor16Transparent: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "color-mix(in srgb,var(--tab-color) 16%,transparent)",
      },
    },
  },
  hoverBgColorMixInSrgbVarTabColor28VarBgPanel: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor:
          "color-mix(in srgb,var(--tab-color) 28%,var(--bg-panel))",
      },
    },
  },
  hoverBgImageLinearGradientVarHoverVarHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundImage: "linear-gradient(var(--hover),var(--hover))",
      },
    },
  },
  leftCalc1VarComposerInsetLeft17px: {
    left: "calc(-1 * var(--composer-inset-left,17px))",
  },
  minHCalcEnvSafeAreaInsetTop0px52px: {
    minHeight: "calc(env(safe-area-inset-top,0px) + 52px)",
  },
  pbCalcVarSessionUnderVarSuggestionsUnder0px16px: {
    paddingBottom:
      "calc(var(--session-under) + var(--suggestions-under,0px) + 16px)",
  },
  pbMax16pxEnvSafeAreaInsetBottom0px: {
    paddingBottom: "max(16px,env(safe-area-inset-bottom,0px))",
  },
  phoneBeforeWebkitMaskImageLinearGradientToBottomVarColorBlack0VarColorBlack62Transparent100:
    {
      "@media (max-width: 720px)": {
        "::before": {
          content: '""',
          WebkitMaskImage:
            "linear-gradient(to bottom,var(--color-black) 0%,var(--color-black) 62%,transparent 100%)",
        },
      },
    },
  phoneBeforeBackgroundLinearGradientToBottomVarBg0ColorMixInSrgbVarBg55Transparent52ColorMixInSrgbVarBg18Transparent78Transparent100:
    {
      "@media (max-width: 720px)": {
        "::before": {
          content: '""',
          background:
            "linear-gradient(to bottom,var(--bg) 0%,color-mix(in srgb,var(--bg) 55%,transparent) 52%,color-mix(in srgb,var(--bg) 18%,transparent) 78%,transparent 100%)",
        },
      },
    },
  phoneBeforeMaskImageLinearGradientToBottomVarColorBlack0VarColorBlack62Transparent100:
    {
      "@media (max-width: 720px)": {
        "::before": {
          content: '""',
          maskImage:
            "linear-gradient(to bottom,var(--color-black) 0%,var(--color-black) 62%,transparent 100%)",
        },
      },
    },
  phoneBgColorMixInSrgbVarTabColor22VarMobileTabSurfaceSelected: {
    backgroundColor: {
      default: null,
      "@media (max-width: 720px)":
        "color-mix(in srgb,var(--tab-color) 22%,var(--mobile-tab-surface-selected))",
    },
  },
  phoneBgColorMixInSrgbVarTabColor9VarMobileTabSurface: {
    backgroundColor: {
      default: null,
      "@media (max-width: 720px)":
        "color-mix(in srgb,var(--tab-color) 9%,var(--mobile-tab-surface))",
    },
  },
  phoneGridCols22px24pxMinmax01fr44px: {
    gridTemplateColumns: {
      default: null,
      "@media (max-width: 720px)": "22px 24px minmax(0,1fr) 44px",
    },
  },
  phoneGridCols24pxMinmax01fr44px: {
    gridTemplateColumns: {
      default: null,
      "@media (max-width: 720px)": "24px minmax(0,1fr) 44px",
    },
  },
  phonePtCalcVarPaneHeaderHVarStripClearance0px: {
    paddingTop: {
      default: null,
      "@media (max-width: 720px)":
        "calc(var(--pane-header-h) + var(--strip-clearance,0px))",
    },
  },
  phonePtCalcVarPaneHeaderHVarStripClearance0px8px: {
    paddingTop: {
      default: null,
      "@media (max-width: 720px)":
        "calc(var(--pane-header-h) + var(--strip-clearance,0px) + 8px)",
    },
  },
  phoneTopCalcVarPaneHeaderHVarStripClearance0px8px: {
    top: {
      default: null,
      "@media (max-width: 720px)":
        "calc(var(--pane-header-h) + var(--strip-clearance,0px) + 8px)",
    },
  },
  phoneTransitionHeightPaddingTopOpacityTransform: {
    transitionProperty: {
      default: null,
      "@media (max-width: 720px)": "height, padding-top, opacity, transform",
    },
  },
  plCalcVarSidebarIconLeft16pxVarSidebarNavX6px: {
    paddingLeft:
      "calc(var(--sidebar-icon-left,16px) - var(--sidebar-nav-x,6px))",
  },
  textColorMixInSrgbVarText881f9e8a: {
    color: "color-mix(in srgb,var(--text) 88%,#1f9e8a)",
  },
  transitionBackgroundColorColor: {
    transitionProperty: "background-color, color",
  },
  transitionOpacityTranslate: { transitionProperty: "opacity, translate" },
  translateXCalc50VarWsSummaryStep0px: {
    translate: "calc(-50% + var(--ws-summary-step,0px)) 0",
  },
  wCalcVarSplitPreviewShare5012px: {
    width: "calc(var(--split-preview-share,50%) - 12px)",
  },
  bgBlack: { backgroundColor: "var(--color-black)" },
  bgBlack85: { backgroundColor: "rgb(0 0 0 / 85%)" },
  bgSurface: { backgroundColor: "var(--bg)" },
  bgTransparent: { backgroundColor: "transparent" },
  h100dvh: { height: "100dvh" },
  hMin820px78vh: { height: "min(820px,78vh)" },
  hMin820px85vh: { height: "min(820px,85vh)" },
  maxH88dvh: { maxHeight: "88dvh" },
  maxHNone: { maxHeight: "none" },
  maxW25rem: { maxWidth: "25rem" },
  maxW28rem: { maxWidth: "28rem" },
  maxW30rem: { maxWidth: "30rem" },
  maxW31rem: { maxWidth: "31rem" },
  maxW32rem: { maxWidth: "32rem" },
  maxW34rem: { maxWidth: "34rem" },
  maxW40rem: { maxWidth: "40rem" },
  maxW42rem: { maxWidth: "42rem" },
  maxWNone: { maxWidth: "none" },
  overflowVisible: { overflow: "visible" },
  phoneItemsEnd: {
    alignItems: { default: null, "@media (max-width: 720px)": "flex-end" },
  },
  phonePb1: {
    paddingBottom: { default: null, "@media (max-width: 720px)": "4px" },
  },
  phonePbVarKbInset0px: {
    paddingBottom: {
      default: null,
      "@media (max-width: 720px)": "var(--kb-inset,0px)",
    },
  },
  phonePl2: {
    paddingLeft: { default: null, "@media (max-width: 720px)": "8px" },
  },
  phonePr05: {
    paddingRight: { default: null, "@media (max-width: 720px)": "2px" },
  },
  phonePt3: {
    paddingTop: { default: null, "@media (max-width: 720px)": "12px" },
  },
  phonePx0: {
    paddingInline: { default: null, "@media (max-width: 720px)": "0" },
  },
  phonePx2: {
    paddingInline: { default: null, "@media (max-width: 720px)": "8px" },
  },
  phonePy13px: {
    paddingBlock: { default: null, "@media (max-width: 720px)": "13px" },
  },
  phoneWFull: { width: { default: null, "@media (max-width: 720px)": "100%" } },
  sidebarSkeletonRowPadding: {
    paddingInline: { default: "10px", "@media (max-width: 720px)": "8px" },
    paddingBlock: { default: "9px", "@media (max-width: 720px)": "13px" },
  },
  pt2: { paddingTop: "8px" },
  px25: { paddingInline: "10px" },
  px3: { paddingInline: "12px" },
  py18px: { paddingBlock: "18px" },
  py9px: { paddingBlock: "9px" },
  rounded999px: { borderRadius: "999px", cornerShape: "var(--cs)" },
  roundedVarComposerRadius: {
    borderRadius: "var(--composer-radius)",
    cornerShape: "var(--cs)",
  },
  roundedNone: { borderRadius: "0", cornerShape: "var(--cs)" },
  top0: { top: "0" },
  wMin1120px84vw: { width: "min(1120px,84vw)" },
  wMin1280px92vw: { width: "min(1280px,92vw)" },
  wMin420pxCalc100vw32px: { width: "min(420px,calc(100vw - 32px))" },
  wMin640px100: { width: "min(640px,100%)" },
  wMin650px100: { width: "min(650px,100%)" },
  wMin720px100: { width: "min(720px,100%)" },
  wMin820px100: { width: "min(820px,100%)" },
  wMin820px100PhoneFull: {
    width: {
      default: "min(820px,100%)",
      "@media (max-width: 720px)": "100%",
    },
  },
  z2147483646: { zIndex: 2147483646 },
});
