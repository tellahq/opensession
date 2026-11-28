import React, { useEffect, useState } from "react";
import { IconCheck } from "../icons";
import { useIsPhone } from "../../hooks/useIsPhone";
import {
  ACCENT_THEME_OPTIONS,
  getAccentTheme,
  getAccentThemeOption,
  getOnAccentInk,
  onAccentThemeChanged,
  setAccentTheme,
  type AccentTheme,
} from "../../lib/accent-theme";
import {
  getDiffPalette,
  onDiffPaletteChanged,
  setDiffPalette,
  type DiffPalette,
} from "../../lib/diff-palette";
import { setNewLayoutPref, useNewLayoutPref } from "../../lib/new-layout-pref";
import {
  getThemePref,
  effectiveTheme,
  onThemeChanged,
  setThemePref,
  type ThemePref,
} from "../../lib/theme";
import {
  SettingCard,
  SettingsGroupLabel,
  SettingsSection,
} from "../../ui/settings";
import { Switch } from "../../ui/switch";
import { Tooltip } from "../../ui/tooltip";
import { SettingRow } from "./shared";

// The look of the app, at the top of Settings → Preferences.

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type ThemeMockStyle = React.CSSProperties & {
  "--mk-bg": string;
  "--mk-panel": string;
  "--mk-line": string;
  "--mk-pill": string;
};

type AccentSwatchStyle = React.CSSProperties & {
  "--swatch": string;
  "--swatch-ink": string;
};

/**
 * Fixed palettes for the miniature mockup below, deliberately raw values
 * rather than theme tokens, because each swatch has to keep showing its own
 * tone no matter which theme is active. Applied as custom properties so the
 * mock's parts can stay plain utilities.
 */
const MOCK_PALETTE: Record<"light" | "dark", ThemeMockStyle> = {
  light: {
    "--mk-bg": "#e9e9e9",
    "--mk-panel": "#ffffff",
    "--mk-line": "#d5d5d5",
    "--mk-pill": "#cbcbcb",
  },
  dark: {
    "--mk-bg": "#565656",
    "--mk-panel": "#3e3e3e",
    "--mk-line": "#c4c4c4",
    "--mk-pill": "#8a8a8a",
  },
};

// A miniature app mockup used inside the theme swatches. Its proportions are
// percentages of the swatch rather than scale steps: it is an illustration
// that has to rescale with the card, not a piece of chrome on the grid.
function ThemeMock({ tone }: { tone: "light" | "dark" }) {
  return (
    <div
      className="absolute inset-0 bg-(--mk-bg) pt-[15%]"
      style={MOCK_PALETTE[tone]}
    >
      <div className="mb-[9px] flex flex-col items-center gap-[5px]">
        <div className="h-1.5 w-[56%] rounded-sm bg-(--mk-pill)" />
        <div className="h-1.5 w-[42%] rounded-sm bg-(--mk-pill) opacity-65" />
      </div>
      <div className="mr-[9%] ml-[14%] flex h-[56%] flex-col gap-2 rounded-t-md bg-(--mk-panel) px-3 py-[11px]">
        <div className="h-1.5 w-[68%] rounded-xs bg-(--mk-line)" />
        <div className="h-1.5 w-[84%] rounded-xs bg-(--mk-line)" />
        <div className="h-1.5 w-[56%] rounded-xs bg-(--mk-line)" />
      </div>
    </div>
  );
}

function ThemeCard({
  option,
  active,
  onClick,
}: {
  option: ThemePref;
  active: boolean;
  onClick: () => void;
}) {
  const label = THEME_OPTIONS.find((o) => o.value === option)?.label ?? option;
  return (
    // Selection reads off `data-active` rather than an `.active` class so the
    // swatch and label can style themselves with group-data-* variants. The
    // old rules were compound selectors (`.theme-card.active .theme-swatch`),
    // which outrank a single utility: leaving the class here would have let
    // it keep winning against everything below.
    <button
      className="group flex w-20 cursor-pointer flex-col items-center gap-2.5 border-none bg-transparent p-0 desktop:w-28"
      role="radio"
      aria-checked={active}
      data-active={active || undefined}
      onClick={onClick}
    >
      <div className="relative aspect-16/10 w-full overflow-hidden rounded-control border-2 border-line transition-[border-color,box-shadow] group-hover:border-faint group-data-active:border-accent group-data-active:shadow-[0_0_0_1px_var(--accent)]">
        {/* System = light base with the dark mock clipped over the right half. */}
        <ThemeMock tone={option === "dark" ? "dark" : "light"} />
        {option === "system" && (
          <div className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
            <ThemeMock tone="dark" />
          </div>
        )}
      </div>
      <span className="text-label text-dim group-data-active:font-semibold group-data-active:text-fg">
        {label}
      </span>
    </button>
  );
}

