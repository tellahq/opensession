import { draftPreview } from "../../lib/draft-preview";
import { loadDraft } from "../../lib/drafts";
import { SIDEBAR_WS_DRAFT } from "../../lib/sidebar-classes";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconPencil } from "../icons";

/** What the draft says, so hovering the pencil answers "what did I leave
 *  here?" without opening the session. */
export function DraftTooltipLabel({ draftKey }: { draftKey: string }) {
  const { text, attachments } = draftPreview(loadDraft(draftKey));
  return (
    <span>
      <span className="font-semibold">Draft</span>
      {text && ` “${text}”`}
      {attachments && <span className="opacity-70">{` · ${attachments}`}</span>}
    </span>
  );
}

/** Slack-style pencil on a session row that holds an unsent draft. */
export function DraftPencil({
  draftKey,
  className,
}: {
  draftKey: string;
  className?: string;
}) {
  return (
    <Tooltip label={<DraftTooltipLabel draftKey={draftKey} />} multiline>
      <span
        className={cn(SIDEBAR_WS_DRAFT, className)}
        data-ws-draft=""
        role="img"
        aria-label="Unsent draft. Return to finish it."
      >
        <IconPencil size={20} />
      </span>
    </Tooltip>
  );
}
