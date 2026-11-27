import {
  SIDEBAR_DENSITY_VARS,
  SIDEBAR_NAV_X,
  SIDEBAR_PLACE_TITLE,
} from "../../lib/sidebar-classes";
import { useSlackConversations } from "../../lib/slack-conversations";
import { cn } from "../../ui/cn";
import { ConversationList } from "./ConversationList";

/**
 * The sidebar in the Channels place: its title, then the person's Slack
 * conversations. It takes the whole column, the way the session list does
 * in Sessions, and scrolls under the fixed title.
 */
export function ChannelsSidebar({
  density,
  activeId,
  onOpen,
}: {
  density: string;
  activeId?: string;
  onOpen: (id: string) => void;
}) {
  const { payload, error } = useSlackConversations(true);
  return (
    <nav
      aria-label="Channels"
      data-density={density}
      className={cn(
        "flex min-h-0 w-full flex-1 flex-col",
        SIDEBAR_DENSITY_VARS,
        SIDEBAR_NAV_X,
      )}
    >
      <div
        className={cn(
          SIDEBAR_PLACE_TITLE,
          "flex h-[var(--sidebar-band-slot)] shrink-0 items-center px-4",
        )}
      >
        Channels
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--sidebar-nav-x)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {payload && !payload.connected ? (
          <p className="px-[calc(var(--sidebar-icon-left)-var(--sidebar-nav-x))] pt-2 text-body text-dim">
            Connect your Slack account to see your channels here.
          </p>
        ) : (
          <ConversationList
            conversations={payload?.conversations ?? []}
            activeId={activeId}
            loading={!payload && !error}
            error={error}
            onOpen={onOpen}
          />
        )}
      </div>
    </nav>
  );
}
