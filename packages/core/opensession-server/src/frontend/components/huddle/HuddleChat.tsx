import { useEffect, useRef, useState } from "react";
import { sendHuddleChat } from "../../lib/huddle";
import type { HuddleChatMessage } from "../../lib/types";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The huddle's text chat: for a link, a command, or a word from someone who
 * can't talk right now. It lasts as long as the huddle, and with notes on it
 * goes into the summary too.
 */
export function HuddleChat({ messages }: { messages: HuddleChatMessage[] }) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  useEffect(() => {
    const list = listRef.current;
    if (list && count > 0) list.scrollTop = list.scrollHeight;
  }, [count]);

  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={listRef}
        role="log"
        aria-label="Huddle chat"
        className="flex max-h-[220px] flex-col gap-1.5 overflow-y-auto px-0.5"
      >
        {count === 0 ? (
          <p className="m-0 text-meta text-faint">
            Nothing yet. Messages last as long as the huddle.
          </p>
        ) : (
          messages.map((m, i) => {
            const continued =
              i > 0 &&
              messages[i - 1]?.user === m.user &&
              m.at - (messages[i - 1]?.at ?? 0) < 120_000;
            return (
              <div key={m.id} className="min-w-0">
                {!continued && (
                  <div className="flex items-baseline gap-1.5 text-meta">
                    <span className="truncate font-semibold text-fg">
                      {m.user}
                    </span>
                    <span className="shrink-0 text-faint">{clock(m.at)}</span>
                  </div>
                )}
                <p className="m-0 whitespace-pre-wrap break-words text-sm text-fg">
                  {m.text}
                </p>
              </div>
            );
          })
        )}
      </div>
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          sendHuddleChat(draft);
          setDraft("");
        }}
      >
        <Input
          value={draft}
          maxLength={2000}
          placeholder="Message the huddle"
          aria-label="Message the huddle"
          className="min-w-0 flex-1 phone:h-11 phone:text-base"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="sm"
          variant="soft"
          type="submit"
          className="phone:min-h-11"
          disabled={!draft.trim()}
        >
          Send
        </Button>
      </form>
    </div>
  );
}
