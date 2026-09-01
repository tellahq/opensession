import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useId } from "react";
import type { CodeFlowNode, CodeFlowResult } from "../lib/types";
import { Button } from "../ui/button";
import { InlineAlert, LoadingState } from "../ui/state";
import { cn } from "../ui/cn";
import { IconBranches } from "./icons";
import { Badge } from "../ui/badge";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mlAuto: {
    marginLeft: "auto",
  },
  maxW52: {
    maxWidth: "calc(4px * 52)",
  },
  shrink0: {
    flexShrink: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  fontSans: {
    fontFamily: "var(--sans)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  hoverTextLink: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--link)",
      },
    },
  },
  phoneMaxW32: {
    "@media (max-width: 720px)": {
      maxWidth: "calc(4px * 32)",
    },
  },
  flex: {
    display: "flex",
  },
  minH8: {
    minHeight: "calc(4px * 8)",
  },
  minW0: {
    minWidth: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  py05: {
    paddingBlock: "calc(4px * 0.5)",
  },
  srOnly: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    margin: "-1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
  },
  m0: {
    margin: "0",
  },
  p0: {
    padding: "0",
  },
  minH48: {
    minHeight: "calc(4px * 48)",
  },
  m4: {
    margin: "calc(4px * 4)",
  },
  flexCol: {
    flexDirection: "column",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  textCenter: {
    textAlign: "center",
  },
  textSm: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-sm--line-height))",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  maxWMd: {
    maxWidth: "var(--container-md)",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  leading5: {
    lineHeight: "calc(4px * 5)",
  },
  mxAuto: {
    marginInline: "auto",
  },
  wFull: {
    width: "100%",
  },
  maxW1100px: {
    maxWidth: "1100px",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  phonePx2: {
    "@media (max-width: 720px)": {
      paddingInline: "calc(4px * 2)",
    },
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  px1: {
    paddingInline: "4px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  roundedXl: {
    borderRadius: "calc(18px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  bgRaised: {
    backgroundColor: "var(--bg-raised)",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  justifyStart: {
    justifyContent: "flex-start",
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
  py1: {
    paddingBlock: "4px",
  },
  mt3: {
    marginTop: "calc(4px * 3)",
  },
});

const TONE: Record<CodeFlowNode["status"], string> = {
  same: utilityClassName("text-dim"),
  added: utilityClassName("text-green"),
  removed: utilityClassName("text-red"),
  modified: utilityClassName("text-yellow"),
};

const MARK: Record<CodeFlowNode["status"], string> = {
  same: "·",
  added: "+",
  removed: "−",
  modified: "~",
};

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? `${parts.at(-2)}/${parts.at(-1)}` : path;
}

function FlowNode({
  node,
  depth,
  sectionFile,
  onOpenLocation,
}: {
  node: CodeFlowNode;
  depth: number;
  sectionFile?: string;
  onOpenLocation?: (path: string) => void;
}) {
  const location = node.file &&
    node.file !== sectionFile &&
    node.status !== "same" &&
    onOpenLocation && (
      <Button
        variant="ghost"
        size="md"
        className={mergeStylexOverrideClassName(
          "",
          sx.mlAuto,
          sx.maxW52,
          sx.shrink0,
          sx.truncate,
          sx.px15,
          sx.fontSans,
          sx.textFaint,
          sx.hoverTextLink,
          sx.phoneMaxW32,
          typography.meta,
        )}
        onClick={() => onOpenLocation?.(node.file!)}
        title={`Open ${node.file} in the file diff`}
      >
        {shortPath(node.file)}
      </Button>
    );
  return (
    <li
      className={cn(
        utilityClassName("relative list-none"),
        depth > 0 && utilityClassName("ml-4 border-l border-line/70 pl-3"),
      )}
    >
      <div
        {...stylex.props(
          sx.flex,
          sx.minH8,
          sx.minW0,
          sx.itemsCenter,
          sx.gap2,
          sx.py05,
        )}
      >
        <span
          className={cn(
            utilityClassName(
              "w-3 shrink-0 text-center font-mono text-xs font-bold",
            ),
            TONE[node.status],
          )}
          aria-hidden="true"
        >
          {MARK[node.status]}
        </span>
        <code
          className={cn(
            utilityClassName(
              "min-w-0 truncate bg-transparent p-0 text-label leading-5",
            ),
            TONE[node.status],
          )}
          title={node.label}
        >
          <span {...stylex.props(sx.srOnly)}>{node.status}: </span>
          {node.label}
        </code>
        {location}
      </div>
      {node.children.length > 0 && (
        <ol {...stylex.props(sx.m0, sx.p0)}>
          {node.children.map((child, index) => (
            <FlowNode
              key={`${child.key}:${child.status}:${index}`}
              node={child}
              depth={depth + 1}
              sectionFile={sectionFile}
              onOpenLocation={onOpenLocation}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

function changedFile(node: CodeFlowNode): string | undefined {
  if (node.status !== "same" && node.file) return node.file;
  for (const child of node.children) {
    const file = changedFile(child);
    if (file) return file;
  }
  return node.file;
}

export function CodeFlow({
  data,
  loading,
  error,
  onRetry,
  onOpenLocation,
}: {
  data: CodeFlowResult | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenLocation?: (path: string) => void;
}) {
  const titleId = useId();
  const files = new Map<string, CodeFlowResult["trees"]>();
  for (const tree of data?.trees ?? []) {
    const file = changedFile(tree.tree) ?? "Project structure";
    const entries = files.get(file) ?? [];
    entries.push(tree);
    files.set(file, entries);
  }
  if (loading && !data)
    return (
      <LoadingState className={mergeStylexOverrideClassName("", sx.minH48)}>
        Mapping code flow…
      </LoadingState>
    );
  if (error && !data) {
    return (
      <InlineAlert
        className={mergeStylexOverrideClassName("", sx.m4)}
        onRetry={onRetry}
      >
        {error}
      </InlineAlert>
    );
  }
  if (!data?.trees.length) {
    const limited = Boolean(data?.truncated || data?.skippedFiles);
    return (
      <div
        {...stylex.props(
          sx.flex,
          sx.minH48,
          sx.flexCol,
          sx.itemsCenter,
          sx.justifyCenter,
          sx.gap2,
          sx.px4,
          sx.textCenter,
        )}
      >
        <IconBranches
          size={24}
          className={mergeStylexOverrideClassName("", sx.textFaint)}
        />
        <div {...stylex.props(sx.textSm, sx.fontMedium, sx.textDim)}>
          {limited ? "Code flow was limited" : "No code-flow changes detected"}
        </div>
        <div {...stylex.props(sx.maxWMd, sx.textXs, sx.leading5, sx.textFaint)}>
          {limited
            ? `${data?.skippedFiles || "Some"} changed file${data?.skippedFiles === 1 ? "" : "s"} could not be analyzed, so no reliable structural result is available.`
            : "The changed TypeScript, TSX, Rust, and ReScript files keep the same call and component structure."}
        </div>
      </div>
    );
  }
  return (
    <section
      {...stylex.props(
        sx.mxAuto,
        sx.wFull,
        sx.maxW1100px,
        sx.px3,
        sx.py4,
        sx.phonePx2,
      )}
      aria-labelledby={titleId}
    >
      <header
        {...stylex.props(sx.mb3, sx.flex, sx.itemsCenter, sx.gap2, sx.px1)}
      >
        <IconBranches
          size={17}
          className={mergeStylexOverrideClassName("", sx.textDim)}
        />
        <h2
          id={titleId}
          {...stylex.props(sx.m0, sx.textSm, sx.fontSemibold, sx.textFg)}
        >
          Code flow
        </h2>
        <span {...stylex.props(sx.textXs, sx.textFaint)}>
          {data.languages.join(" · ")}
        </span>
        {loading && (
          <span
            {...stylex.props(sx.mlAuto, sx.textFaint, typography.meta)}
            role="status"
          >
            Updating…
          </span>
        )}
        {data.truncated && !loading && (
          <Badge
            tone="warning"
            className={mergeStylexOverrideClassName("", sx.mlAuto)}
          >
            bounded
          </Badge>
        )}
      </header>
      {error && (
        <InlineAlert
          className={mergeStylexOverrideClassName("", sx.mb3)}
          onRetry={onRetry}
        >
          {error}
        </InlineAlert>
      )}
      <div className="space-y-2">
        {[...files].map(([file, trees]) => (
          <article
            key={file}
            {...stylex.props(sx.overflowHidden, sx.roundedXl, sx.bgPanel)}
          >
            <header
              {...stylex.props(
                sx.flex,
                sx.minH10,
                sx.itemsCenter,
                sx.borderB,
                sx.borderDivider,
                sx.bgRaised,
                sx.px3,
                sx.phonePx2,
              )}
            >
              {file !== "Project structure" && onOpenLocation ? (
                <Button
                  variant="ghost"
                  size="md"
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.minW0,
                    sx.maxWFull,
                    sx.justifyStart,
                    sx.truncate,
                    sx.px1,
                    sx.fontMono,
                    sx.textXs,
                    sx.fontSemibold,
                    sx.textFg,
                    sx.hoverTextLink,
                  )}
                  onClick={() => onOpenLocation(file)}
                  title={`Open ${file} in the file diff`}
                >
                  {file}
                </Button>
              ) : (
                <span
                  {...stylex.props(
                    sx.fontMono,
                    sx.textXs,
                    sx.fontSemibold,
                    sx.textFg,
                  )}
                >
                  {file}
                </span>
              )}
              <span
                {...stylex.props(
                  sx.mlAuto,
                  sx.shrink0,
                  sx.textFaint,
                  typography.meta,
                )}
              >
                {trees.length} changed {trees.length === 1 ? "flow" : "flows"}
              </span>
            </header>
            <div
              {...mergeStylexProps(
                "divide-y divide-line/70",
                sx.px3,
                sx.py1,
                sx.phonePx2,
              )}
            >
              {trees.map(({ entry, tree }) => (
                <ol key={entry} {...stylex.props(sx.m0, sx.py1, sx.p0)}>
                  <FlowNode
                    node={tree}
                    depth={0}
                    sectionFile={file}
                    onOpenLocation={onOpenLocation}
                  />
                </ol>
              ))}
            </div>
          </article>
        ))}
      </div>
      <footer
        {...stylex.props(sx.mt3, sx.px1, sx.textFaint, typography.supporting)}
      >
        Approximate, syntax-based structure
        {data.skippedFiles
          ? ` · ${data.skippedFiles} file${data.skippedFiles === 1 ? "" : "s"} skipped`
          : ""}
      </footer>
    </section>
  );
}
