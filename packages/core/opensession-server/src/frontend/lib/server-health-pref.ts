/** Per-device toggle for the sidebar's host metrics and FPS readout. Off by
 * default; while off the monitor is unmounted, so it neither polls the server
 * nor runs a frame loop. */
const KEY = "opensession-server-health-monitor";
const EVENT = "opensession-server-health-monitor-changed";

export function getServerHealthMonitorPref(): boolean {
  return localStorage.getItem(KEY) === "on";
}

export function setServerHealthMonitorPref(on: boolean) {
  if (on) localStorage.setItem(KEY, "on");
  else localStorage.removeItem(KEY);
  window.dispatchEvent(new Event(EVENT));
}

export function onServerHealthMonitorChanged(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
