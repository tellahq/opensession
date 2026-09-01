export const ACCENT_THEME_OPTIONS = [
  { value: "sky", label: "Sky", light: "#1d82bc", dark: "#2495d6" },
  { value: "indigo", label: "Indigo", light: "#366ef5", dark: "#5386f6" },
  { value: "coral", label: "Coral", light: "#dd233a", dark: "#f73648" },
  { value: "orange", label: "Tangerine", light: "#d3571c", dark: "#eb6221" },
  { value: "lime", label: "Honey", light: "#eec75c", dark: "#eec75c" },
  { value: "green", label: "Clover", light: "#1e8e45", dark: "#24a351" },
  { value: "mono", label: "Black", light: "#000000", dark: "#ffffff" },
] as const;

export type AccentTheme = (typeof ACCENT_THEME_OPTIONS)[number]["value"];

export const DEFAULT_ACCENT_THEME: AccentTheme = "sky";

export function isAccentTheme(value: unknown): value is AccentTheme {
  return ACCENT_THEME_OPTIONS.some((option) => option.value === value);
}

export function getAccentThemeOption(value: AccentTheme) {
  return (
    ACCENT_THEME_OPTIONS.find((option) => option.value === value) ??
    ACCENT_THEME_OPTIONS[0]
  );
}
