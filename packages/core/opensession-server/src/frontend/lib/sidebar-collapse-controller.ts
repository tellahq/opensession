import React from "react";
import { EXPANDED_KEY } from "./sidebar-filter";
import type { GroupBand } from "./sidebar-types";

interface SidebarCollapseOptions {
  search: string;
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
  borrowedLens: boolean;
}

export function createSidebarCollapseController({
  search,
  expanded,
  setExpanded,
  borrowedLens,
}: SidebarCollapseOptions) {
  const collapseKey = (key: string) =>
    key.startsWith("repo:") ||
    key.startsWith("review:") ||
    key.startsWith("project:") ||
    key.startsWith("support:") ||
    key.startsWith("lifecycle:") ||
    key.startsWith("inbox:") ||
    key.startsWith("person:")
      ? `collapsed:${key}`
      : key;

  function toggleGroup(key: string) {
    const stored = collapseKey(key);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(stored)) next.delete(stored);
      else next.add(stored);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const isOpen = (key: string) => {
    if (search.trim().length > 0) return true;
    if (
      key.startsWith("repo:") ||
      key.startsWith("review:") ||
      key.startsWith("support:") ||
      key.startsWith("lifecycle:") ||
      key.startsWith("project:") ||
      key.startsWith("inbox:") ||
      key.startsWith("person:")
    )
      return !expanded.has(`collapsed:${key}`);
    return expanded.has(key);
  };

  const bandOpen = (band: GroupBand | "workspaces") =>
    search.trim().length > 0 ? true : !expanded.has(`collapsed:band:${band}`);

  function toggleBand(band: GroupBand | "tools" | "workspaces") {
    const key = `collapsed:band:${band}`;
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  return {
    automationsOpen: bandOpen("automations"),
    isOpen,
    peopleOpen: bandOpen("people"),
    toggleBand,
    toggleGroup,
    workspacesOpen: bandOpen("workspaces") || borrowedLens,
  };
}
