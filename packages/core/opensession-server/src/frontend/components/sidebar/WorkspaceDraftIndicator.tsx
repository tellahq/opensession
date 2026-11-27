import { useEffect, useState } from "react";
import { hasDraft, onDraftsChanged } from "../../lib/drafts";
import { SIDEBAR_WS_DRAFT_YIELDS } from "../../lib/sidebar-classes";
import { cn } from "../../ui/cn";
import { IconPencil } from "../icons";

function sessionDraftKeys(sessionIdsKey: string): string[] {
  if (!sessionIdsKey) return [];
  return sessionIdsKey.split("\0").map((id) => `session:${id}`);
}

export function WorkspaceDraftIndicator({
  sessionIdsKey,
  pushed,
}: {
  sessionIdsKey: string;
  pushed: boolean;
}) {
  const [present, setPresent] = useState(() =>
    sessionDraftKeys(sessionIdsKey).some(hasDraft),
  );

  useEffect(() => {
    const keys = sessionDraftKeys(sessionIdsKey);
    const keySet = new Set(keys);
    const read = () => setPresent(keys.some(hasDraft));
    read();
    return onDraftsChanged((changedKey) => {
      if (changedKey && !keySet.has(changedKey)) return;
      read();
    });
  }, [sessionIdsKey]);

  if (!present) return null;
  return (
    <span
      className={cn(SIDEBAR_WS_DRAFT_YIELDS, pushed ? "ml-1.5" : "ml-auto")}
      data-ws-draft=""
      aria-label="Unsent draft. Return to finish it."
    >
      <IconPencil size={20} />
    </span>
  );
}
