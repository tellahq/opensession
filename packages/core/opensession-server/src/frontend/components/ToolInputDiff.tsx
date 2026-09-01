import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useResolvedTheme } from "./CodeHighlight";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  maxH80: {
    maxHeight: "calc(4px * 80)",
  },
  overflowAuto: {
    overflow: "auto",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",

    cornerShape: "var(--cs)",
  },
  bgCodeWell: {
    backgroundColor: "var(--code-well)",
  },
});

/**
 * A compact, read-only version of the Files changed renderer for one tool
 * step. Line numbers stay hidden because Edit inputs carry replacement
 * snippets, not their real source positions.
 */
export function ToolInputDiff({ patch }: { patch: string }) {
  const theme = useResolvedTheme();
  const file = (() => {
    try {
      return parsePatchFiles(patch)[0]?.files[0] ?? null;
    } catch {
      return null;
    }
  })();

  if (!file) return null;
  return (
    <div
      {...stylex.props(
        sx.maxH80,
        sx.overflowAuto,
        sx.roundedMd,
        sx.bgCodeWell,
        typography.label,
      )}
    >
      <FileDiff
        key={theme}
        fileDiff={file}
        options={{
          diffStyle: "unified",
          disableFileHeader: true,
          disableLineNumbers: true,
          overflow: "wrap",
          theme: theme === "light" ? "pierre-light" : "pierre-dark",
          themeType: theme,
        }}
        disableWorkerPool
      />
    </div>
  );
}
