import React from "react";
import {
  IconArchive,
  IconArrowDown,
  IconBandAid,
  IconBell,
  IconBolt,
  IconBook,
  IconBox,
  IconBranches,
  IconChecklist,
  IconClock,
  IconConnections,
  IconDatabase,
  IconFileText2,
  IconHome,
  IconGlobe,
  IconKeyboard,
  IconPeople,
  IconPlug,
  IconRocket,
  IconServer,
  IconShapes,
  IconShieldCheck,
  IconSliders,
  IconTarget,
  IconUser,
} from "../components/icons";
import { SETTINGS_KEYWORDS } from "./settings-search";

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
  | "setup"
  | "repos"
  | "members"
  | "authentication"
  | "providers"
  | "sandboxes"
  | "runners"
  | "library"
  | "integrations"
  | "connections"
  | "memory"
  | "storage"
  | "ingress"
  | "prewarming"
  | "deploys"
  | "papercuts"
  | "audit"
  | "downloads"
  | ToolSectionKey;

export const TOOL_SECTIONS = new Set<SettingsSectionKey>([
  "automations",
  "goals",
  "security",
]);

export const SECTIONS: {
  key: SettingsSectionKey;
  label: string;
  group: string;
  icon: React.ReactElement;
  adminOnly?: boolean;
}[] = [
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
    adminOnly: true,
    icon: <IconHome />,
  },
  {
    key: "setup",
    label: "Setup",
    group: "Organization",
    adminOnly: true,
    icon: <IconChecklist />,
  },
  {
    key: "repos",
    label: "Repositories",
    group: "Organization",
    adminOnly: true,
    icon: <IconBranches />,
  },
  {
    key: "members",
    label: "Members",
    group: "Organization",
    adminOnly: true,
    icon: <IconPeople />,
  },
  {
    key: "authentication",
    label: "Authentication",
    group: "Organization",
    adminOnly: true,
    icon: <IconShieldCheck />,
  },
  {
    key: "providers",
    label: "Providers",
    group: "Organization",
    icon: <IconShapes />,
  },
  {
    key: "sandboxes",
    label: "Sandboxes",
    group: "Organization",
    icon: <IconBox />,
  },
  {
    key: "runners",
    label: "Runners",
    group: "Organization",
    icon: <IconServer />,
  },
  {
    key: "library",
    label: "Library",
    group: "Organization",
    icon: <IconBook />,
  },
  {
    key: "integrations",
    label: "Integrations",
    group: "Organization",
    adminOnly: true,
    icon: <IconPlug />,
  },
  {
    key: "connections",
    label: "Connections",
    group: "Organization",
    icon: <IconConnections />,
  },
  {
    key: "memory",
    label: "Memories",
    group: "Organization",
    adminOnly: true,
    icon: <IconDatabase />,
  },
  {
    key: "automations",
    label: "Automations",
    group: "Automation",
    icon: <IconClock />,
  },
  {
    key: "goals",
    label: "Goals",
    group: "Automation",
    icon: <IconTarget />,
  },
  {
    key: "security",
    label: "Security",
    group: "Automation",
    icon: <IconShieldCheck />,
  },
  {
    key: "ingress",
    label: "Domains",
    group: "Infrastructure",
    adminOnly: true,
    icon: <IconGlobe />,
  },
  {
    key: "storage",
    label: "Storage",
    group: "Infrastructure",
    adminOnly: true,
    icon: <IconArchive />,
  },
  {
    key: "prewarming",
    label: "Acceleration",
    group: "Infrastructure",
    icon: <IconBolt />,
  },
  {
    key: "deploys",
    label: "Deploys",
    group: "Infrastructure",
    icon: <IconRocket />,
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
  {
    key: "downloads",
    label: "Downloads",
    group: "Activity",
    icon: <IconArrowDown />,
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
 *
 * Admin-only sections are dropped for non-admins, mirroring the nav — the
 * Settings surface silently falls back to the default section for a section
 * someone cannot see, so a row offering it would go nowhere.
 */
export function settingsPaletteActions(opts: {
  admin: boolean;
}): SettingsPaletteAction[] {
  return SECTIONS.filter(
    (section) =>
      !TOOL_SECTIONS.has(section.key) && (opts.admin || !section.adminOnly),
  ).map((section) => ({
    // Prefixed so these cannot collide with the palette's own ids (several
    // sections share a name with a tool view or a top-level action).
    id: `settings-${section.key}`,
    label: section.label,
    description: `Settings · ${section.group}`,
    category: "Navigate" as const,
    keywords: SETTINGS_KEYWORDS[section.key] ?? [],
    icon: React.cloneElement(section.icon, { size: PALETTE_ICON_SIZE } as {
      size: number;
    }),
    section: section.key,
  }));
}
