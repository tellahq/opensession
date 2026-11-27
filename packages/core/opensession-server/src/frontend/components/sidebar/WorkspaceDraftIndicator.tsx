import { useEffect, useState } from "react";
import { hasDraft, onDraftsChanged } from "../../lib/drafts";
import { DraftPencil } from "./DraftPencil";

function sessionDraftKeys(sessionIdsKey: string): string[] {
  if (!sessionIdsKey) return [];
  return sessionIdsKey.split("\0").map((id) => `session:${id}`);
}

/** The first of the workspace's sessions that holds a draft, if any. */
function firstDraftKey(sessionIdsKey: string): string | null {
  return sessionDraftKeys(sessionIdsKey).find(hasDraft) ?? null;
}

export function WorkspaceDraftIndicator({
  sessionIdsKey,
  pushed,
}: {
  sessionIdsKey: string;
  pushed: boolean;
}) {
  const [draftKey, setDraftKey] = useState(() => firstDraftKey(sessionIdsKey));

  useEffect(() => {
    const keySet = new Set(sessionDraftKeys(sessionIdsKey));
    const read = () => setDraftKey(firstDraftKey(sessionIdsKey));
    read();
    return onDraftsChanged((changedKey) => {
      if (changedKey && !keySet.has(changedKey)) return;
      read();
    });
  }, [sessionIdsKey]);

  if (!draftKey) return null;
  // The pencil stays beside the hover actions, so pointing at it reads the
  // draft back.
  return (
    <DraftPencil
      draftKey={draftKey}
      className={pushed ? "ml-1.5" : "ml-auto"}
    />
  );
}
