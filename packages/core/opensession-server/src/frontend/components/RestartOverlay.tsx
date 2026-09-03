import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import type { WSServerMessage } from "../lib/types";
import { PRODUCT_NAME } from "../lib/brand";
import { dismissToast, toast } from "../ui/toast";
import { fetchHealthStatus, type HealthStatus } from "../lib/health";
import { CONNECTION_PRESENTATION_GRACE_MS } from "../lib/connection-presentation";
import {
  bootTransition,
  resolvedRestartPhase,
  type RestartPhase,
} from "../lib/restart-boot";

// A disconnect older than this whose health probe ALSO fails escalates from
// the calm pill to the full restart overlay (covers hard crashes).
const ESCALATE_AFTER_MS = 22_000;
// Failsafe for the explicit-restart pill: restarts are ~1-2s, so if we're
// connected and healthy this long after the server said it was going down,
// call it done even without bootId evidence (a null pre-restart bootId used
// to wedge the old overlay on screen until a manual refresh).
const EXPLICIT_SETTLE_MS = 20_000;

interface Props {
  connected: boolean;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
}

/**
 * Connection-state UI, differentiating a transient socket drop from a real
 * server restart (iOS PWA sockets die constantly on backgrounding — that must
 * never look like a deploy):
 *
 *  - Socket loss with no restart signal → a calm "Reconnecting…" pill while
 *    useWebSocket retries. On reconnect the server's bootId (hello frame;
 *    /api/health fallback for servers without it) is compared: unchanged →
 *    pure blip; changed → it really was a restart, so a fallback receipt says
 *    so even if the pre-restart broadcast was lost.
 *  - An explicit `server_restarting` broadcast (graceful drain) shows the same
 *    NON-blocking pill — restarts complete in a couple of seconds and Caddy
 *    parks in-flight requests, so nothing needs to block the composer or
 *    navigation. It clears on evidence of the new instance (hello / changed
 *    bootId), or via the settle failsafe. A restart that shipped new frontend
 *    code is UpdatePill's job (its version-poll backstop covers reconnects),
 *    so no forced reload here.
 *  - The full-screen overlay is reserved for hard crashes: reconnects failing
 *    for a while AND health unreachable. It auto-reloads once the server
 *    answers again — that page state is suspect anyway.
 */
