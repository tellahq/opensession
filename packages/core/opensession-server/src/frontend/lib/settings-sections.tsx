import React from "react";
import * as IconLibrary from "../components/icons";
import {
  IconArchive,
  IconBandAid,
  IconBell,
  IconBook,
  IconBox,
  IconBranches,
  IconClock,
  IconConnections,
  IconDatabase,
  IconFileText2,
  IconHome,
  IconGlobe,
  IconKeyboard,
  IconPalette,
  IconPeople,
  IconRocket,
  IconServer,
  IconShieldCheck,
  IconSliders,
  IconTarget,
  IconUser,
} from "../components/icons";
import { SETTINGS_KEYWORDS } from "./settings-search";

const IconProviders = IconLibrary["IconShapes"];

// The Settings nav table, kept here rather than inside Settings.tsx so that it
// is data anyone can read. It has two consumers now: the Settings surface
// itself, and the command palette, which used to carry its own hand-written
// list of places to go and so could only reach three of these sections. One
// table, two surfaces, no drift.

/** Tool surfaces hosted inside Settings — App renders their panel as children. */
export type ToolSectionKey = "automations" | "goals" | "security";

/** Listed in nav order (SECTIONS below). */
export type SettingsSectionKey =
  | "myAccounts"
  | "preferences"
  | "appearance"
  | "notifications"
  | "shortcuts"
  | "general"
  | "members"
  | "repos"
  | "providers"
  | "connections"
  | "library"
  | "memory"
  | "sandboxes"
  | "runners"
  | "ingress"
  | "storage"
  | "deploys"
  | "papercuts"
  | "audit"
  | ToolSectionKey;

export const TOOL_SECTIONS = new Set<SettingsSectionKey>([
  "automations",
  "goals",
  "security",
]);

/** The tabs across the top of Settings: yours alone, what everyone in the
 *  organization shares, and the machines it runs on. */
export type SettingsScope = "personal" | "organization" | "server";

export const SCOPES: { key: SettingsScope; label: string }[] = [
  { key: "personal", label: "Personal" },
  { key: "organization", label: "Organization" },
  { key: "server", label: "Server" },
];

export function scopeLabel(scope: SettingsScope): string {
  return SCOPES.find((entry) => entry.key === scope)?.label ?? "";
}

interface SettingsSection {
  key: SettingsSectionKey;
  label: string;
  scope: SettingsScope;
  /** A caption inside the tab, for a tab with more than one run of rows. */
  group?: string;
  icon: React.ReactElement<{ size?: number }>;
}

export const SECTIONS: SettingsSection[] = [
  {
    key: "myAccounts",
    label: "Account",
    scope: "personal",
    icon: <IconUser />,
  },
  {
    key: "preferences",
    label: "Preferences",
    scope: "personal",
    icon: <IconSliders />,
  },
  {
    key: "appearance",
    label: "Appearance",
    scope: "personal",
    icon: <IconPalette />,
  },
  {
    key: "notifications",
    label: "Notifications",
    scope: "personal",
    icon: <IconBell />,
  },
  {
    key: "shortcuts",
    label: "Shortcuts",
    scope: "personal",
    icon: <IconKeyboard />,
  },
  {
    key: "general",
    label: "General",
    scope: "organization",
    icon: <IconHome />,
  },
  {
    key: "members",
    label: "Members",
    scope: "organization",
    icon: <IconPeople />,
  },
  {
    key: "repos",
    label: "Repositories",
    scope: "organization",
    icon: <IconBranches />,
  },
  {
    key: "providers",
    label: "Models",
    scope: "organization",
    icon: <IconProviders />,
  },
  {
    key: "connections",
    label: "Connections",
    scope: "organization",
    icon: <IconConnections />,
  },
  {
    key: "library",
    label: "Library",
    scope: "organization",
    icon: <IconBook />,
  },
  {
    key: "memory",
    label: "Memory",
    scope: "organization",
    icon: <IconDatabase />,
  },
  {
    key: "audit",
    label: "Audit log",
    scope: "organization",
    icon: <IconFileText2 />,
  },
  {
    key: "sandboxes",
    label: "Sandboxes",
    scope: "server",
    icon: <IconBox />,
  },
  {
    key: "runners",
    label: "Runners",
    scope: "server",
    icon: <IconServer />,
  },
  {
    key: "ingress",
    label: "Domains",
    scope: "server",
    icon: <IconGlobe />,
  },
  {
    key: "storage",
    label: "Storage",
    scope: "server",
    icon: <IconArchive />,
  },
  {
    key: "deploys",
    label: "Deploys",
    scope: "server",
    icon: <IconRocket />,
  },
  {
    key: "automations",
    label: "Automations",
    scope: "organization",
    group: "Automation",
    icon: <IconClock />,
  },
  {
    key: "goals",
    label: "Goals",
    scope: "organization",
    group: "Automation",
    icon: <IconTarget />,
  },
  {
    key: "security",
    label: "Security",
    scope: "organization",
    group: "Automation",
    icon: <IconShieldCheck />,
  },
  {
    key: "papercuts",
    label: "Papercuts",
    scope: "server",
    icon: <IconBandAid />,
  },
];

/** Palette icons are drawn a size up from the nav's, so the element stored in
 *  the table is re-sized on the way out rather than the table carrying two. */
const PALETTE_ICON_SIZE = 18;

export type SettingsPaletteAction = {
  id: string;
  label: string;
  description: string;
  category: "Navigate";
  keywords: string[];
  icon: React.ReactElement;
  /** The section to open. The caller owns navigation, so it stays data here. */
  section: SettingsSectionKey;
};

/**
 * Every Settings section the command palette should be able to reach, as
 * actions missing only their `run`.
 *
 * Tool sections are left out: Automations, Goals and Security have their own
 * top-level routes and their own palette entries already, and a second row
 * pointing at the same place is noise.
 */
export function settingsPaletteActions(): SettingsPaletteAction[] {
  return SECTIONS.filter((section) => !TOOL_SECTIONS.has(section.key)).map(
    (section) => ({
      // Prefixed so these cannot collide with the palette's own ids (several
      // sections share a name with a tool view or a top-level action).
      id: `settings-${section.key}`,
      label: section.label,
      description: `Settings · ${scopeLabel(section.scope)}`,
      category: "Navigate" as const,
      keywords: SETTINGS_KEYWORDS[section.key] ?? [],
      icon: React.cloneElement(section.icon, { size: PALETTE_ICON_SIZE }),
      section: section.key,
    }),
  );
}
