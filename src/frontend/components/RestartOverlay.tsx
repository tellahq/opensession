import { BASE_PATH } from "../lib/base";
import React, { useEffect, useRef, useState } from "react";
import type { WSServerMessage } from "../lib/types";
import { PRODUCT_NAME } from "../lib/brand";
import { toast } from "../ui/toast";

const HEALTH_URL = `${BASE_PATH}/api/health`;
// Grace before showing anything — most socket blips reconnect within this.
const PILL_DELAY_MS = 2500;
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
 *    pure blip, the pill clears silently; changed → it really was a restart —
 *    a brief toast, then business as usual.
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
  const [phase, setPhase] = useState<"ok" | "reconnecting" | "restarting" | "crashed">("ok");
  const [backOnline, setBackOnline] = useState(false);
  // Who likely caused the restart: `by` on server_restarting (pill), `restartBy`
  // on the new server's hello (post-restart toast).
  const [restartBy, setRestartBy] = useState<string | null>(null);
  const restartByRef = useRef<string | null>(null);
  restartByRef.current = restartBy;
  const bootId = useRef<string | null>(null);
  const sawDown = useRef(false);
  // Set when the server explicitly told us it's going down; cleared only by
  // resolveRestart. The old instance's socket can stay open into the drain, so
  // "connected + health answering" alone must not clear the pill instantly.
  const explicit = useRef(false);
  const explicitAt = useRef(0);
  const disconnectedAt = useRef<number | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const resolveRestart = () => {
    explicit.current = false;
    if (phaseRef.current === "restarting") setPhase("ok");
    const by = restartByRef.current;
    toast(`${PRODUCT_NAME} restarted${by ? ` (${by})` : ""}.`);
  };

  // Adopt/compare a server-reported bootId. First sighting just records it —
  // unless an explicit restart is pending, where ANY fresh sighting after the
  // announcement is evidence of the new instance (a never-learned old bootId
  // must not wedge the pill). A change outside the restart flow means the
  // server restarted behind a blip-looking disconnect — say so briefly.
  const handleBootId = (id: unknown) => {
    if (typeof id !== "string" || !id) return;
    const prev = bootId.current;
    bootId.current = id;
    if (explicit.current) {
      if (!prev || id !== prev) resolveRestart();
      return;
    }
    if (prev && id !== prev) {
      const by = restartByRef.current;
      toast(
        `${PRODUCT_NAME} restarted${by ? ` (${by})` : ""}. Reconnected to the new server.`,
      );
    }
  };

  const handleHealth = (data: { bootId?: unknown }) => handleBootId(data.bootId);

  // Learn the current instance's bootId up front (also the fallback for
  // servers that don't send the hello frame yet).
  useEffect(() => {
    fetch(HEALTH_URL, { cache: "no-store" })
      .then((r) => r.json())
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
          if (phaseRef.current === "ok" || phaseRef.current === "reconnecting") {
            setPhase("restarting");
          }
        } else if (msg.type === "hello") {
          // Adopt the attribution BEFORE the bootId compare fires the
          // "restarted" toast so the toast can name the culprit — setState
          // is async, so write the ref directly too.
          if (msg.restartBy) {
            restartByRef.current = msg.restartBy;
            setRestartBy(msg.restartBy);
          }
          handleBootId(msg.bootId);
        }
      }),
    [addHandler]
  );

  // Disconnect tracking: after a short grace, show the calm reconnecting pill.
  // On reconnect, clear it and settle the blip-vs-restart question via bootId
  // (hello handles new servers; one health fetch covers old ones).
  useEffect(() => {
    if (connected) {
      disconnectedAt.current = null;
      if (phaseRef.current === "reconnecting") {
        setPhase(explicit.current ? "restarting" : "ok");
        fetch(HEALTH_URL, { cache: "no-store" })
          .then((r) => r.json())
          .then(handleHealth)
          .catch(() => {});
      }
      return;
    }
    if (phase !== "ok" && phase !== "restarting") return;
    disconnectedAt.current ??= Date.now();
    const t = setTimeout(() => setPhase("reconnecting"), phase === "restarting" ? 0 : PILL_DELAY_MS);
    return () => clearTimeout(t);
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
      try {
        const r = await fetch(HEALTH_URL, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
      } catch {
        if (!cancelled) {
          sawDown.current = true;
          setPhase("crashed");
        }
      }
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
      try {
        const d = await fetch(HEALTH_URL, { cache: "no-store" }).then((r) => r.json());
        if (!cancelled) handleHealth(d);
      } catch {}
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
      try {
        await fetch(HEALTH_URL, { cache: "no-store" }).then((r) => r.json());
        if (!cancelled) {
          setBackOnline(true);
          setTimeout(() => location.reload(), 700);
        }
      } catch {}
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [phase]);

  if (phase === "reconnecting" || phase === "restarting") {
    const restarting = phase === "restarting" || explicit.current;
    return (
      <div
        className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom,0px)+14px)] left-1/2 z-[200] flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-line-strong bg-panel/95 px-3.5 py-2 text-label font-medium text-fg shadow-control backdrop-blur-md"
        role="status"
        aria-live="polite"
      >
        <span
          aria-hidden
          className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current/25 border-t-current text-yellow"
        />
        <span>{restarting ? `${PRODUCT_NAME} is restarting` : "Connection lost"}</span>
        <span className="text-faint">
          {restarting && restartBy ? restartBy : "Retrying"}
        </span>
      </div>
    );
  }

  if (phase !== "crashed") return null;

  return (
    <div className="restart-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-[#070506]/82 p-6 backdrop-blur-sm" role="alertdialog" aria-live="assertive">
      <div className="restart-card flex max-w-[340px] flex-col items-center gap-3.5 rounded-panel border border-line bg-panel px-[26px] py-7 text-center">
        <div className={`restart-spinner size-[30px] animate-spin rounded-full border-[2.5px] border-line-strong border-t-accent ${backOnline ? "restart-spinner-done !animate-none !border-green !border-t-green" : ""}`} />
        <div className="restart-title text-item-title font-semibold text-fg">
          {backOnline ? "Back online" : `${PRODUCT_NAME} is restarting`}
        </div>
        <div className="restart-sub text-supporting leading-normal text-dim">
          {backOnline
            ? "Refreshing…"
            : "Hang tight. The page will refresh automatically once it's back up."}
        </div>
        {!backOnline && restartBy && (
          <div className="restart-by mt-1.5 max-w-full truncate text-label font-medium leading-normal text-dim opacity-80">Triggered by {restartBy}</div>
        )}
      </div>
    </div>
  );
}
