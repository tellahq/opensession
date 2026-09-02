import {
  use,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from "react";
import { useAtomValue } from "@effect/atom-react/Hooks";
import { RegistryContext } from "@effect/atom-react/RegistryContext";
import type { WSServerMessage, WSClientMessage } from "../lib/types";
import { API_BASE, getWebSocketUrl } from "../lib/api";
import { countSessionPerf } from "../lib/session-performance";
import { withMutationRequestId } from "../lib/ws-request-id";
import { BASE_PATH } from "../lib/base";
import { toast } from "../ui/toast";
import { authGatesOut, whenCurrentUserReady } from "../lib/auth-ready";
import { publishAuthStatus } from "../components/UserPicker";
import {
  localCommandScope,
  shouldRetireCommandResult,
  wsCommandOutboxForScope,
} from "../lib/ws-command-outbox";
import { webSocketReconnectDelay } from "../lib/ws-reconnect";
import { IGNORE_WS_MESSAGES, type SessionSocket } from "./useSessionSocket";
import * as SessionSocketRuntime from "../lib/session-socket-runtime";

// Liveness probe cadence. iOS/Safari kills backgrounded sockets without firing
// onclose, leaving a half-open socket that reads as OPEN but delivers nothing —
// the "session frozen until refresh" trap. We ping over the app protocol (browsers
// can't send WS protocol pings) and force-close if nothing arrives back, which
// triggers the normal reconnect + re-watch path.
// Tighter deadline for the visibility-resume probe: coming back to a
// backgrounded PWA is exactly when the socket is most likely dead.
const RESUME_PROBE_MS = 4_000;
// How long a focused-but-untouched window still counts as "here". Focus alone
// can't tell "reading this" from "walked away with this window frontmost" —
// locking a Mac changes neither visibility nor focus — so presence needs a
// ceiling. Long enough to read a transcript or watch a run without your face
// blinking off, and it comes back on the next scroll. Kept inside the server's
// own idle window (PRESENCE_IDLE_MS in ws-hub.ts) so the face comes off at a
// predictable moment rather than on the next sweep.
const IDLE_MS = 8 * 60_000;
// While someone IS here, presence has to be re-earned: the server ages a quiet
// socket out, so a person reading and scrolling re-sends "still here" at this
// cadence — comfortably inside the server's window, rare enough to be free.
const ACTIVE_REFRESH_MS = 60_000;
// Composer activity is a short lease, refreshed before the server's 4s expiry.
// A pause retires it promptly even when the draft stays in the field.
const TYPING_REFRESH_MS = 2_000;
const TYPING_IDLE_MS = 3_000;
/**
 * One UI WebSocket. `presenceActive` controls only whether this surface may
 * claim the user's presence; its watch and transcript stream stay alive. This
 * matters for persistent/background surfaces such as the unfocused half of a
 * split and the dismissed Desk overlay.
 */

function parseServerMessage(data: string): WSServerMessage {
  const message: WSServerMessage = JSON.parse(data);
  return message;
}

function flushTypingOffSignal(
  typingRef: {
    current: { active: boolean; sessionId: string; lastSent: number };
  },
  wsRef: { current: WebSocket | null },
) {
  const typing = typingRef.current;
  const ws = wsRef.current;
  if (typing.active && ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(
        JSON.stringify({
          type: "typing",
          sessionId: typing.sessionId,
          typing: false,
        }),
      );
    } catch {}
  }
  typing.active = false;
}

