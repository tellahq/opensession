import { os1Shell } from "./os1-shell";

// Desktop-notification + sound alerts for your own sessions: when one flips into
// "needs input" (blocked on an AskUserQuestion) or finishes a run. All behaviour
// is driven by a single preference object persisted in localStorage and edited in
// Settings › Notifications. The desktop banner additionally requires the browser's
// own Notification permission.

export type NotifSound = "chime" | "ping" | "bell" | "none";
export type NotifWhen = "always" | "unfocused" | "off";
export type NotifEvent = "needsInput" | "done";

export interface NotifSettings {
  /** Show a desktop banner (needs OS Notification permission too). */
  desktop: boolean;
  /** Which sound plays on an alert. */
  sound: NotifSound;
  /** When to alert at all. */
  when: NotifWhen;
  /** Alert when a session needs input. */
  needsInput: boolean;
  /** Alert when a run completes. */
  done: boolean;
}

export const SOUND_OPTIONS: { value: NotifSound; label: string }[] = [
  { value: "chime", label: "Chime" },
  { value: "ping", label: "Ping" },
  { value: "bell", label: "Bell" },
  { value: "none", label: "None" },
];

export const WHEN_OPTIONS: { value: NotifWhen; label: string }[] = [
  { value: "always", label: "Always" },
  { value: "unfocused", label: "Only when unfocused" },
  { value: "off", label: "Off" },
];

const KEY = "opensession-notif-settings";
const CHANGE_EVENT = "opensession-notif-changed";
// Legacy single on/off flag (pre-Settings); migrated on first read.
const LEGACY_KEY = "opensession-input-alerts";

const DEFAULTS: NotifSettings = {
  desktop: true,
  sound: "chime",
  when: "unfocused",
  needsInput: true,
  done: false,
};

export function getNotifSettings(): NotifSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    // One-time migration: a user who had explicitly muted the old flag keeps
    // alerts off; otherwise fall through to defaults.
    if (localStorage.getItem(LEGACY_KEY) === "off") {
      return { ...DEFAULTS, when: "off" };
    }
  } catch {
    // Corrupt JSON — fall back to defaults.
  }
  return { ...DEFAULTS };
}

export function setNotifSettings(patch: Partial<NotifSettings>): NotifSettings {
  const next = { ...getNotifSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  // Any settings edit is a user gesture — a good moment to arm audio and ask for
  // notification permission if we'll want them.
  armAudio();
  if (next.desktop) requestPermission();
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
}

export function onNotifSettingsChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

let audioCtx: AudioContext | null = null;

// An AudioContext can't start without a user gesture, and asking for Notification
// permission is best done from one too. Arm both on the first pointer/key
// interaction, then detach. Idempotent — safe to call repeatedly.
export function initAlerts(): void {
  const arm = () => {
    armAudio();
    window.removeEventListener("pointerdown", arm);
    window.removeEventListener("keydown", arm);
  };
  window.addEventListener("pointerdown", arm);
  window.addEventListener("keydown", arm);
}

function armAudio(): void {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx?.state === "suspended") void audioCtx.resume();
  } catch {
    // AudioContext unavailable (old browser / blocked) — sound just no-ops.
  }
}

function requestPermission(): void {
  try {
    if ("Notification" in window && Notification.permission === "default")
      void Notification.requestPermission().catch(() => {});
  } catch {
    // Notification API unavailable — banner just no-ops.
  }
}

// Ask for OS notification permission from a user gesture (e.g. toggling the
// desktop-notifications switch on).
export function ensureNotificationPermission(): void {
  requestPermission();
}

// Short WebAudio tones — no asset to bundle. Each sound is a sequence of
// (frequency, startOffset) notes with a soft attack + exponential decay.
const SOUND_NOTES: Record<Exclude<NotifSound, "none">, [number, number][]> = {
  chime: [
    [660, 0],
    [880, 0.14],
  ],
  ping: [[880, 0]],
  bell: [
    [988, 0],
    [1319, 0.16],
    [988, 0.32],
  ],
};

// Play a sound unconditionally (used by the Settings "Test" button and by the
// alert path once it has decided to fire). Defaults to the configured sound.
export function playSound(kind: NotifSound = getNotifSettings().sound): void {
  if (kind === "none") return;
  armAudio();
  const ctx = audioCtx;
  if (!ctx || ctx.state !== "running") return;
  const now = ctx.currentTime;
  for (const [freq, offset] of SOUND_NOTES[kind]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = now + offset;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.14, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.24);
  }
}

function focused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

// The gate every alert passes through: is this event enabled, and does the
// when-rule allow it right now?
function shouldAlert(event: NotifEvent, s: NotifSettings): boolean {
  if (s.when === "off") return false;
  if (event === "needsInput" && !s.needsInput) return false;
  if (event === "done" && !s.done) return false;
  if (s.when === "unfocused" && focused()) return false;
  return true;
}

// Bring the app forward from a notification click. In the desktop shell the
// page's own window.focus() does not raise the window on macOS, so the shell's
// main process is asked to do it (os1-mac preload). Older shells do not expose
// that bridge, hence the feature check.
function focusApp(): void {
  try {
    const shell = os1Shell();
    if (shell?.focusWindow instanceof Function) shell.focusWindow();
  } catch {
    // The bridge is missing or threw. The plain focus below still runs.
  }
  try {
    window.focus();
  } catch {
    // Focus can be refused; the click still routes.
  }
}

// Fire an alert (sound + optional desktop banner) for a session event, subject to
// the user's notification settings.
export function notifyEvent(
  event: NotifEvent,
  title: string,
  body: string,
  onClick: () => void,
  // What this banner collapses onto. Alerts about the same session replace one
  // another; two sessions each keep their own banner, so a click still reaches
  // the session it names. Without it every "Needs input" shared one tag and
  // only the newest session was ever reachable.
  key?: string,
): void {
  const s = getNotifSettings();
  if (!shouldAlert(event, s)) return;
  playSound(s.sound);
  if (!s.desktop) return;
  try {
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;
    const n = new Notification(title, {
      body,
      tag: `opensession-${event}${key ? `-${key}` : ""}`,
    });
    n.onclick = () => {
      focusApp();
      onClick();
      n.close();
    };
  } catch {
    // Constructing a Notification can throw on some platforms — ignore.
  }
}
