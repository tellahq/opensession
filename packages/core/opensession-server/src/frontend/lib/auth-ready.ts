const FALLBACK_MS = 10_000;
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
  if (typeof localStorage === "undefined") return "Anonymous";
  return (
    localStorage.getItem(USER_KEY) ||
    localStorage.getItem(LEGACY_USER_KEY) ||
    "Anonymous"
  );
}

/**
 * Run startup hydration after the server has resolved this browser's identity.
 * A remembered user can start immediately. A fresh browser waits so it does
 * not load every per-user store once as Anonymous and again after sign-in.
 */
export function whenCurrentUserReady(run: (user: string) => void): () => void {
  if (
    typeof window === "undefined" ||
    typeof window.addEventListener !== "function"
  ) {
    run("Anonymous");
    return () => {};
  }
  const current = storedCurrentUser();
  if (current !== "Anonymous") {
    run(current);
    return () => {};
  }
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener(AUTH_STATUS_EVENT, finish);
    clearTimeout(timer);
    run(storedCurrentUser());
  };
  window.addEventListener(AUTH_STATUS_EVENT, finish);
  // Local instances predating the auth-status route still need to start.
  timer = setTimeout(finish, FALLBACK_MS);
  return () => {
    done = true;
    window.removeEventListener(AUTH_STATUS_EVENT, finish);
    clearTimeout(timer);
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
