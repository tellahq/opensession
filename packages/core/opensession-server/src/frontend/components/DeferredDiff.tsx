import { deferredExport } from "./deferred";

/*
 * The diff and file-tree renderers, loaded the first time one is rendered
 * instead of at boot. @pierre/diffs (with the shiki it bundles) and
 * @pierre/trees are the largest vendor code in the app, and nothing on the
 * boot path needs them: the phone's root page is the session list, and a
 * transcript only needs them once it reaches an edit. They share one chunk
 * (diff-renderers.ts) for the same reason the panes do.
 */
const renderers = () => import("./diff-renderers");

export const AssetsTree = deferredExport(renderers, "AssetsTree");
export const CommentableDiff = deferredExport(renderers, "CommentableDiff");
export const PatchDiffs = deferredExport(renderers, "PatchDiffs");
export const PatchFileDiff = deferredExport(renderers, "PatchFileDiff");
export const PrFileTree = deferredExport(renderers, "PrFileTree");
export const ToolInputDiff = deferredExport(renderers, "ToolInputDiff");
