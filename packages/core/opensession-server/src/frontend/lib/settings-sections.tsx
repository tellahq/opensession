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

interface SettingsSection {
  key: SettingsSectionKey;
  label: string;
  group: string;
  icon: React.ReactElement<{ size?: number }>;
}

// Personal is yours alone. Organization is what every session shares.
// Infrastructure is where sessions run. Automation is the work the instance
// does on its own, and Activity is the record it leaves.
export const SECTIONS: SettingsSection[] = [
  {
    key: "myAccounts",
    label: "Account",
    group: "Personal",
    icon: <IconUser />,
  },
  {
    key: "preferences",
    label: "Preferences",
    group: "Personal",
    icon: <IconSliders />,
  },
  {
    key: "notifications",
    label: "Notifications",
    group: "Personal",
    icon: <IconBell />,
  },
  {
    key: "shortcuts",
    label: "Shortcuts",
    group: "Personal",
    icon: <IconKeyboard />,
  },
  {
    key: "general",
    label: "General",
    group: "Organization",
    icon: <IconHome />,
  },
  {
    key: "members",
    label: "Members",
    group: "Organization",
    icon: <IconPeople />,
  },
  {
    key: "repos",
    label: "Repositories",
    group: "Organization",
    icon: <IconBranches />,
  },
  {
    key: "providers",
    label: "Models",
    group: "Organization",
    icon: <IconProviders />,
  },
  {
    key: "connections",
    label: "Connections",
    group: "Organization",
    icon: <IconConnections />,
  },
  {
    key: "library",
    label: "Library",
    group: "Organization",
    icon: <IconBook />,
  },
  {
    key: "memory",
    label: "Memory",
    group: "Organization",
    icon: <IconDatabase />,
  },
  {
    key: "sandboxes",
    label: "Sandboxes",
    group: "Infrastructure",
    icon: <IconBox />,
  },
  {
    key: "runners",
    label: "Runners",
    group: "Infrastructure",
    icon: <IconServer />,
  },
  {
    key: "ingress",
    label: "Domains",
    group: "Infrastructure",
    icon: <IconGlobe />,
  },
  {
    key: "storage",
    label: "Storage",
    group: "Infrastructure",
    icon: <IconArchive />,
  },
  {
    key: "deploys",
    label: "Deploys",
    group: "Infrastructure",
    icon: <IconRocket />,
  },
  {
    key: "automations",
    label: "Automations",
    group: "Automation",
    icon: <IconClock />,
  },
  { key: "goals", label: "Goals", group: "Automation", icon: <IconTarget /> },
  {
    key: "security",
    label: "Security",
    group: "Automation",
    icon: <IconShieldCheck />,
  },
  {
    key: "papercuts",
    label: "Papercuts",
    group: "Activity",
    icon: <IconBandAid />,
  },
  {
    key: "audit",
    label: "Audit log",
    group: "Activity",
    icon: <IconFileText2 />,
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
      description: `Settings · ${section.group}`,
      category: "Navigate" as const,
      keywords: SETTINGS_KEYWORDS[section.key] ?? [],
      icon: React.cloneElement(section.icon, { size: PALETTE_ICON_SIZE }),
      section: section.key,
    }),
  );
}
