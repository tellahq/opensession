import { useEffect, useState } from "react";
import { fetchWorkspaces } from "../lib/api";
import { setWorkspaceTitles } from "../lib/markdown";
import type { Workspace } from "../lib/types";

export function loadWorkspaces(
  load: () => Promise<Workspace[]>,
  setWorkspaces: (workspaces: Workspace[]) => void,
  setLoaded: () => void,
): Promise<void> {
  return load()
    .then(setWorkspaces)
    .catch(() => {})
    .finally(setLoaded);
}

export function subscribeToWorkspaceRefreshes(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  refresh: () => void,
): () => void {
  refresh();
  const onFocus = () => refresh();
  const onWorkspacesChanged = () => refresh();
  target.addEventListener("focus", onFocus);
  target.addEventListener(
    "opensession:workspaces-changed",
    onWorkspacesChanged,
  );
  return () => {
    target.removeEventListener("focus", onFocus);
    target.removeEventListener(
      "opensession:workspaces-changed",
      onWorkspacesChanged,
    );
  };
}

interface WorkspacesState {
  workspaces: Workspace[];
  loaded: boolean;
  refresh: () => Promise<void>;
}

export function useWorkspaces(): WorkspacesState {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loaded, setLoaded] = useState(false);
  // This identity is observable: the hook subscriptions and App's global
  // socket handler depend on it. Keep it stable in uncompiled development.
  const [refresh] = useState(
    () => () =>
      loadWorkspaces(fetchWorkspaces, setWorkspaces, () => setLoaded(true)),
  );

  useEffect(() => subscribeToWorkspaceRefreshes(window, refresh), [refresh]);
  useEffect(() => {
    setWorkspaceTitles(
      workspaces.map((workspace) => [workspace.id, workspace.name] as const),
    );
  }, [workspaces]);

  return { workspaces, loaded, refresh };
}
