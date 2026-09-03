import { useEffect, useEffectEvent, useState } from "react";

export type DiffStyle = "unified" | "split";
export type CodeTheme = "system" | "light" | "dark";

export interface CodeDisplaySettingsState {
  diffStyle: DiffStyle;
  changeDiffStyle: (next: DiffStyle) => void;
  wrapLines: boolean;
  changeWrapLines: (next: boolean) => void;
  structuralHighlighting: boolean;
  changeStructuralHighlighting: (next: boolean) => void;
  showFileStats: boolean;
  changeShowFileStats: (next: boolean) => void;
  codeTheme: CodeTheme;
  changeCodeTheme: (next: CodeTheme) => void;
}

export interface CodeOrganizationSettingsState {
  grouping: "none" | "ai";
  changeGrouping: (next: "none" | "ai") => void;
  fileListMode: "flat" | "tree" | "hidden";
  changeFileListMode: (next: "flat" | "tree" | "hidden") => void;
  fileOrder: "path" | "changes" | "pull-request";
  changeFileOrder: (next: "path" | "changes" | "pull-request") => void;
  sortDirection: "asc" | "desc";
  changeSortDirection: (next: "asc" | "desc") => void;
  hideReviewed: boolean;
  changeHideReviewed: (next: boolean) => void;
}

const SETTING_EVENT = "opensession-code-setting";

function allowedSetting<T extends string>(
  stored: string | null,
  allowed: readonly T[],
): T | undefined {
  return allowed.find((value) => value === stored);
}

export function useStoredCodeSetting<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(
    () => allowedSetting(localStorage.getItem(key), allowed) ?? fallback,
  );
  const parseAllowed = useEffectEvent((stored: string | null) =>
    allowedSetting(stored, allowed),
  );
  const change = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
      window.dispatchEvent(
        new CustomEvent(SETTING_EVENT, { detail: { key, value: next } }),
      );
    } catch {}
  };
  const allowedKey = allowed.join("\0");
  useEffect(() => {
    // Rebuild the validation list from the joined key so the listener only
    // resubscribes when the allowed values actually change.
    const allowedValues = allowedKey.split("\0");
    const sync = () => {
      const stored = parseAllowed(localStorage.getItem(key));
      if (stored !== undefined && allowedValues.includes(stored)) {
        setValue(stored);
      }
    };
    window.addEventListener(SETTING_EVENT, sync);
    return () => window.removeEventListener(SETTING_EVENT, sync);
    // Callers often pass a literal list. Its values, not its array identity,
    // decide when this listener needs a new validation closure.
  }, [key, allowedKey]);
  return [value, change];
}

/** File organization preferences shared by Review and sidebar Changes. */
export function useCodeOrganizationSettings(): CodeOrganizationSettingsState {
  const [grouping, changeGrouping] = useStoredCodeSetting(
    "opensession-pr-grouping",
    ["none", "ai"] as const,
    "none",
  );
  const [fileListMode, changeFileListMode] = useStoredCodeSetting(
    "opensession-pr-file-list",
    ["flat", "tree", "hidden"] as const,
    "hidden",
  );
  const [fileOrder, changeFileOrder] = useStoredCodeSetting(
    "opensession-pr-file-order",
    ["path", "changes", "pull-request"] as const,
    "path",
  );
  const [sortDirection, changeSortDirection] = useStoredCodeSetting(
    "opensession-pr-file-order-direction",
    ["asc", "desc"] as const,
    "asc",
  );
  const [hideReviewedSetting, changeHideReviewedSetting] = useStoredCodeSetting(
    "opensession-pr-hide-reviewed",
    ["0", "1"] as const,
    "0",
  );

  return {
    grouping,
    changeGrouping,
    fileListMode,
    changeFileListMode,
    fileOrder,
    changeFileOrder,
    sortDirection,
    changeSortDirection,
    hideReviewed: hideReviewedSetting === "1",
    changeHideReviewed: (next) => changeHideReviewedSetting(next ? "1" : "0"),
  };
}

/** Rendering preferences shared by the full Review canvas and sidebar Changes. */
export function useCodeDisplaySettings(
  defaultDiffStyle: DiffStyle,
): CodeDisplaySettingsState {
  const [diffStyle, changeDiffStyle] = useStoredCodeSetting(
    "opensession-pr-diff-style",
    ["unified", "split"] as const,
    defaultDiffStyle,
  );
  const [wrapSetting, changeWrapSetting] = useStoredCodeSetting(
    "opensession-pr-diff-wrap",
    ["0", "1"] as const,
    "0",
  );
  const [structuralSetting, changeStructuralSetting] = useStoredCodeSetting(
    "opensession-pr-structural-highlighting",
    ["0", "1"] as const,
    "1",
  );
  const [fileStatsSetting, changeFileStatsSetting] = useStoredCodeSetting(
    "opensession-pr-file-stats",
    ["0", "1"] as const,
    "1",
  );
  const [codeTheme, changeCodeTheme] = useStoredCodeSetting(
    "opensession-pr-code-theme",
    ["system", "light", "dark"] as const,
    "system",
  );

  return {
    diffStyle,
    changeDiffStyle,
    wrapLines: wrapSetting === "1",
    changeWrapLines: (next) => changeWrapSetting(next ? "1" : "0"),
    structuralHighlighting: structuralSetting === "1",
    changeStructuralHighlighting: (next) =>
      changeStructuralSetting(next ? "1" : "0"),
    showFileStats: fileStatsSetting === "1",
    changeShowFileStats: (next) => changeFileStatsSetting(next ? "1" : "0"),
    codeTheme,
    changeCodeTheme,
  };
}
