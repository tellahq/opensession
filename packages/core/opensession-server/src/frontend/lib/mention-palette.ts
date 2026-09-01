import type React from "react";
import type { FileMention } from "./api";

export type MentionSuggestionKind =
  | NonNullable<FileMention["kind"]>
  | "tool"
  | "action"
  | "emoji";

export interface MentionSuggestion extends Omit<FileMention, "kind"> {
  kind?: MentionSuggestionKind;
  /** Local palette actions run instead of inserting text. */
  action?: () => void;
  icon?: React.ReactNode;
}

export interface MentionAction {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  icon?: React.ReactNode;
  run: () => void;
}

export type MentionCategory =
  | "Emoji"
  | "People"
  | "Tools"
  | "Workspaces"
  | "Sessions"
  | "Actions"
  | "Files"
  | "Skills";

const CATEGORY_ORDER: MentionCategory[] = [
  "Emoji",
  "People",
  "Tools",
  "Workspaces",
  "Sessions",
  "Actions",
  "Files",
  "Skills",
];

export function mentionCategory(item: MentionSuggestion): MentionCategory {
  if (item.kind === "emoji") return "Emoji";
  if (item.kind === "person") return "People";
  if (item.kind === "tool") return "Tools";
  if (item.kind === "workspace") return "Workspaces";
  if (item.kind === "session") return "Sessions";
  if (item.kind === "action") return "Actions";
  if (item.kind === "skill") return "Skills";
  return "Files";
}

export function actionMentionSuggestions(
  query: string,
  actions: MentionAction[],
): MentionSuggestion[] {
  const q = query.trim().toLowerCase();
  return actions
    .filter((action) =>
      !q
        ? true
        : [action.label, action.description, ...(action.keywords || [])]
            .filter(Boolean)
            .some((value) => value?.toLowerCase().includes(q)),
    )
    .map((action) => ({
      display: action.label,
      insert: action.id,
      kind: "action",
      sub: action.description,
      action: action.run,
      icon: action.icon,
    }));
}

function suggestionKey(item: MentionSuggestion): string {
  return `${item.kind || "file"}:${item.insert}`;
}

/** Merge synchronous and fetched results without duplicates, then keep the
 * palette's fixed category hierarchy. Sort stability preserves relevance
 * within each category. */
export function mergeMentionSuggestions(
  ...groups: ReadonlyArray<ReadonlyArray<MentionSuggestion>>
): MentionSuggestion[] {
  const seen = new Set<string>();
  const merged: MentionSuggestion[] = [];
  for (const group of groups) {
    for (const item of group) {
      const key = suggestionKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged.sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(mentionCategory(a)) -
      CATEGORY_ORDER.indexOf(mentionCategory(b)),
  );
}

export function groupMentionSuggestions(
  suggestions: MentionSuggestion[],
): Array<{
  category: MentionCategory;
  items: Array<{ item: MentionSuggestion; index: number }>;
}> {
  const groups: Array<{
    category: MentionCategory;
    items: Array<{ item: MentionSuggestion; index: number }>;
  }> = [];
  for (const [index, item] of suggestions.entries()) {
    const category = mentionCategory(item);
    const current = groups.at(-1);
    if (current?.category === category) current.items.push({ item, index });
    else groups.push({ category, items: [{ item, index }] });
  }
  return groups;
}
