import { useSyncExternalStore } from "react";
import {
  audibleFrameScopes,
  pauseKeptFrames,
  subscribeKeptFrames,
  viewTabScope,
} from "../../lib/kept-frames";
import type { UnifiedSession, Workspace } from "../../lib/types";
import { Tooltip } from "../../ui/tooltip";
import { IconSpeaker } from "../icons";

/** Every scope a row's Browser and Portal pages can be kept under. */
export function rowFrameScopes(row: {
  sessions: readonly UnifiedSession[];
  workspace?: Workspace | null;
}): Set<string> {
  const scopes = new Set(row.sessions.map(viewTabScope));
  if (row.workspace) scopes.add(row.workspace.id);
  return scopes;
}

/**
 * A page in this row's Browser or Portal tab is playing sound. Pages keep
 * playing after you switch away (lib/kept-frames.ts), so without this you
 * hear something and cannot tell which workspace it is in. Clicking it
 * pauses the page, the way a browser tab's speaker mutes it.
 */
export function SoundMark({
  row,
}: {
  row: { sessions: readonly UnifiedSession[]; workspace?: Workspace | null };
}) {
  const audible = useSyncExternalStore(
    subscribeKeptFrames,
    audibleFrameScopes,
    audibleFrameScopes,
  );
  if (!audible) return null;
  const scopes = rowFrameScopes(row);
  if (!audible.split("\n").some((scope) => scopes.has(scope))) return null;
  const pause = (event: React.SyntheticEvent) => {
    event.stopPropagation();
    pauseKeptFrames(scopes);
  };
  return (
    <Tooltip label="Playing sound. Click to pause">
      <span
        role="button"
        tabIndex={0}
        className="ml-1 flex shrink-0 cursor-pointer items-center rounded-md text-dim hover:text-fg"
        aria-label="Pause sound"
        data-ws-sound=""
        onClick={pause}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") pause(event);
        }}
      >
        <IconSpeaker size={20} />
      </span>
    </Tooltip>
  );
}
