import { useEffect, useState } from "react";
import { fetchActivity, type SearchResult } from "../lib/api/slack-channels";
import { errorMessage } from "../lib/error-message";

const POLL_MS = 60_000;

export interface ChannelActivityState {
  /** Null until the first answer. */
  items: SearchResult[] | null;
  error: string | null;
  reload: () => void;
}

/** Messages that mention you, newest first, polled once a minute (the
 *  server caches Slack's answer for as long). */
export function useChannelActivity(enabled = true): ChannelActivityState {
  const [items, setItems] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      fetchActivity()
        .then((body) => {
          if (!alive) return;
          setItems(body.items);
          setError(null);
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e, "Couldn't load your mentions"));
        });
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, reloadKey]);
  return { items, error, reload: () => setReloadKey((key) => key + 1) };
}