export function useWebSocket(presenceActive = true) {
  const registry = use(RegistryContext);
  const [runtime] = useState(() =>
    SessionSocketRuntime.makeSessionSocketRuntime({ registry }),
  );
  const connected = useAtomValue(runtime.connectedAtom);
  const setConnected = runtime.setConnected;
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<((msg: WSServerMessage) => void)[]>([]);
  // Set on unmount so a straggling onclose (close() fires it async) can't
  // schedule a fresh reconnect into a dead component — the zombie-loop trap.
  const disposedRef = useRef(false);
  // Flipped true by ANY inbound message (pong or otherwise); the heartbeat
  // flips it false after each ping. Still false at the next beat = dead socket.
  const aliveRef = useRef(true);
  // Whether this socket has ever been accepted in this page's life. It is what
  // separates "the session died under an open tab" from "we are sitting on the
  // sign-in screen": this hook mounts ABOVE UserGate, so on the gate the socket
  // never opens and the upgrade 401s for ever. Reloading on that would be an
  // endless refresh of the sign-in card.
  const everOpenRef = useRef(false);
  // A graceful handoff gets a bounded fast reconnect loop until a replacement
  // server completes its hello. Ordinary outages retain the calmer 2s backoff.
  const handoffPendingRef = useRef(false);
  const commandResultsRef = useRef(false);
  const commandOutboxRef = useRef(wsCommandOutboxForScope(localCommandScope()));
  const commandNegotiatedRef = useRef(false);
  const negotiatingCommandsRef = useRef(new Map<string, WSClientMessage>());
  // Presence, tracked separately from the watch: a hidden or unfocused tab keeps
  // streaming its session (unread counts, notifications) but must stop telling
  // teammates its owner is looking at that session.
  const awayRef = useRef(false);
  const presenceActiveRef = useRef(presenceActive);
  useLayoutEffect(() => {
    presenceActiveRef.current = presenceActive;
  }, [presenceActive]);
  const syncPresenceRef = useRef<() => void>(() => {});
  const typingRef = useRef<{
    sessionId: string;
    active: boolean;
    lastSent: number;
  }>({ sessionId: "", active: false, lastSent: 0 });
  // Outbound messages issued while the socket wasn't OPEN (wifi switch, server
  // restart, PWA resume): held here and flushed in order on the next onopen, so
  // a transient drop doesn't silently swallow intent like create_session — the
  // "I clicked create, nothing happened after switching networks" bug. Bounded
  // so a long outage can't replay a stale flood.
  const outboxRef = useRef<{ msg: WSClientMessage; at: number }[]>([]);
  const feedCursorsRef = useRef(
    new Map<string, { feedEpoch: string; feedSeq: number }>(),
  );
  const OUTBOX_MAX = 50;
  const OUTBOX_TTL_MS = 30_000;
  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    // Already open OR mid-handshake — don't stack a second socket.
    const state = wsRef.current?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    commandResultsRef.current = false;
    commandNegotiatedRef.current = false;
    const ws = new WebSocket(getWebSocketUrl());
    wsRef.current = ws;
    aliveRef.current = true;

    const finishCommandNegotiation = (
      supported: boolean,
      commandScope?: string,
    ) => {
      if (wsRef.current !== ws || commandNegotiatedRef.current) return;
      commandResultsRef.current = supported;
      const commandOutbox = wsCommandOutboxForScope(
        commandScope || localCommandScope(),
      );
      const provisional = wsCommandOutboxForScope(localCommandScope());
      commandOutboxRef.current = commandOutbox;
      try {
        localStorage.setItem(
          "opensession-command-scope",
          commandScope || localCommandScope(),
        );
      } catch {}
      const inMemory = [...negotiatingCommandsRef.current.values()];
      negotiatingCommandsRef.current.clear();
      commandNegotiatedRef.current = true;
      if (!supported) {
        for (const command of inMemory) {
          try {
            ws.send(JSON.stringify(command));
            if ("requestId" in command && command.requestId)
              provisional.retireLegacy(command.requestId);
          } catch {
            if ("requestId" in command && command.requestId)
              negotiatingCommandsRef.current.set(command.requestId, command);
          }
        }
        return;
      }
      for (const ack of commandOutbox.pendingAcks()) {
        try {
          ws.send(JSON.stringify(ack));
        } catch {}
      }
      const existing = commandOutbox.pending();
      const existingIds = new Set(existing.map((command) => command.requestId));
      for (const command of existing) {
        try {
          ws.send(JSON.stringify(command));
        } catch {}
      }
      const candidates = new Map<string, WSClientMessage>();
      for (const candidate of [...provisional.pending(), ...inMemory])
        if ("requestId" in candidate && candidate.requestId)
          candidates.set(candidate.requestId, candidate);
      for (const [requestId, candidate] of candidates) {
        if (existingIds.has(requestId)) {
          if (provisional !== commandOutbox) provisional.forget(requestId);
          continue;
        }
        if (!commandOutbox.put(candidate)) {
          negotiatingCommandsRef.current.set(requestId, candidate);
          toast("A pending send needs storage before it can continue.", {
            variant: "error",
          });
          continue;
        }
        try {
          ws.send(JSON.stringify(candidate));
          if (provisional !== commandOutbox) provisional.forget(requestId);
        } catch {}
      }
    };

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      setConnected(true);
      everOpenRef.current = true;
      // Flush anything queued while we were down. FIFO preserves the order the
      // user issued them; skip messages that have gone stale.
      const now = Date.now();
      const pending = outboxRef.current;
      outboxRef.current = [];
      for (const item of pending) {
        if (now - item.at > OUTBOX_TTL_MS) continue;
        try {
          ws.send(JSON.stringify(item.msg));
        } catch {}
      }
      // Away state lives on the socket, so a fresh one starts present — a tab
      // that went away while the connection was down has to say so again.
      if (awayRef.current) {
        try {
          ws.send('{"type":"away","away":true}');
        } catch {}
      }
    };

    ws.onmessage = (e) => {
      if (wsRef.current !== ws) return; // superseded socket, ignore stragglers
      aliveRef.current = true;
      const data = String(e.data);
      const byteLength =
        e.data instanceof Blob
          ? 0
          : e.data instanceof ArrayBuffer || ArrayBuffer.isView(e.data)
            ? e.data.byteLength
            : data.length;
      countSessionPerf("ws_bytes_received", byteLength);
      try {
        const msg = parseServerMessage(data);
        if (!commandNegotiatedRef.current) {
          if (msg.type === "hello") {
            handoffPendingRef.current = false;
            finishCommandNegotiation(
              msg.capabilities?.commandResults === true,
              msg.commandScope,
            );
          } else finishCommandNegotiation(false);
        }
        if (msg.type === "server_restarting") handoffPendingRef.current = true;
        if (msg.type === "command_result" && shouldRetireCommandResult(msg)) {
          const acknowledged = commandOutboxRef.current.ack(
            msg.requestId,
            msg.sessionId,
          );
          if (!acknowledged) return;
          try {
            ws.send(
              JSON.stringify({
                type: "command_ack",
                sessionId: msg.sessionId,
                requestId: msg.requestId,
              } satisfies WSClientMessage),
            );
          } catch {}
        }
        if (msg.type === "command_ack_result") {
          commandOutboxRef.current.confirmAck(msg.requestId);
          for (const [requestId, command] of negotiatingCommandsRef.current) {
            if (!commandOutboxRef.current.put(command)) continue;
            negotiatingCommandsRef.current.delete(requestId);
            try {
              ws.send(JSON.stringify(command));
            } catch {}
            const provisional = wsCommandOutboxForScope(localCommandScope());
            if (provisional !== commandOutboxRef.current)
              provisional.forget(requestId);
          }
          return;
        }
        if (msg.type === "pong") return; // liveness only, not for handlers
        let delivered: WSServerMessage | null = msg;
        if (msg.type === "session_feed") {
          const cursor = feedCursorsRef.current.get(msg.sessionId);
          if (
            cursor?.feedEpoch === msg.feedEpoch &&
            msg.feedSeq <= cursor.feedSeq
          ) {
            delivered = null;
          } else {
            feedCursorsRef.current.set(msg.sessionId, {
              feedEpoch: msg.feedEpoch,
              feedSeq: msg.feedSeq,
            });
            delivered = msg.event;
          }
        } else if (msg.type === "feed_snapshot") {
          feedCursorsRef.current.set(msg.sessionId, {
            feedEpoch: msg.feedEpoch,
            feedSeq: msg.feedSeq,
          });
          // A stale cursor gets one cumulative active snapshot. Recreate the
          // ordinary stream events so every conversation surface shares the
          // same rendering path.
          if (msg.active) {
            const start: WSServerMessage = {
              type: "stream_start",
              sessionId: msg.sessionId,
              by: msg.active.by,
            };
            for (const handler of handlersRef.current) handler(start);
            if (msg.active.text) {
              const text: WSServerMessage = {
                type: "stream_text",
                sessionId: msg.sessionId,
                text: msg.active.text,
              };
              for (const handler of handlersRef.current) handler(text);
            }
          }
          delivered = null;
        }
        if (delivered) {
          for (const handler of handlersRef.current) {
            handler(delivered);
          }
        }
      } catch {}
    };

    ws.onclose = async (event) => {
      // A close from an already-replaced socket must not flip `connected` or
      // schedule a competing reconnect — only the current socket owns state.
      if (wsRef.current !== ws) return;
      setConnected(false);
      if (disposedRef.current) return;
      if (event.code === 4001) {
        window.location.reload();
        return;
      }
      if (event.code === 1006) {
        try {
          const response = await fetch(`${API_BASE}/auth/status`);
          const status = response.ok ? await response.json() : null;
          if (status?.local && !status.authenticated) return;
          if (authGatesOut(status)) {
            if (everOpenRef.current) {
              // The session stopped being accepted while this tab stayed open:
              // it expired, or the GitHub grant behind it died. Retrying every
              // 2s for ever leaves a live-looking app that can reach nothing, so
              // reload into the gate, which asks for the sign-in that repairs it.
              window.location.reload();
              return;
            }
            // A socket that never opened means a fresh load into a gated
            // instance (the upgrade 401s immediately). Reloading here would loop
            // on the sign-in card, whose own socket also 401s, so publish the
            // gated status instead: UserGate renders the sign-in card over the
            // optimistically-painted app. Fall through to keep retrying, so a
            // completed sign-in reconnects without a manual refresh.
            publishAuthStatus(status);
          }
        } catch {}
      }
      if (disposedRef.current || wsRef.current !== ws) return;
      runtime.schedule(
        "reconnect",
        webSocketReconnectDelay(event.code, handoffPendingRef.current),
        () => connectRef.current(),
      );
    };

    ws.onerror = () => ws.close();
  }, [runtime, setConnected]);
  useLayoutEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    disposedRef.current = false;
    const cancelInitialConnect = whenCurrentUserReady(() => connect());

    // Foregrounding the tab/PWA (or the network coming back): reconnect a
    // closed socket immediately (skip the 2s backoff), and probe an "open" one
    // right away — if the probe gets no answer, close → reconnect.
    const resync = () => {
      if (disposedRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        runtime.cancel("reconnect");
        connect();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return; // handshake in flight
      aliveRef.current = false;
      try {
        ws.send('{"type":"ping"}');
      } catch {}
      runtime.schedule("resume-probe", RESUME_PROBE_MS, () => {
        // Only judge the same socket we probed — it may have been replaced.
        if (wsRef.current === ws && !aliveRef.current) {
          try {
            ws.close();
          } catch {}
        }
      });
    };
    // Presence follows attention: this window is visible AND focused AND its
    // owner has touched it recently. The watch deliberately outlives all three
    // — a backgrounded tab still streams — so presence needs its own signal,
    // or a window left frontmost overnight keeps claiming someone is reading it.
    let lastSentAway = 0;
    const sendAway = (away: boolean, force = false) => {
      if (awayRef.current === away && !force) return;
      awayRef.current = away;
      const ws = wsRef.current;
      // Never queued: a stale "I'm back" replayed after an outage would lie.
      // A reconnect starts present, and onopen re-sends away if we still are.
      if (ws?.readyState !== WebSocket.OPEN) return;
      lastSentAway = Date.now();
      try {
        ws.send(JSON.stringify({ type: "away", away }));
      } catch {}
    };
    const focused = () =>
      presenceActiveRef.current &&
      document.visibilityState === "visible" &&
      document.hasFocus();
    const syncPresence = () => {
      if (!focused()) {
        runtime.cancel("presence-idle");
        sendAway(true);
        return;
      }
      onActivity();
    };
    let lastActivity = 0;
    function onActivity() {
      // A pointer moving across an unfocused window is not attention.
      if (!focused()) return;
      const now = Date.now();
      // Pointer moves fire continuously: only the first per second does work.
      // While away the point is to come back at once, so it skips the throttle.
      if (!awayRef.current && now - lastActivity < 1000) return;
      lastActivity = now;
      // Re-send even when we were already here: the server ages presence out,
      // so staying visible to teammates means saying so every so often. A
      // reader who has stopped moving simply stops paying it, and their face
      // comes off — which is the point.
      sendAway(false, now - lastSentAway >= ACTIVE_REFRESH_MS);
      runtime.schedule("presence-idle", IDLE_MS, () => sendAway(true));
    }
    syncPresenceRef.current = syncPresence;
    const reconnectForIdentity = () => {
      commandNegotiatedRef.current = false;
      commandResultsRef.current = false;
      const oldSocket = wsRef.current;
      wsRef.current = null;
      oldSocket?.close();
      connect();
    };
    // Disposal marks. Kept in a setup-scope helper so teardown reads/writes
    // the latest refs without touching them directly in the cleanup body.
    const stopPresence = () => {
      disposedRef.current = true;
      syncPresenceRef.current = () => {};
    };
    runtime.configure({
      heartbeat: () => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!aliveRef.current) {
          try {
            ws.close();
          } catch {}
          return;
        }
        aliveRef.current = false;
        try {
          ws.send('{"type":"ping"}');
        } catch {}
      },
      resync,
      syncPresence,
      activity: onActivity,
      reconnectIdentity: reconnectForIdentity,
      storage: (event) => {
        if ("key" in event && event.key === "opensession-user")
          reconnectForIdentity();
      },
    });
    const stopRuntime = runtime.start();

    return () => {
      stopPresence();
      cancelInitialConnect();
      flushTypingOffSignal(typingRef, wsRef);
      stopRuntime();
      const closeTarget = wsRef.current;
      // Fence every late callback before close dispatches its asynchronous
      // event. A disposed registry must never receive a stale setConnected.
      wsRef.current = null;
      closeTarget?.close();
    };
  }, [connect, runtime]);

  // A mounted surface can become foreground/background without replacing its
  // socket (split focus changes; the Desk opens and closes). Re-evaluate its
  // presence immediately instead of waiting for the next pointer or focus event.
  useEffect(() => {
    syncPresenceRef.current();
  }, [presenceActive]);

  const send = useCallback(
    (msg: WSClientMessage) => {
      msg = withMutationRequestId(msg);
      const mutationRequestId = "requestId" in msg ? msg.requestId : undefined;
      if (mutationRequestId && !commandNegotiatedRef.current) {
        const provisional = wsCommandOutboxForScope(localCommandScope());
        if (!provisional.put(msg))
          throw new Error(
            "Pending sends are using local storage. Reconnect or forget one before sending more.",
          );
        negotiatingCommandsRef.current.set(mutationRequestId, msg);
        const pendingSocket = wsRef.current;
        if (!pendingSocket || pendingSocket.readyState === WebSocket.CLOSED) {
          runtime.cancel("reconnect");
          connect();
        }
        return;
      }
      const durableMutation = commandResultsRef.current
        ? commandOutboxRef.current.put(msg)
        : false;
      if (mutationRequestId && commandResultsRef.current && !durableMutation)
        throw new Error(
          "Could not save this command for reconnect. It was not sent.",
        );
      if (msg.type === "watch") {
        const cursor = feedCursorsRef.current.get(msg.sessionId);
        const watch = { ...msg, supportsFeed: true };
        if (cursor) {
          watch.sinceFeedSeq = cursor.feedSeq;
          watch.feedEpoch = cursor.feedEpoch;
        }
        msg = watch;
      }
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(msg));
          return;
        } catch {
          // send threw mid-drop — fall through and queue it for the reconnect.
        }
      }
      // Durable mutations replay from their receipt outbox after reconnect.
      if (durableMutation) {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
          runtime.cancel("reconnect");
          connect();
        }
        return;
      }
      // Liveness pings are worthless once stale — never queue them.
      if (msg.type === "ping") return;
      const box = outboxRef.current;
      box.push({ msg, at: Date.now() });
      // Keep only the most recent OUTBOX_MAX (drop oldest intent first).
      if (box.length > OUTBOX_MAX) box.splice(0, box.length - OUTBOX_MAX);
      // Don't wait out the 2s backoff — try to reconnect right now so the
      // queued message goes out as soon as possible.
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        runtime.cancel("reconnect");
        connect();
      }
    },
    [connect, runtime],
  );

  const setTyping = useCallback(
    (sessionId: string, active: boolean) => {
      const state = typingRef.current;
      const ws = wsRef.current;
      const emit = (id: string, typing: boolean) => {
        if (ws?.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ type: "typing", sessionId: id, typing }));
        } catch {}
      };

      if (!active) {
        runtime.cancel("typing-idle");
        if (state.active) emit(state.sessionId, false);
        state.active = false;
        state.lastSent = 0;
        return;
      }

      if (state.active && state.sessionId !== sessionId) {
        emit(state.sessionId, false);
        state.active = false;
        state.lastSent = 0;
      }
      state.sessionId = sessionId;
      const now = Date.now();
      if (!state.active || now - state.lastSent >= TYPING_REFRESH_MS) {
        emit(sessionId, true);
        state.lastSent = now;
      }
      state.active = true;
      runtime.schedule("typing-idle", TYPING_IDLE_MS, () => {
        const latest = typingRef.current;
        if (!latest.active || latest.sessionId !== sessionId) return;
        const socket = wsRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          try {
            socket.send(
              JSON.stringify({ type: "typing", sessionId, typing: false }),
            );
          } catch {}
        }
        latest.active = false;
        latest.lastSent = 0;
      });
    },
    [runtime],
  );

  const addHandler = useCallback((handler: (msg: WSServerMessage) => void) => {
    handlersRef.current.push(handler);
    return () => {
      handlersRef.current = handlersRef.current.filter((h) => h !== handler);
    };
  }, []);
  const [sessionSocket] = useState<SessionSocket>(() => ({ send, addHandler }));
  const [sessionSocketIgnoringMessages] = useState<SessionSocket>(() => ({
    send,
    addHandler: IGNORE_WS_MESSAGES,
  }));

  return {
    connected,
    send,
    setTyping,
    addHandler,
    sessionSocket,
    sessionSocketIgnoringMessages,
  };
}
