import { useEffect, useRef, useState } from "react";
import { useAuthStatus, type AuthStatus } from "../components/UserPicker";
import { authGatesOut } from "../lib/auth-ready";
import { BASE_PATH } from "../lib/base";

export type OnboardingState = "loading" | "required" | "complete" | "failed";

export async function onboardingResponseCompleted(
  response: Response,
  missingIsComplete = false,
): Promise<boolean> {
  // During a source upgrade the frontend can hot-rebuild before the server is
  // restarted with this route. That server predates the first-run flag, so it
  // has the same semantics as a config with no flag: already onboarded.
  if (missingIsComplete && response.status === 404) return true;
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(body?.error || `Request failed (${response.status})`);
  return body?.completed === true;
}

/** Whether a sign-in state change should re-ask the server. A browser that
 *  remembers its name paints the app before the server checks its cookie, so
 *  the first request can 401 while the sign-in card is up. Signing in again
 *  may keep the same stored name and so never fire the user-changed event. */
export function shouldRecheckOnboarding(
  previous: AuthStatus | null,
  next: AuthStatus | null,
  state: OnboardingState,
): boolean {
  if (!next || authGatesOut(next)) return false;
  // A request sent while signed out may still be in flight; its 401 is stale.
  return state === "failed" || authGatesOut(previous);
}

async function request(init?: RequestInit): Promise<boolean> {
  const response = await fetch(`${BASE_PATH}/api/setup/onboarding`, init);
  const method = init?.method?.toUpperCase() ?? "GET";
  return onboardingResponseCompleted(response, method === "GET");
}

/** The instance-wide first-run gate. Unlike a UI preference, this follows the
 * server across browsers and users, and only the final onboarding action can
 * move it to complete. */
export function useOnboarding() {
  const [state, setRenderedState] = useState<OnboardingState>("loading");
  // The sign-in effect reads the latest state without re-running on it.
  const stateRef = useRef(state);
  const setState = (next: OnboardingState) => {
    stateRef.current = next;
    setRenderedState(next);
  };
  const latestRequest = useRef(0);

  async function refetch() {
    const id = ++latestRequest.current;
    setState("loading");
    let next: OnboardingState;
    try {
      next = (await request()) ? "complete" : "required";
    } catch {
      next = "failed";
    }
    // Only the newest check may settle the gate: an older one may have been
    // sent before sign-in finished.
    if (id === latestRequest.current) setState(next);
  }

  useEffect(() => {
    const reload = () => void refetch();
    reload();
    // The hook mounts outside UserGate. A signed-out first request may 401;
    // retry as soon as device-code sign-in establishes the current user.
    window.addEventListener("opensession-user-changed", reload);
    return () => window.removeEventListener("opensession-user-changed", reload);
  }, []);

  const auth = useAuthStatus();
  const previousAuth = useRef(auth);
  useEffect(() => {
    const previous = previousAuth.current;
    previousAuth.current = auth;
    if (shouldRecheckOnboarding(previous, auth, stateRef.current))
      void refetch();
  }, [auth]);

  async function complete() {
    await request({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    setState("complete");
  }

  return { state, refetch, complete };
}
