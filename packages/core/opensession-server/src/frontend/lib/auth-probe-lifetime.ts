/** A logout intent fences every in-flight auth probe before its HTTP request.
 * It stays closed until navigation, even if logout is slow or fails. */
let logoutPending = false;
let epoch = 0;
export const LOGOUT_FAILED_EVENT = "opensession-logout-failed";
export const LOGOUT_STARTED_EVENT = "opensession-logout-started";
export function beginClientLogout(): void {
  logoutPending = true;
  epoch++;
}
export function captureAuthProbeEpoch(): number | null {
  return logoutPending ? null : epoch;
}
export function isCurrentAuthProbeEpoch(captured: number | null): boolean {
  return !logoutPending && captured !== null && captured === epoch;
}
