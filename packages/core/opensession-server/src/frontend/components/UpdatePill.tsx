import { os1Shell } from "../lib/os1-shell";
import React, { useEffect, useState } from "react";
import { z } from "zod";
import type { WSServerMessage } from "../lib/types";
import { PRODUCT_NAME } from "../lib/brand";
import { subscribeFrontendVersion } from "../lib/frontend-version";
import { PERSISTENT_NOTICE_CARD } from "../lib/notification-classes";
import { Tooltip } from "../ui/tooltip";

interface Props {
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  // "card" lives in the persistent desktop shelf. "pill" is the compact
  // topbar variant that sits next to the brand logo on phones.
  variant?: "card" | "pill";
}

/** Grace before a forced update reloads a VISIBLE tab (hidden tabs reload
 *  immediately) — long enough to finish a thought, short enough that a
 *  protocol-break deploy converges in under a minute. */
const FORCE_GRACE_MS = 20_000;

const shellUpdateStateSchema = z.object({
  state: z.enum(["idle", "available", "downloaded"]),
  version: z.string().nullable().optional(),
});

type ShellUpdateState = z.infer<typeof shellUpdateStateSchema>;

type ShellUpdates = {
  onState: (cb: (state: ShellUpdateState) => void) => (() => void) | undefined;
  install: () => void;
};

/** The mac shell's updater bridge — absent in a browser. `onState` replays the
 *  current state on subscribe, so a reload re-surfaces a staged update. */
function os1Updates(): ShellUpdates | undefined {
  const updates = os1Shell()?.updates;
  if (
    !(updates instanceof Object) ||
    !("onState" in updates) ||
    !(updates.onState instanceof Function) ||
    !("install" in updates) ||
    !(updates.install instanceof Function)
  )
    return undefined;

  const onState = updates.onState.bind(updates);
  const install = updates.install.bind(updates);
  return {
    onState: (callback) => {
      const handleState = (
        value: Parameters<typeof shellUpdateStateSchema.safeParse>[0],
      ) => {
        const state = shellUpdateStateSchema.safeParse(value);
        if (state.success) callback(state.data);
      };
      const unsubscribe = onState(handleState);
      return unsubscribe instanceof Function ? () => unsubscribe() : undefined;
    },
    install: () => install(),
  };
}

/**
 * The one "a new version is available" nudge, for both kinds of update:
 *
 *  - The **web bundle**, from the server's `frontend_updated` broadcast after
 *    an in-process rebuild (no restart, so running sessions are untouched) —
 *    a page refresh picks it up.
 *  - The **mac shell binary**, from the Squirrel updater behind
 *    `window.os1.updates` (packages/clients/mac/src/preload.js) — a relaunch installs it.
 *    We stay quiet through its "available" (still downloading) state: there is
 *    nothing to act on until it reports "downloaded".
 *
 * A staged shell update wins, because relaunching also loads the newest
 * frontend — so there is never more than one update message on screen.
 *
 * Acting is normally optional — new page loads already get the new build; this
 * just nudges already-open tabs — so it's non-blocking (it never covers the
 * composer). Desktop shows a toast over the sidebar bottom; phones show a
 * compact pill in the top bar, right after the brand logo.
 *
 * `force: true` broadcasts (POST /api/admin/frontend-reload — sent before a
 * server-side protocol change that old bundles can't follow) auto-reload
 * instead: hidden tabs immediately, visible tabs after a counted-down grace
 * shown on the pill/toast, or the moment the tab is hidden mid-countdown.
 */
