// "Compact sidebar" — the rail's vertical scale. Default keeps the 36px full
// line documented in lib/sidebar-classes.ts; compact tightens the same rows to
// 30px (and captions, band slots and group gaps with them) so more workspaces
// fit on screen. Nothing is removed or resized sideways: the 22px leading rail,
// the type and every mark stay put, so the column reads the same, just closer
// together.
//
// Desktop only. A phone row is a tap target, not a reading height, so the
// phone layout keeps its own padding throughout (see SIDEBAR_DENSITY_VARS,
// where the compact values are gated on `desktop:`).
//
// Stored per user through the ui-prefs map rather than per browser: someone who
// reads dense lists reads them dense everywhere, and the section order sitting
// in the same settings card already follows them across devices.

import { IconDensityCompact, IconDensityDefault } from "../components/icons";
import { makeUserPref } from "./user-pref";

export type SidebarDensity = "default" | "compact";

/**
 * The two settings as both surfaces offer them — the sidebar's filter menu and
 * Settings → Preferences. One list, so the label and the mark can't drift into
 * saying different things about the same preference in two places.
 *
 * The glyph is the thing the setting changes: rows in a list, the same band
 * filled by three lines or four. See components/icons.tsx.
 */
export const DENSITY_OPTIONS: {
  value: SidebarDensity;
  label: string;
  Icon: typeof IconDensityDefault;
}[] = [
  { value: "default", label: "Default", Icon: IconDensityDefault },
  { value: "compact", label: "Compact", Icon: IconDensityCompact },
];

const pref = makeUserPref<SidebarDensity>({
  localKey: "opensession-sidebar-density",
  prefKey: "sidebar-density",
  changeEvent: "opensession-sidebar-density-changed",
  defaultValue: "default",
  decode: (v) => (v === "compact" || v === "default" ? v : null),
  encode: (v) => v,
});

export const getSidebarDensity = pref.get;
export const setSidebarDensity = pref.set;
export const onSidebarDensityChanged = pref.onChanged;
