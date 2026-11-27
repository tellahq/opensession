import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import type { Route } from "../../lib/app-route";
import { fetchSent, type SentMessage } from "../../lib/api/slack-channels";
import { deleteDraft, useChannelDrafts } from "../../lib/channel-drafts";
import { shortWhen } from "../../lib/channel-messages";
import { errorMessage } from "../../lib/error-message";
import { isTouchPrimary } from "../../lib/platform";
import {
  conversationLabel,
  useSlackConversations,
} from "../../lib/slack-conversations";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { ListRow } from "../../ui/list-row";
import { PageLayout } from "../../ui/page";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import { UnderlineTabs } from "../../ui/tabs";
import { Tooltip } from "../../ui/tooltip";
import { IconPencil, IconSend, IconTrash } from "../icons";
import { ConversationGlyph } from "./ConversationList";
import { SlackText } from "./SlackText";

type Navigate = (route: Route, opts?: { replace?: boolean }) => void;
type Tab = "drafts" | "sent";

const TRASH_GLYPH = <IconTrash size={20} />;

/** One draft or sent message: where it goes, what it says, and when. The
 *  row's wash runs past the page's text edge so the text lines up with the
 *  title above it. */
function MessageListRow({
  conversation,
  label,
  inThread,
  text,
  when,
  onOpen,
  trailing,
}: {
  conversation: Parameters<typeof ConversationGlyph>[0]["conversation"];
  label: string;
  inThread: boolean;
  text: string;
  when: string;
  onOpen: () => void;
  /** An action beside the row, kept out of the row's own button. */
  trailing?: ReactNode;
}) {
  return (
    <li className="group relative">
      <ListRow
        onClick={onOpen}
        className={cn(
          "-mx-3 w-[calc(100%+24px)] items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-hover",
          // A touch screen shows the action all the time, beside the time.
          trailing && isTouchPrimary && "pr-12",
        )}
      >
        <span className="pt-px">
          <ConversationGlyph conversation={conversation} size={22} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-item-title font-semibold text-fg">
              {label}
            </span>
            {inThread && (
              <span className="shrink-0 text-meta text-faint">In a thread</span>
            )}
            <span
              className={cn(
                "ml-auto shrink-0 text-meta text-faint tabular-nums",
                trailing && !isTouchPrimary && "group-hover:invisible",
              )}
            >
              {when}
            </span>
          </span>
          <span className="line-clamp-2 min-w-0 text-dim [&_*]:text-dim">
            <SlackText text={text} />
          </span>
        </span>
      </ListRow>
      {trailing && (
        <span
          className={cn(
            isTouchPrimary
              ? "absolute top-1/2 -right-3 -translate-y-1/2"
              : "absolute top-1.5 right-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100",
          )}
        >
          {trailing}
        </span>
      )}
    </li>
  );
}

/**
 * Drafts & sent: what you left unsent in a message box, and what you sent
 * lately, newest first. A draft opens its conversation (or thread) with the
 * text back in the box.
 */
export function DraftsPage({ navigate }: { navigate: Navigate }) {
  const [tab, setTab] = useState<Tab>("drafts");
  const drafts = useChannelDrafts();
  const [sent, setSent] = useState<SentMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { payload } = useSlackConversations();
  const conversations = payload?.conversations;

  function loadSent() {
    setError(null);
    return fetchSent()
      .then((body) => setSent(body.messages))
      .catch((e) => setError(errorMessage(e, "Couldn't load sent messages")));
  }

  const loadOnce = useEffectEvent(() => {
    if (sent === null) void loadSent();
  });
  useEffect(() => {
    if (tab === "sent") loadOnce();
  }, [tab]);

  const open = (channelId: string, thread?: string) =>
    navigate(
      thread
        ? { view: "channels", id: channelId, thread }
        : { view: "channels", id: channelId },
    );

  return (
    <PageLayout
      title="Drafts & sent"
      filters={
        <UnderlineTabs.Root
          value={tab}
          onValueChange={(value) =>
            setTab(value === "sent" ? "sent" : "drafts")
          }
          label="Drafts and sent messages"
        >
          <UnderlineTabs.Tab value="drafts" count={drafts.length || undefined}>
            Drafts
          </UnderlineTabs.Tab>
          <UnderlineTabs.Tab value="sent">Sent</UnderlineTabs.Tab>
        </UnderlineTabs.Root>
      }
    >
      {tab === "drafts" ? (
        drafts.length ? (
          <ul className="m-0 flex list-none flex-col p-0 pb-10">
            {drafts.map((draft) => {
              const { label, conversation } = conversationLabel(
                conversations,
                draft.channelId,
              );
              return (
                <MessageListRow
                  key={`${draft.channelId}:${draft.thread ?? ""}`}
                  conversation={conversation}
                  label={label}
                  inThread={!!draft.thread}
                  text={draft.text}
                  when={shortWhen(new Date(draft.at))}
                  onOpen={() => open(draft.channelId, draft.thread)}
                  trailing={
                    <Tooltip label="Delete draft">
                      <Button
                        variant="ghost"
                        size={isTouchPrimary ? "xl" : "md"}
                        icon={TRASH_GLYPH}
                        aria-label={`Delete draft to ${label}`}
                        onClick={() =>
                          deleteDraft(draft.channelId, draft.thread)
                        }
                      />
                    </Tooltip>
                  }
                />
              );
            })}
          </ul>
        ) : (
          <EmptyState
            className="py-16"
            icon={<IconPencil size={22} />}
            title="No drafts"
          >
            Anything you leave unsent in a message box waits here.
          </EmptyState>
        )
      ) : sent === null && !error ? (
        <LoadingState className="py-16" />
      ) : error ? (
        <InlineAlert appearance="plain" onRetry={() => void loadSent()}>
          {error}
        </InlineAlert>
      ) : sent?.length ? (
        <ul className="m-0 flex list-none flex-col p-0 pb-10">
          {sent.map((message) => {
            const { label, conversation } = conversationLabel(
              conversations,
              message.channelId,
              { name: message.channelName, isDirect: message.isDirect },
            );
            return (
              <MessageListRow
                key={`${message.channelId}:${message.ts}`}
                conversation={conversation}
                label={label}
                inThread={!!message.threadTs}
                text={message.text}
                when={shortWhen(new Date(Number(message.ts) * 1000))}
                onOpen={() => open(message.channelId, message.threadTs)}
              />
            );
          })}
        </ul>
      ) : (
        <EmptyState
          className="py-16"
          icon={<IconSend size={22} />}
          title="Nothing sent yet"
        >
          Messages you send in Slack show here.
        </EmptyState>
      )}
    </PageLayout>
  );
}