function AccentSwatch({
  theme,
  active,
  tone,
  onClick,
}: {
  theme: AccentTheme;
  active: boolean;
  tone: "light" | "dark";
  onClick: () => void;
}) {
  const option = getAccentThemeOption(theme);
  const swatch = option[tone];
  const ink = getOnAccentInk(theme, tone);
  const style: AccentSwatchStyle = {
    "--swatch": swatch,
    "--swatch-ink": ink,
  };

  return (
    <Tooltip label={option.label}>
      <label
        className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md p-1"
        style={style}
      >
        <input
          type="radio"
          name="accent-theme"
          value={theme}
          checked={active}
          onChange={onClick}
          aria-label={option.label}
          className="peer sr-only"
        />
        <span className="flex size-8 items-center justify-center rounded-full border border-line bg-[linear-gradient(135deg,color-mix(in_srgb,var(--swatch)_97%,white),color-mix(in_srgb,var(--swatch)_94%,black))] text-(--swatch-ink) outline-offset-4 transition-[scale,box-shadow] duration-micro active:scale-press peer-checked:shadow-[0_0_0_2px_var(--bg-raised),0_0_0_4px_var(--swatch)] peer-focus-visible:outline-2 peer-focus-visible:outline-accent-ink">
          {active && <IconCheck size={20} strokeWidth={2.4} />}
        </span>
      </label>
    </Tooltip>
  );
}

/**
 * Theme and accent, in one card. They are the same decision taken twice, how
 * the app looks, so they share a heading instead of standing as two sections
 * a scroll apart.
 */
export function AppearanceSection() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  const [tone, setTone] = useState(effectiveTheme);
  useEffect(
    () =>
      onThemeChanged(() => {
        setPref(getThemePref());
        setTone(effectiveTheme());
      }),
    [],
  );
  const [accent, setAccent] = useState<AccentTheme>(getAccentTheme);
  useEffect(() => onAccentThemeChanged(() => setAccent(getAccentTheme())), []);
  const newLayout = useNewLayoutPref();
  const isPhone = useIsPhone();
  const [diffPalette, setDiffPaletteState] =
    useState<DiffPalette>(getDiffPalette);
  useEffect(
    () => onDiffPaletteChanged(() => setDiffPaletteState(getDiffPalette())),
    [],
  );

  return (
    <>
      <SettingsGroupLabel>Theme</SettingsGroupLabel>
      <SettingsSection>
        <div
          className="flex justify-start gap-3 desktop:gap-4"
          role="radiogroup"
          aria-label="Theme"
        >
          {THEME_OPTIONS.map((o) => (
            <ThemeCard
              key={o.value}
              option={o.value}
              active={pref === o.value}
              onClick={() => {
                setThemePref(o.value);
                setPref(o.value);
              }}
            />
          ))}
        </div>
        <div className="mt-5">
          <div className="mb-2 text-control-label font-medium text-faint">
            Accent
          </div>
          <div
            // Keep the seven 44px targets together instead of stretching them
            // across the plate. They wrap only when the viewport cannot hold
            // the full group without shrinking its touch targets.
            className="flex w-fit max-w-full flex-wrap gap-y-1"
            role="radiogroup"
            aria-label="Accent colour"
          >
            {ACCENT_THEME_OPTIONS.map((option) => (
              <AccentSwatch
                key={option.value}
                theme={option.value}
                active={accent === option.value}
                tone={tone}
                onClick={() => {
                  setAccentTheme(option.value);
                  setAccent(option.value);
                }}
              />
            ))}
          </div>
        </div>
      </SettingsSection>
      <div className="mt-3">
        <SettingCard>
          <SettingRow
            title="Color-blind diffs"
            desc="Blue and orange instead of green and red."
            control={
              <Switch
                aria-label="Color-blind diffs"
                checked={diffPalette === "colorblind"}
                onCheckedChange={(checked) => {
                  const next: DiffPalette = checked ? "colorblind" : "default";
                  setDiffPalette(next);
                  setDiffPaletteState(next);
                }}
              />
            }
          />
          {!isPhone && (
            <SettingRow
              title="New layout"
              desc="Places in a minibar."
              control={
                <Switch
                  aria-label="New layout"
                  checked={newLayout}
                  onCheckedChange={setNewLayoutPref}
                />
              }
            />
          )}
        </SettingCard>
      </div>
    </>
  );
}
