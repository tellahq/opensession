import { useEffect, useState } from "react";
import { useChannelActivity } from "../../hooks/useChannelActivity";
import type { Route } from "../../lib/app-route";
import type { SearchResult } from "../../lib/api/slack-channels";
import { markActivitySeen, useActivitySeen } from "../../lib/channel-activity";
import { newestTs } from "../../lib/channel-activity-model";
import { jumpKey, requestJump } from "../../lib/channel-jump";
import { shortWhen, tsDate } from "../../lib/channel-messages";
import {
  conversationLabel,
  useSlackConversations,
} from "../../lib/slack-conversations";
import { cn } from "../../ui/cn";
import { ListRow } from "../../ui/list-row";
import { PageLayout } from "../../ui/page";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import { IconBell } from "../icons";
import { ChannelMessageRow } from "./ChannelMessageRow";
import { ConversationGlyph } from "./ConversationList";

type Navigate = (route: Route, opts?: { replace?: boolean }) => void;

const BELL_GLYPH = <IconBell size={22} />;

/**
 * Activity: messages that mention you, newest first, as Slack's Activity
 * lists them. Each names its conversation and opens there, at the message.
 * Opening the page marks them seen, which clears the count on its row;
 * mentions that came in since you last looked keep a dot.
 */
export function ActivityPage({ navigate }: { navigate: Navigate }) {
  const { items, error, reload } = useChannelActivity();
  const { payload } = useSlackConversations();
  // What was seen before this visit, so new mentions keep their dot while
  // the page is open.
  const seen = useActivitySeen();
  const newest = items ? newestTs(items) : undefined;
  useEffect(() => {
    if (newest) markActivitySeen(newest);
  }, [newest]);
  const [seenBefore] = useState(seen);

  function open(item: SearchResult) {
    requestJump(jumpKey(item.channelId, item.threadTs), item.message.ts);
    navigate(
      item.threadTs
        ? { view: "channels", id: item.channelId, thread: item.threadTs }
        : { view: "channels", id: item.channelId },
    );
  }

  return (
    <PageLayout title="Activity">
      {items === null && !error ? (
        <LoadingState className="py-12" />
      ) : error && !items?.length ? (
        <InlineAlert appearance="plain" onRetry={reload}>
          {error}
        </InlineAlert>
      ) : !items?.length ? (
        <EmptyState className="py-12" icon={BELL_GLYPH} title="No mentions">
          When someone mentions you, it shows here.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-6 pb-10">
          {items.map((item) => {
            const { label, conversation } = conversationLabel(
              payload?.conversations,
              item.channelId,
              { name: item.channelName, isDirect: item.isDirect },
            );
            const fresh =
              !seenBefore || Number(item.message.ts) > Number(seenBefore);
            return (
              <section
                key={`${item.channelId}:${item.message.ts}`}
                aria-label={`Mention in ${label}`}
                className="flex flex-col gap-2"
              >
                <ListRow
                  onClick={() => open(item)}
                  className="min-h-0 w-auto items-center gap-2 self-start px-1.5 py-1 hover:bg-hover phone:min-h-11"
                >
                  <ConversationGlyph conversation={conversation} size={20} />
                  <span className="truncate text-item-title font-semibold text-fg">
                    {label}
                  </span>
                  <span className="text-meta text-faint">
                    {item.threadTs
                      ? "Mentioned you in a thread"
                      : "Mentioned you"}
                    {" · "}
                    {shortWhen(tsDate(item.message.ts))}
                  </span>
                  <span
                    aria-label={fresh ? "New" : undefined}
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      fresh ? "bg-accent" : "invisible",
                    )}
                  />
                </ListRow>
                <div className="flex flex-col rounded-xl bg-panel p-1">
                  <ChannelMessageRow
                    channelId={item.channelId}
                    message={item.message}
                    head
                    className="rounded-lg"
                    inThread={!!item.threadTs}
                    onJump={() => open(item)}
                  />
                </div>
              </section>
            );
          })}
        </div>
      )}
    </PageLayout>
  );
}
