import * as Atom from "effect/unstable/reactivity/Atom";
import type * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import type { BrowserSignalStreams } from "./effect-browser-events";
import { browserSignalStreams } from "./effect-browser-events";
import * as EffectLifecycle from "./effect-lifecycle";

const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

type ActivityEvent = (typeof ACTIVITY_EVENTS)[number];

export type SessionSocketFiber =
  | "heartbeat"
  | "reconnect"
  | "resume-probe"
  | "presence-idle"
  | "typing-idle"
  | "visibility"
  | "focus"
  | "blur"
  | "online"
  | "pageshow"
  | "identity"
  | "outbox-retry"
  | "storage"
  | `activity:${ActivityEvent}`;

interface SessionSocketRuntimeCallbacks {
  readonly heartbeat: () => void;
  readonly resync: () => void;
  readonly syncPresence: () => void;
  readonly activity: () => void;
  readonly reconnectIdentity: () => void;
  readonly storage: (event: Event) => void;
}

export interface SessionSocketRuntime {
  readonly connectedAtom: Atom.Atom<boolean>;
  readonly configure: (callbacks: SessionSocketRuntimeCallbacks) => void;
  readonly setConnected: (connected: boolean) => void;
  readonly cancel: (
    key: Exclude<
      SessionSocketFiber,
      "heartbeat" | "visibility" | "focus" | "blur" | "online" | "pageshow"
    >,
  ) => void;
  readonly schedule: (
    key: Exclude<
      SessionSocketFiber,
      "heartbeat" | "visibility" | "focus" | "blur" | "online" | "pageshow"
    >,
    milliseconds: number,
    action: () => void,
  ) => void;
  readonly start: () => () => void;
}

const NOOP_CALLBACKS: SessionSocketRuntimeCallbacks = {
  heartbeat: () => {},
  resync: () => {},
  syncPresence: () => {},
  activity: () => {},
  reconnectIdentity: () => {},
  storage: () => {},
};

/** Pure construction. Browser streams and Effect fibers start only on mount. */
export function makeSessionSocketRuntime({
  registry,
  streams = browserSignalStreams,
  isVisible = () => document.visibilityState === "visible",
  windowTarget = () => window,
  makeLifecycle = () =>
    EffectLifecycle.makeEffectLifecycle<SessionSocketFiber>(),
}: {
  registry: AtomRegistry.AtomRegistry;
  streams?: BrowserSignalStreams;
  isVisible?: () => boolean;
  windowTarget?: () => Window;
  makeLifecycle?: () => EffectLifecycle.EffectLifecycle<SessionSocketFiber>;
}): SessionSocketRuntime {
  const connectedAtom = Atom.make(false);
  let callbacks = NOOP_CALLBACKS;
  let lifecycle: EffectLifecycle.EffectLifecycle<SessionSocketFiber> | null =
    null;
  let lifecycleId = 0;

  const schedule: SessionSocketRuntime["schedule"] = (
    key,
    milliseconds,
    action,
  ) => {
    const current = lifecycleId;
    lifecycle?.sleep(key, milliseconds, () => {
      if (current === lifecycleId) action();
    });
  };

  return {
    connectedAtom,
    configure(next) {
      callbacks = next;
    },
    setConnected(connected) {
      registry.set(connectedAtom, connected);
    },
    cancel(key) {
      lifecycle?.cancel(key);
    },
    schedule,
    start() {
      if (lifecycle) return () => {};
      const current = ++lifecycleId;
      const active = makeLifecycle();
      lifecycle = active;
      const currentCallbacks = () =>
        current === lifecycleId ? callbacks : NOOP_CALLBACKS;
      active.repeat("heartbeat", 20_000, () => currentCallbacks().heartbeat());
      active.stream("visibility", streams.visibility(), () => {
        const activeCallbacks = currentCallbacks();
        if (isVisible()) activeCallbacks.resync();
        activeCallbacks.syncPresence();
      });
      active.stream("focus", streams.focus(), () => {
        const activeCallbacks = currentCallbacks();
        activeCallbacks.resync();
        activeCallbacks.syncPresence();
      });
      active.stream("blur", streams.blur(), () =>
        currentCallbacks().syncPresence(),
      );
      active.stream("online", streams.online(), () =>
        currentCallbacks().resync(),
      );
      active.stream("pageshow", streams.pageShow(), () =>
        currentCallbacks().resync(),
      );
      const target = windowTarget();
      for (const type of ACTIVITY_EVENTS) {
        active.acquire(`activity:${type}`, () => {
          const listener = () => currentCallbacks().activity();
          target.addEventListener(type, listener, { passive: true });
          return () => target.removeEventListener(type, listener);
        });
      }
      active.acquire("identity", () => {
        const listener = () => currentCallbacks().reconnectIdentity();
        target.addEventListener("opensession-user-changed", listener);
        return () =>
          target.removeEventListener("opensession-user-changed", listener);
      });
      active.acquire("outbox-retry", () => {
        const listener = () => currentCallbacks().reconnectIdentity();
        target.addEventListener("opensession-command-outbox-retry", listener);
        return () =>
          target.removeEventListener(
            "opensession-command-outbox-retry",
            listener,
          );
      });
      active.acquire("storage", () => {
        const listener = (event: Event) => currentCallbacks().storage(event);
        target.addEventListener("storage", listener);
        return () => target.removeEventListener("storage", listener);
      });
      // The lifecycle must exist before this callback schedules the initial
      // focused presence lease.
      currentCallbacks().syncPresence();
      return () => {
        if (current !== lifecycleId) return;
        lifecycleId++;
        lifecycle = null;
        registry.set(connectedAtom, false);
        active.stop();
      };
    },
  };
}
