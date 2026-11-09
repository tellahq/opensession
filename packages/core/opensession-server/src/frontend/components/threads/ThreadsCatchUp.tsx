import { useEffect, useState } from "react";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useNavigation } from "../../hooks/useNavigation";
import { fetchThreadRecapApi } from "../../lib/api/workspaces";
import { useSessionRecords } from "../../lib/session-records";
import { openThreadPane } from "../../lib/thread-view";
import {
  markThreadsSeen,
  threadState,
  threadsSeenAt,
} from "../../lib/session-threads";
import type { UnifiedSession } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { IconX } from "../icons";
import { getCurrentUser } from "../UserPicker";
import { THREAD_DOT } from "./thread-classes";

/**
 * "Since you were last here", above the composer of a conversation that has
 * started threads: the agent's short catch-up on what they did while the
 * reader was away, and the threads it covers. Shown once per visit, only
 * when something changed.
 */
export function ThreadsCatchUp({ session }: { session: UnifiedSession }) {
  const sessions = useSessionRecords();
  if (!sessions.some((s) => s.parentSessionId === session.id)) return null;
  return <CatchUp key={session.id} rootId={session.id} />;
}

function CatchUp({ rootId }: { rootId: string }) {
  const [since] = useState(() => threadsSeenAt(rootId));
  const [recap, setRecap] = useState<{
    text: string | null;
    threadIds: string[];
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const sessions = useSessionRecords();
  const navigation = useNavigation();
  const phone = useIsPhone();

  // Stamp the visit now and again on leaving, so the next visit counts
  // from the last moment the reader had the conversation open.
  useEffect(() => {
    const stamp = () => markThreadsSeen(rootId, Date.now());
    stamp();
    window.addEventListener("pagehide", stamp);
    return () => {
      stamp();
      window.removeEventListener("pagehide", stamp);
    };
  }, [rootId]);

  useEffect(() => {
    if (since === null) return;
    let live = true;
    void fetchThreadRecapApi(rootId, since, getCurrentUser())
      .then((result) => {
        if (live) setRecap(result);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [rootId, since]);

  if (dismissed || !recap?.text) return null;
  const threads = recap.threadIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is UnifiedSession => !!s);
  return (
    <section
      aria-label="Since you were last here"
      className="mx-auto mb-2 flex w-full max-w-[calc(var(--session-col)+40px)] flex-col gap-2 rounded-xl border border-divider bg-raised px-3.5 py-3 phone:mx-3 phone:w-auto"
    >
      <div className="flex items-center gap-2">
        <h3 className="m-0 flex-1 text-label font-semibold text-fg">
          Since you were last here
        </h3>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Dismiss"
          icon={<IconX size={18} />}
          className="-my-1 phone:size-11"
          onClick={() => setDismissed(true)}
        />
      </div>
      <p className="m-0 text-supporting leading-relaxed text-fg">
        {recap.text}
      </p>
      {threads.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {threads.map((thread) => (
            <Button
              key={thread.id}
              size="sm"
              variant="soft"
              className="max-w-full gap-1.5 phone:min-h-11"
              onClick={() => {
                if (phone || !openThreadPane(rootId, thread.id))
                  navigation.openSession(thread.id);
              }}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  THREAD_DOT[threadState(thread)],
                )}
              />
              <span className="truncate">{thread.title}</span>
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
