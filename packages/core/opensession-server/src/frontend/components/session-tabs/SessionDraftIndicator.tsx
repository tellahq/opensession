import { useEffect, useState } from "react";
import { hasDraft, onDraftsChanged } from "../../lib/drafts";
import { TAB_DRAFT } from "../../lib/session-tab-classes";
import { IconPencil } from "../icons";

function draftKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export function SessionDraftIndicator({ sessionId }: { sessionId: string }) {
  const key = draftKey(sessionId);
  const [present, setPresent] = useState(() => hasDraft(key));

  useEffect(() => {
    const read = () => setPresent(hasDraft(key));
    read();
    return onDraftsChanged((changedKey) => {
      if (changedKey && changedKey !== key) return;
      read();
    });
  }, [key]);

  if (!present) return null;
  return (
    <span className={TAB_DRAFT} title="Unsent draft">
      <IconPencil size={16} dense />
    </span>
  );
}
