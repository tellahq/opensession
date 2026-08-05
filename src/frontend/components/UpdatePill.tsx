import React, { useEffect, useState } from "react";
import type { WSServerMessage } from "../lib/types";
import { subscribeFrontendVersion } from "../lib/frontend-version";
import { Tooltip } from "../ui/tooltip";

interface Props {
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  // "toast" docks to the sidebar bottom (desktop). "pill" is the compact
  // topbar variant that sits next to the brand logo on phones.
  variant?: "toast" | "pill";
}

/** Grace before a forced update reloads a VISIBLE tab (hidden tabs reload
 *  immediately) — long enough to finish a thought, short enough that a
 *  protocol-break deploy converges in under a minute. */
const FORCE_GRACE_MS = 20_000;

/**
 * "A new version is available" nudge. Fired by the server's `frontend_updated`
 * broadcast after an in-process rebuild (no restart, so running sessions are
 * untouched).
 *
 * Refreshing is normally optional — new page loads already get the new build;
 * this just nudges already-open tabs — so it's non-blocking (it never covers
 * the composer). Desktop shows a toast docked to the sidebar bottom; phones
 * show a compact "Update" pill in the top bar, right after the brand logo.
 *
 * `force: true` broadcasts (POST /api/admin/frontend-reload — sent before a
 * server-side protocol change that old bundles can't follow) auto-reload
 * instead: hidden tabs immediately, visible tabs after a counted-down grace
 * shown on the pill/toast, or the moment the tab is hidden mid-countdown.
 */
export function UpdatePill({ addHandler, variant = "toast" }: Props) {
  const [show, setShow] = useState(false);
  const [by, setBy] = useState<string | null>(null);
  const [forceAt, setForceAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    // Let feedback paint before a potentially slow network-first navigation.
    setTimeout(() => location.reload(), 50);
  }

  useEffect(
    () =>
      addHandler((msg) => {
        if (msg.type !== "frontend_updated") return;
        setShow(true);
        if (msg.by) setBy(msg.by);
        if (msg.force) {
          if (document.hidden) {
            location.reload();
            return;
          }
          // Repeat broadcasts keep the EARLIEST deadline (no countdown resets).
          setForceAt((prev) => prev ?? Date.now() + FORCE_GRACE_MS);
        }
      }),
    [addHandler]
  );

  // Backstop for a window that missed the broadcast (an Electron renderer
  // asleep through the rebuild, a socket that reconnected across it): poll the
  // build version and nudge. Never forces — same non-blocking nudge as above.
  useEffect(() => subscribeFrontendVersion(() => setShow(true)), []);

  useEffect(() => {
    if (forceAt == null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((forceAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) location.reload();
    };
    tick();
    const iv = setInterval(tick, 500);
    // A tab backgrounded mid-countdown reloads right away — nobody's looking.
    const onVis = () => {
      if (document.hidden) location.reload();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [forceAt]);

  if (!show) return null;

  const forced = secondsLeft != null;

  if (variant === "pill") {
    return (
      <button
		className="update-pill inline-flex h-7 shrink-0 items-center rounded-full bg-red px-3 text-control-label font-semibold leading-none text-white transition-colors hover:bg-[color-mix(in_srgb,var(--red)_85%,black)] disabled:cursor-wait disabled:opacity-75 motion-reduce:animate-none"
        onClick={refresh}
        disabled={refreshing}
        role="status"
        aria-live="polite"
        title={
          forced
            ? `Updating in ${secondsLeft}s — tap to refresh now.`
            : `A new update is available${by ? ` (${by})` : ""}. Tap to refresh.`
        }
      >
        {refreshing ? "Refreshing…" : forced ? `Update ${secondsLeft}s` : "Update"}
      </button>
    );
  }

  return (
	<div className="update-toast absolute inset-x-2 bottom-2 z-[9500] flex items-center justify-between gap-3 rounded-lg border border-line bg-panel py-2.5 pl-4 pr-2.5 [animation:update-toast-in_0.28s_cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none" role="status" aria-live="polite">
	  <div className="update-toast-body flex min-w-0 flex-1 flex-col items-start gap-0.5">
		<span className="update-toast-text max-w-full truncate text-control-label font-medium leading-[1.3] text-fg">
          {forced ? `Updating in ${secondsLeft}s…` : "New update available"}
        </span>
        {by && (
          <Tooltip label={by} side="top" multiline>
			<span className="update-toast-by max-w-full truncate text-label font-medium leading-[1.3] text-dim">{by}</span>
          </Tooltip>
        )}
      </div>
	  <div className="update-toast-actions flex shrink-0 items-center gap-1">
        <button
		  className="update-toast-refresh inline-flex h-[30px] items-center rounded-control bg-red px-3.5 text-control-label font-semibold leading-none text-white transition-colors hover:bg-[color-mix(in_srgb,var(--red)_85%,black)] disabled:cursor-wait disabled:opacity-75 focus-ring"
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : forced ? "Refresh now" : "Refresh"}
        </button>
      </div>
    </div>
  );
}
