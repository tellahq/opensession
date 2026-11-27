import { stripBasePath } from "./base";

export function isDesignSystemRoute(pathname: string): boolean {
  const path = stripBasePath(pathname).replace(/\/+$/, "") || "/";
  return path === "/design-system";
}

export interface SurfaceSpecimen {
  readonly token: string;
  readonly role: string;
  readonly swatchClass: string;
}

export const SURFACE_SPECIMENS: readonly SurfaceSpecimen[] = [
  {
    token: "bg-surface",
    role: "L0 page canvas",
    swatchClass: "bg-surface border border-divider",
  },
  {
    token: "bg-raised",
    role: "L1 sidebar & top bar chrome",
    swatchClass: "bg-raised",
  },
  {
    token: "bg-panel",
    role: "L2 borderless cards & tool rows",
    swatchClass: "bg-panel",
  },
  {
    token: "bg-panel-surface",
    role: "Right side-panel column",
    swatchClass: "bg-panel-surface border border-divider-soft",
  },
  {
    token: "bg-settings-plate",
    role: "Settings group + border-divider-soft",
    swatchClass: "bg-settings-plate border border-divider-soft",
  },
  {
    token: "bg-control",
    role: "L3 inputs, chips, option rows",
    swatchClass: "bg-control border border-line",
  },
  {
    token: "bg-popup",
    role: "Floating popup + smooth-shadow-ring-md",
    swatchClass:
      "bg-popup [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-md",
  },
  {
    token: "bg-popup-glass",
    role: "Glass popup + var(--popup-blur)",
    swatchClass:
      "bg-popup-glass [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-md",
  },
  {
    token: "bg-bubble-user",
    role: "User prompt bubble wash",
    swatchClass: "bg-bubble-user",
  },
  {
    token: "bg-code-well",
    role: "Code / tool output well",
    swatchClass: "bg-code-well border border-code-well-line text-code-well-ink",
  },
];

export interface TypeSpecimen {
  readonly token: string;
  readonly sizes: string;
  readonly sample: string;
  readonly sampleClass: string;
}

export const TYPE_SPECIMENS: readonly TypeSpecimen[] = [
  {
    token: "text-stat",
    sizes: "28 / 34",
    sample: "1,428",
    sampleClass: "text-stat font-title tabular-nums text-fg",
  },
  {
    token: "text-page-title font-title",
    sizes: "24 / 28",
    sample: "Design system",
    sampleClass: "text-page-title font-title tracking-title text-fg",
  },
  {
    token: "text-section-title font-title",
    sizes: "19 / 24",
    sample: "Section heading",
    sampleClass: "text-section-title font-title text-fg",
  },
  {
    token: "text-dialog-title font-title",
    sizes: "17 / 19",
    sample: "Dialog or sheet title",
    sampleClass: "text-dialog-title font-title text-fg",
  },
  {
    token: "text-body",
    sizes: "15 / 17",
    sample: "Readable body prose for transcripts, descriptions, and help copy.",
    sampleClass: "text-body text-fg",
  },
  {
    token: "text-item-title",
    sizes: "14 / 15",
    sample: "Scannable list row title",
    sampleClass: "text-item-title font-medium text-fg",
  },
  {
    token: "text-label",
    sizes: "13 / 14",
    sample: "Control label and supporting metadata",
    sampleClass: "text-label text-dim",
  },
  {
    token: "text-meta",
    sizes: "11 / 13",
    sample: "2m ago · 4 checks passed",
    sampleClass: "text-meta text-faint",
  },
];

export interface RadiusSpecimen {
  readonly token: string;
  readonly px: string;
  readonly radiusClass: string;
}

export const RADIUS_SPECIMENS: readonly RadiusSpecimen[] = [
  { token: "rounded-sm", px: "4px", radiusClass: "rounded-sm" },
  { token: "rounded-md", px: "7px", radiusClass: "rounded-md" },
  { token: "rounded-control", px: "12px", radiusClass: "rounded-control" },
  { token: "rounded-lg", px: "14px", radiusClass: "rounded-lg" },
  { token: "rounded-popup", px: "16px", radiusClass: "rounded-popup" },
  { token: "rounded-xl", px: "18px", radiusClass: "rounded-xl" },
  { token: "rounded-2xl", px: "22px", radiusClass: "rounded-2xl" },
  {
    token: "rounded-[999px]",
    px: "squircle pill",
    radiusClass: "rounded-[999px]",
  },
  { token: "rounded-full", px: "true pill", radiusClass: "rounded-full" },
];

export const SHADOW_SPECIMENS: readonly {
  readonly token: string;
  readonly role: string;
  readonly className: string;
}[] = [
  {
    token: "smooth-shadow-xs",
    role: "Controls in the page",
    className: "rounded-control border border-line bg-button smooth-shadow-xs",
  },
  {
    token: "smooth-shadow-sm",
    role: "Compact floating pills",
    className: "rounded-popup bg-popup smooth-shadow-sm",
  },
  {
    token: "smooth-shadow-ring-md",
    role: "Menus, popovers, hover cards",
    className:
      "rounded-popup bg-popup [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-md",
  },
  {
    token: "smooth-shadow-ring-lg",
    role: "Dialogs & command palette",
    className:
      "rounded-2xl bg-popup [--smooth-ring-color:var(--dialog-ring)] smooth-shadow-ring-lg",
  },
];
