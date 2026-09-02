import {
  createContext,
  createElement,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  assetToolPath,
  parseMcpTool,
} from "@tellahq/opensession-protocol/tool-presentation";
import type { TranscriptEntry } from "./types";

/**
 * Opens one of the session's scratch assets — the transcript's own way into an
 * artifact, so a report or a visualization can be looked at from the turn that
 * produced it instead of hunted for in a tab you have to know exists.
 *
 * Context rather than a prop because the callers are a tool row and a turn
 * footer, both several memoized layers below the session view. Null where
 * there is no session view to open over (the Desk overlay, a sub-agent pane) —
 * and a caller then draws no affordance at all, because a chip that does
 * nothing is worse than no chip.
 */
const OpenAssetContext = createContext<((path: string) => void) | null>(null);
export const OpenAssetProvider = OpenAssetContext.Provider;

const EMPTY_ASSET_PATHS: readonly string[] = [];
type OpenAssetPathsValue = {
  getPaths: () => readonly string[];
  empty: boolean;
};
const OpenAssetPathsContext = createContext<OpenAssetPathsValue>({
  getPaths: () => EMPTY_ASSET_PATHS,
  empty: true,
});

/**
 * Keep the context identity stable while a non-empty folder changes. New
 * transcript rows still read the latest ref, without forcing every existing
 * markdown bubble to reparse whenever an agent writes another asset. Crossing
 * the empty boundary does notify consumers: that is the initial list load and
 * the moment the first/last asset appears or disappears.
 */
export function OpenAssetPathsProvider({
  value,
  children,
}: {
  value: readonly string[];
  children: ReactNode;
}) {
  const paths = useRef(value);
  useLayoutEffect(() => {
    paths.current = value;
  });
  const empty = value.length === 0;
  const [context, setContext] = useState<OpenAssetPathsValue>(() => ({
    getPaths: () => paths.current,
    empty,
  }));
  useLayoutEffect(() => {
    setContext((current) =>
      current.empty === empty ? current : { ...current, empty },
    );
  }, [empty]);
  return createElement(
    OpenAssetPathsContext.Provider,
    { value: context },
    children,
  );
}

/**
 * How a transcript surface opens a scratch file. `available` is false where
 * there is no session overlay to host it, so the surface can leave the
 * affordance out entirely.
 */
export function useOpenAsset() {
  const openInOverlay = useContext(OpenAssetContext);
  return {
    available: Boolean(openInOverlay),
    open(path: string) {
      openInOverlay?.(path);
    },
  };
}

/** Current files in this session's scratch folder. Markdown uses this exact
 * set to link names in prose without guessing that file-looking text exists. */
export function useOpenAssetPaths(): readonly string[] {
  return useContext(OpenAssetPathsContext).getPaths();
}

/**
 * The scratch files a turn wrote, in first-write order. Only writes: a read or
 * a delete names a path too, but the footer chips what the turn *produced* —
 * and a delete leaves nothing to open.
 */
export function collectWrittenAssets(items: TranscriptEntry[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.type !== "tool_use" || !item.toolName) continue;
    if (parseMcpTool(item.toolName)?.tool !== "write_asset") continue;
    const path = assetToolPath(item.toolName, item.toolInput);
    if (path) seen.add(path);
  }
  return [...seen];
}
