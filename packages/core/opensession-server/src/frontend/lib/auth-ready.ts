import { captureClientDataScope } from "./client-data-scope";
const USER_KEY = "opensession-user";
const LEGACY_USER_KEY = "backstage-user";
export const AUTH_STATUS_EVENT = "opensession-auth-status-changed";

/** True when the instance requires sign-in and this browser holds no accepted
 *  session — the state in which every authenticated route and the UI WebSocket
 *  upgrade 401, so the only correct UI is the sign-in card, never a reconnect
 *  overlay. Shared by UserGate (renders the card) and useWebSocket (stops
 *  presenting a refused upgrade as a transient disconnect) so the two never
 *  disagree about what a 401 means. */
export function authGatesOut(
  status: { required?: boolean; authenticated?: boolean } | null | undefined,
): boolean {
  return !!status?.required && !status.authenticated;
}

function storedCurrentUser(): string {
  if (!globalThis.localStorage) return "Anonymous";
  return (
    localStorage.getItem(USER_KEY) ||
    localStorage.getItem(LEGACY_USER_KEY) ||
    "Anonymous"
  );
}

/**
 * Run startup hydration after the server has resolved this browser's identity.
 * Stored display names and elapsed time are not proof of identity. Wait for
 * explicit auth readiness; local mode is available after required:false.
 */
export function whenCurrentUserReady(run: (user: string) => void): () => void {
  if (!(globalThis.window?.addEventListener instanceof Function)) {
    if (captureClientDataScope()) run("Anonymous");
    return () => {};
  }
  const current = storedCurrentUser();
  if (captureClientDataScope() && current !== "Anonymous") {
    run(current);
    return () => {};
  }
  let done = false;
  const finish = () => {
    if (done || !captureClientDataScope()) return;
    done = true;
    window.removeEventListener(AUTH_STATUS_EVENT, finish);
    run(storedCurrentUser());
  };
  window.addEventListener(AUTH_STATUS_EVENT, finish);
  return () => {
    done = true;
    window.removeEventListener(AUTH_STATUS_EVENT, finish);
  };
}

export function currentUserWhenReady(): Promise<string> {
  return new Promise((resolve) => whenCurrentUserReady(resolve));
}

/** Replace only an explicit startup placeholder, leaving unrelated paths and
 * local-mode Anonymous users unchanged. */
export async function resolveAnonymousUserPath(path: string): Promise<string> {
  if (!/[?&]user=Anonymous(?:&|$)/.test(path)) return path;
  const user = await currentUserWhenReady();
  if (user === "Anonymous") return path;
  const [pathname, query = ""] = path.split("?", 2);
  const params = new URLSearchParams(query);
  if (params.get("user") === "Anonymous") params.set("user", user);
  const suffix = params.toString();
  return suffix ? `${pathname}?${suffix}` : pathname;
}