export function UpdatePill({ addHandler, variant = "card" }: Props) {
  const [show, setShow] = useState(false);
  const [by, setBy] = useState<string | null>(null);
  const [forceAt, setForceAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [shellVersion, setShellVersion] = useState<string | null>(null);
  const [shellReady, setShellReady] = useState(false);

  function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    if (shellReady) {
      os1Updates()?.install();
      return;
    }
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
    [addHandler],
  );

  // Backstop for a window that missed the broadcast (an Electron renderer
  // asleep through the rebuild, a socket that reconnected across it): poll the
  // build version and nudge. Never forces — same non-blocking nudge as above.
  useEffect(() => subscribeFrontendVersion(() => setShow(true)), []);

  useEffect(() => {
    const updates = os1Updates();
    if (!updates?.onState) return;
    return updates.onState((s) => {
      setShellReady(s.state === "downloaded");
      setShellVersion(s.version ?? null);
    });
  }, []);

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

  if (!show && !shellReady) return null;

  const forced = secondsLeft != null;
  // A staged shell update replaces the refresh with a relaunch, which installs
  // the binary AND loads the newest frontend. Forced reloads still win: they
  // exist because the open bundle can no longer talk to the server.
  const restart = shellReady && !forced;
  const action = refreshing
    ? restart
      ? "Restarting…"
      : "Refreshing…"
    : forced
      ? "Refresh now"
      : restart
        ? "Restart"
        : "Refresh";
  const detail = restart ? shellVersion : by;

  if (variant === "pill") {
    return (
      <button
        // The pill keeps a squircle at a pill radius on purpose; base.css
        // exempts rounded-full from its generic squircle rule.
        className={
          "inline-flex h-7 shrink-0 items-center rounded-full [corner-shape:squircle] px-[13px] " +
          "cursor-pointer border-none bg-accent text-label font-semibold leading-none text-on-accent transition-[background] duration-[var(--dur-micro)] ease-[var(--ease)] hover:bg-accent-hover disabled:cursor-wait disabled:opacity-75 " +
          "animate-[update-toast-in_var(--dur-lg)_var(--ease)] motion-reduce:animate-none " +
          // Phone: keep the visible pill compact while a pseudo-element grows
          // its tap target to the full 44px header row.
          "phone:[.app-brand_&]:relative phone:[.app-brand_&]:order-3 " +
          "phone:[.app-brand_&]:h-7 phone:[.app-brand_&]:px-3 phone:[.app-brand_&]:text-supporting " +
          "phone:[.app-brand_&]:after:absolute phone:[.app-brand_&]:after:inset-x-0 " +
          "phone:[.app-brand_&]:after:top-1/2 phone:[.app-brand_&]:after:h-11 " +
          "phone:[.app-brand_&]:after:-translate-y-1/2 phone:[.app-brand_&]:after:content-['']"
        }
        onClick={refresh}
        disabled={refreshing}
        role="status"
        aria-live="polite"
        title={
          forced
            ? `Updating in ${secondsLeft}s. Tap to refresh now.`
            : restart
              ? `${PRODUCT_NAME} ${shellVersion ?? "update"} is ready. Tap to restart and install it.`
              : `A new update is available${by ? ` (${by})` : ""}. Tap to refresh.`
        }
      >
        <span className="[text-box:trim-both_cap_alphabetic]">
          {refreshing
            ? restart
              ? "Restarting…"
              : "Refreshing…"
            : forced
              ? `Update ${secondsLeft}s`
              : "Update"}
        </span>
      </button>
    );
  }

  return (
    <div className={PERSISTENT_NOTICE_CARD} role="status" aria-live="polite">
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <span className="max-w-full truncate text-supporting font-medium leading-[1.3] text-fg">
          {forced
            ? `Updating in ${secondsLeft}s…`
            : restart
              ? "Update ready"
              : "New update available"}
        </span>
        {detail && (
          <Tooltip label={detail} side="top" multiline>
            <span className="max-w-full truncate text-meta font-medium leading-[1.3] text-dim">
              {detail}
            </span>
          </Tooltip>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          className={
            "inline-flex h-7 items-center rounded-control px-3 cursor-pointer border-none bg-accent text-supporting font-semibold leading-none text-on-accent transition-[background] duration-[var(--dur-micro)] ease-[var(--ease)] hover:bg-accent-hover disabled:cursor-wait disabled:opacity-75"
          }
          onClick={refresh}
          disabled={refreshing}
        >
          <span className="[text-box:trim-both_cap_alphabetic]">{action}</span>
        </button>
      </div>
    </div>
  );
}