export function RestartOverlay({ connected, addHandler }: Props) {
  const [phase, setPhase] = useState<RestartPhase>("ok");
  const [backOnline, setBackOnline] = useState(false);
  // Who likely caused the restart: `by` on server_restarting, or `restartBy`
  // on the new server's hello.
  const [restartBy, setRestartBy] = useState<string | null>(null);
  const bootId = useRef<string | null>(null);
  const sawDown = useRef(false);
  const statusToast = useRef<number | null>(null);
  // Set when the server explicitly told us it's going down; cleared only by
  // resolveRestart. The old instance's socket can stay open into the drain, so
  // "connected + health answering" alone must not clear the pill instantly.
  const explicit = useRef(false);
  const explicitAt = useRef(0);
  const disconnectedAt = useRef<number | null>(null);
  const phaseRef = useRef(phase);
  useLayoutEffect(() => {
    phaseRef.current = phase;
  });

  const resolveRestart = () => {
    explicit.current = false;
    if (statusToast.current !== null) {
      dismissToast(statusToast.current);
      statusToast.current = null;
    }
    setPhase(resolvedRestartPhase);
  };

  // Adopt/compare a server-reported bootId. The first sighting is only a
  // baseline: a health request made after the announcement can still be
  // answered by the draining process, so it must not clear the notice. If the
  // announcement itself was lost, a changed bootId provides a fallback receipt.
  const handleBootId = (id: string) => {
    const transition = bootTransition(bootId.current, id);
    bootId.current = id;
    if (explicit.current) {
      if (transition === "changed") resolveRestart();
      return;
    }
    if (transition === "changed") {
      toast(`${PRODUCT_NAME} restarted`, { variant: "success" });
    }
  };

  const handleHealth = (data: HealthStatus) => {
    const result = z.string().min(1).safeParse(data.bootId);
    if (result.success) handleBootId(result.data);
  };

  // Learn the current instance's bootId up front (also the fallback for
  // servers that don't send the hello frame yet).
  useEffect(() => {
    fetchHealthStatus()
      .then(handleHealth)
      .catch(() => {});
  }, []);

  // Note: a frontend-only rebuild changes no state this component watches (the
  // socket holds, bootId is unchanged). That's UpdatePill's job — it nudges,
  // deliberately without reloading a window someone may be working in.

  // Server signals: explicit "I'm going down", and the per-connect hello.
  useEffect(
    () =>
      addHandler((msg) => {
        if (msg.type === "server_restarting") {
          explicit.current = true;
          explicitAt.current = Date.now();
          if (msg.by) setRestartBy(msg.by);
          if (
            phaseRef.current === "ok" ||
            phaseRef.current === "reconnecting"
          ) {
            setPhase("restarting");
          }
        } else if (msg.type === "hello") {
          if (msg.restartBy) setRestartBy(msg.restartBy);
          handleBootId(msg.bootId);
        }
      }),
    [addHandler],
  );

  // Disconnect tracking: after a foreground grace, show the calm reconnecting
  // pill. Backgrounding a PWA routinely kills its socket, so hiding the page
  // cancels the grace and reopening starts it again instead of flashing stale
  // connection state. On reconnect, clear the pill and settle the
  // blip-vs-restart question via bootId (hello handles new servers; one health
  // fetch covers old ones).
  useEffect(() => {
    if (connected) {
      disconnectedAt.current = null;
      if (phaseRef.current === "reconnecting") {
        setPhase(explicit.current ? "restarting" : "ok");
        fetchHealthStatus()
          .then(handleHealth)
          .catch(() => {});
      }
      return;
    }
    if (disconnectedAt.current === null) disconnectedAt.current = Date.now();
    if (phase === "crashed") return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === "hidden") {
        if (phaseRef.current === "reconnecting" && !explicit.current)
          setPhase("ok");
        return;
      }
      if (phaseRef.current !== "ok" && phaseRef.current !== "restarting")
        return;
      const delay =
        phaseRef.current === "restarting"
          ? 0
          : CONNECTION_PRESENTATION_GRACE_MS;
      timer = setTimeout(() => {
        if (document.visibilityState !== "hidden") setPhase("reconnecting");
      }, delay);
    };

    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [connected, phase]);

  // Escalation: still disconnected after a while AND health unreachable →
  // treat as a hard crash. While health answers, the server is up and only the
  // socket is broken — stay calm and keep retrying.
  useEffect(() => {
    if (phase !== "reconnecting" || connected) return;
    let cancelled = false;
    const iv = setInterval(async () => {
      const started = disconnectedAt.current ?? Date.now();
      if (Date.now() - started < ESCALATE_AFTER_MS) return;
      await (async () => {
        await fetchHealthStatus();
      })().catch(async () => {
        if (!cancelled) {
          sawDown.current = true;
          setPhase("crashed");
        }
      });
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [phase, connected]);

  // Explicit-restart pill: poll health for the new instance's bootId and give
  // up gracefully once we're connected and settled (see EXPLICIT_SETTLE_MS).
  useEffect(() => {
    if (phase !== "restarting") return;
    let cancelled = false;
    const iv = setInterval(async () => {
      if (cancelled || !explicit.current) return;
      if (connected && Date.now() - explicitAt.current > EXPLICIT_SETTLE_MS) {
        resolveRestart();
        return;
      }
      await (async () => {
        const d = await fetchHealthStatus();
        if (!cancelled) handleHealth(d);
      })().catch(async () => {});
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [phase, connected]);

  // Hard crash: poll health and reload once the server answers again.
  useEffect(() => {
    if (phase !== "crashed") return;
    let cancelled = false;
    const iv = setInterval(async () => {
      await (async () => {
        await fetchHealthStatus();
        if (!cancelled) {
          setBackOnline(true);
          setTimeout(() => location.reload(), 700);
        }
      })().catch(async () => {});
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [phase]);

  // Connection recovery uses the regular toast lane above the composer. Unlike
  // a receipt, this status has no expiry line and stays until recovery settles.
  useEffect(() => {
    if (phase !== "reconnecting" && phase !== "restarting") return;
    const restarting = phase === "restarting" || explicit.current;
    const id = toast(
      restarting
        ? `Restarting${restartBy ? ` · ${restartBy}` : ""}`
        : "Connection lost · Retrying",
      { ongoing: true },
    );
    statusToast.current = id;
    return () => {
      dismissToast(id);
      if (statusToast.current === id) statusToast.current = null;
    };
  }, [phase, restartBy]);

  if (phase !== "crashed") return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/82 p-6 backdrop-blur-[4px]"
      role="alertdialog"
      aria-live="assertive"
    >
      <div className="flex max-w-[340px] flex-col items-center gap-3.5 rounded-lg border border-line bg-panel px-[26px] py-7 text-center">
        <div
          className={`size-[30px] rounded-full border-2 ${
            backOnline
              ? "border-green border-t-green"
              : "animate-[spin_0.8s_linear_infinite] border-line-strong border-t-accent"
          }`}
        />
        {/* Deliberately not "is restarting": that's the calm pill's copy, and
            this state is the one that reloads your page. */}
        <div className="text-item-title font-semibold text-fg">
          {backOnline ? "Back online" : `${PRODUCT_NAME} isn't responding`}
        </div>
        <div className="text-label leading-[1.5] text-dim">
          {backOnline
            ? "Refreshing…"
            : "The page will refresh automatically once the server is back."}
        </div>
        {!backOnline && restartBy && (
          <div className="mt-1.5 max-w-full truncate text-label font-medium leading-[1.4] text-dim opacity-80">
            Triggered by {restartBy}
          </div>
        )}
      </div>
    </div>
  );
}
