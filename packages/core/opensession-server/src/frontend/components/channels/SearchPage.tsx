import { useEffect, useState } from "react";
import type { Route } from "../../lib/app-route";
import {
  searchMessages,
  type SearchResult,
  type SearchResultsPage,
} from "../../lib/api/slack-channels";
import { groupSearchResults } from "../../lib/channel-search";
import { jumpKey, requestJump } from "../../lib/channel-jump";
import { errorMessage } from "../../lib/error-message";
import {
  conversationLabel,
  useSlackConversations,
} from "../../lib/slack-conversations";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { ListRow } from "../../ui/list-row";
import { PageLayout } from "../../ui/page";
import { Segmented, SegmentedOption } from "../../ui/segmented";
import { EmptyState, InlineAlert, LoadingState } from "../../ui/state";
import { IconSearch } from "../icons";
import { ChannelMessageRow } from "./ChannelMessageRow";
import { ConversationGlyph } from "./ConversationList";

type Navigate = (route: Route, opts?: { replace?: boolean }) => void;
type Sort = "score" | "timestamp";

const SEARCH_GLYPH = <IconSearch size={22} />;

/**
 * Search: Slack's message search as the person, from the field at the top.
 * Matches are grouped by conversation, best first or newest first, and each
 * opens its conversation (or thread) at the message.
 */
export function SearchPage({
  query,
  navigate,
}: {
  query?: string;
  navigate: Navigate;
}) {
  const [draft, setDraft] = useState(query ?? "");
  const [sort, setSort] = useState<Sort>("score");
  const [pages, setPages] = useState<SearchResultsPage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { payload } = useSlackConversations();

  useEffect(() => {
    setDraft(query ?? "");
  }, [query]);

  useEffect(() => {
    setPages([]);
    setError(null);
    if (!query) return;
    let alive = true;
    setLoading(true);
    void searchMessages(query, { sort })
      .then((page) => alive && setPages([page]))
      .catch((e) => alive && setError(errorMessage(e, "Couldn't search Slack")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [query, sort, reloadKey]);

  const last = pages.at(-1);
  const results = pages.flatMap((page) => page.results);

  function loadMore() {
    if (!query || !last || loading) return;
    setLoading(true);
    void searchMessages(query, { sort, page: last.page + 1 })
      .then((page) => setPages((current) => [...current, page]))
      .catch((e) => setError(errorMessage(e, "Couldn't search Slack")))
      .finally(() => setLoading(false));
  }

  function open(result: SearchResult) {
    const { channelId, threadTs, message } = result;
    requestJump(jumpKey(channelId, threadTs), message.ts);
    navigate(
      threadTs
        ? { view: "channels", id: channelId, thread: threadTs }
        : { view: "channels", id: channelId },
    );
  }

  const filters = (
    <form
      role="search"
      className="flex w-full flex-wrap items-center gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        const next = draft.trim();
        if (next)
          navigate(
            { view: "channels", page: "search", query: next },
            { replace: !!query },
          );
      }}
    >
      <Input
        type="search"
        aria-label="Search Slack"
        placeholder="Search messages"
        value={draft}
        autoFocus={!query}
        enterKeyHint="search"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Enter searches even where a keyboard sends no keypress.
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
        className="min-w-0 flex-1 basis-60"
      />
      <Segmented
        label="Sort"
        value={sort}
        onValueChange={(value) =>
          setSort(value === "timestamp" ? "timestamp" : "score")
        }
      >
        <SegmentedOption value="score">Most relevant</SegmentedOption>
        <SegmentedOption value="timestamp">Newest</SegmentedOption>
      </Segmented>
    </form>
  );

  return (
    <PageLayout title="Search" filters={filters}>
      {!query ? (
        <EmptyState className="py-12" icon={SEARCH_GLYPH} title="Search Slack">
          Find messages in every conversation you can read. Slack's modifiers
          work too, like in:#design or from:@name.
        </EmptyState>
      ) : loading && !results.length ? (
        <LoadingState className="py-12" />
      ) : error && !results.length ? (
        <InlineAlert
          appearance="plain"
          onRetry={() => setReloadKey((key) => key + 1)}
        >
          {error}
        </InlineAlert>
      ) : !results.length ? (
        <EmptyState className="py-12" icon={SEARCH_GLYPH} title="No matches">
          Try other words, or fewer of them.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-6 pb-10">
          <p className="m-0 text-meta text-dim tabular-nums">
            {last && last.total > results.length
              ? `${results.length} of ${last.total} messages`
              : `${results.length} ${results.length === 1 ? "message" : "messages"}`}
          </p>
          {groupSearchResults(results).map((group) => {
            const first = group.results[0]!;
            const { label, conversation } = conversationLabel(
              payload?.conversations,
              group.channelId,
              { name: first.channelName, isDirect: first.isDirect },
            );
            return (
              <section
                key={group.channelId}
                aria-label={label}
                className="flex flex-col gap-2"
              >
                <ListRow
                  onClick={() =>
                    navigate({ view: "channels", id: group.channelId })
                  }
                  className="min-h-0 w-auto items-center gap-2 self-start px-1.5 py-1 text-item-title font-semibold text-fg hover:bg-hover"
                >
                  <ConversationGlyph conversation={conversation} size={20} />
                  <span className="truncate">{label}</span>
                </ListRow>
                <div className="flex flex-col rounded-xl bg-panel p-1">
                  {group.results.map((result) => (
                    <ChannelMessageRow
                      key={result.message.ts}
                      channelId={result.channelId}
                      message={result.message}
                      head
                      className="rounded-lg"
                      inThread={!!result.threadTs}
                      onJump={() => open(result)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {last && last.page < last.pages && (
            <Button variant="ghost" disabled={loading} onClick={loadMore}>
              {loading ? "Loading…" : "Show more"}
            </Button>
          )}
        </div>
      )}
    </PageLayout>
  );
}
