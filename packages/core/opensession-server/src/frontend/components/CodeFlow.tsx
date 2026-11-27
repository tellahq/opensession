import React, { useId } from "react";
import type { CodeFlowNode, CodeFlowResult } from "../lib/types";
import { Button } from "../ui/button";
import { InlineAlert, LoadingState } from "../ui/state";
import { cn } from "../ui/cn";
import { IconBranches } from "./icons";
import { Badge } from "../ui/badge";

const TONE: Record<CodeFlowNode["status"], string> = {
  same: "text-dim",
  added: "text-green",
  removed: "text-red",
  modified: "text-yellow",
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
        className="ml-auto max-w-52 shrink-0 truncate px-1.5 font-sans text-meta text-faint hover:text-link phone:max-w-32"
        onClick={() => onOpenLocation?.(node.file!)}
        title={`Open ${node.file} in the file diff`}
      >
        {shortPath(node.file)}
      </Button>
    );
  return (
    <li
      className={cn(
        "relative list-none",
        depth > 0 && "ml-4 border-l border-line/70 pl-3",
      )}
    >
      <div className="flex min-h-8 min-w-0 items-center gap-2 py-0.5">
        <span
          className={cn(
            "w-3 shrink-0 text-center font-mono text-xs font-bold",
            TONE[node.status],
          )}
          aria-hidden="true"
        >
          {MARK[node.status]}
        </span>
        <code
          className={cn(
            "min-w-0 truncate bg-transparent p-0 text-label leading-5",
            TONE[node.status],
          )}
          title={node.label}
        >
          <span className="sr-only">{node.status}: </span>
          {node.label}
        </code>
        {location}
      </div>
      {node.children.length > 0 && (
        <ol className="m-0 p-0">
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
    return <LoadingState className="min-h-48">Mapping code flow…</LoadingState>;
  if (error && !data) {
    return (
      <InlineAlert className="m-4" onRetry={onRetry}>
        {error}
      </InlineAlert>
    );
  }
  if (!data?.trees.length) {
    const limited = Boolean(data?.truncated || data?.skippedFiles);
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-4 text-center">
        <IconBranches size={24} className="text-faint" />
        <div className="text-sm font-medium text-dim">
          {limited ? "Code flow was limited" : "No code-flow changes detected"}
        </div>
        <div className="max-w-md text-xs leading-5 text-faint">
          {limited
            ? `${data?.skippedFiles || "Some"} changed file${data?.skippedFiles === 1 ? "" : "s"} could not be analyzed, so no reliable structural result is available.`
            : "The changed TypeScript, TSX, Rust, and ReScript files keep the same call and component structure."}
        </div>
      </div>
    );
  }
  return (
    <section
      className="mx-auto w-full max-w-[1100px] px-3 py-4 phone:px-2"
      aria-labelledby={titleId}
    >
      <header className="mb-3 flex items-center gap-2 px-1">
        <IconBranches size={20} className="text-dim" />
        <h2 id={titleId} className="m-0 text-sm font-semibold text-fg">
          Code flow
        </h2>
        <span className="text-xs text-faint">{data.languages.join(" · ")}</span>
        {loading && (
          <span className="ml-auto text-meta text-faint" role="status">
            Updating…
          </span>
        )}
        {data.truncated && !loading && (
          <Badge tone="warning" className="ml-auto">
            bounded
          </Badge>
        )}
      </header>
      {error && (
        <InlineAlert className="mb-3" onRetry={onRetry}>
          {error}
        </InlineAlert>
      )}
      <div className="space-y-2">
        {[...files].map(([file, trees]) => (
          <article key={file} className="overflow-hidden rounded-xl bg-panel">
            <header className="flex min-h-10 items-center border-b border-divider bg-raised px-3 phone:px-2">
              {file !== "Project structure" && onOpenLocation ? (
                <Button
                  variant="ghost"
                  size="md"
                  className="min-w-0 max-w-full justify-start truncate px-1 font-mono text-xs font-semibold text-fg hover:text-link"
                  onClick={() => onOpenLocation(file)}
                  title={`Open ${file} in the file diff`}
                >
                  {file}
                </Button>
              ) : (
                <span className="font-mono text-xs font-semibold text-fg">
                  {file}
                </span>
              )}
              <span className="ml-auto shrink-0 text-meta text-faint">
                {trees.length} changed {trees.length === 1 ? "flow" : "flows"}
              </span>
            </header>
            <div className="divide-y divide-line/70 px-3 py-1 phone:px-2">
              {trees.map(({ entry, tree }) => (
                <ol key={entry} className="m-0 py-1 p-0">
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
      <footer className="mt-3 px-1 text-supporting text-faint">
        Approximate, syntax-based structure
        {data.skippedFiles
          ? ` · ${data.skippedFiles} file${data.skippedFiles === 1 ? "" : "s"} skipped`
          : ""}
      </footer>
    </section>
  );
}
