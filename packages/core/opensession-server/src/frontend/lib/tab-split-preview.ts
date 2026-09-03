import type { CSSProperties } from "react";
import type { SplitSide } from "../components/SessionSplit";
import type { ResolvedSplit } from "./split-tabs";

type TabSplitPreviewStyle = CSSProperties & {
  "--split-preview-share": string;
};

export function tabSplitPreviewStyle(
  side: SplitSide | null,
  split: ResolvedSplit | null,
): TabSplitPreviewStyle | undefined {
  if (!side || !split) return undefined;
  const share = side === "left" ? split.ratio : 1 - split.ratio;
  return { "--split-preview-share": `${share * 100}%` };
}
