import React, { useState, useEffect } from "react";
import { BrandMark } from "./BrandMark";
import { UserAvatar } from "./UserAvatar";
import { IconArrowUpRight } from "./icons";
import { BASE_PATH } from "../lib/base";
import { PRODUCT_NAME } from "../lib/brand";
import { ensurePeople, getPeople, usePeople } from "../lib/people";
import { effectiveTheme, onThemeChanged } from "../lib/theme";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { DeviceCode } from "../ui/device-code";
import { InlineAlert } from "../ui/state";
import { PulseDot } from "../ui/status";
import { AUTH_STATUS_EVENT, authGatesOut } from "../lib/auth-ready";
import { errorMessage } from "../lib/error-message";
import { returnToPortalAfterSignIn } from "../lib/portal-return";

/**
 * Mutable compatibility view for older consumers. `usePeople()` owns the
 * roster and updates this array in place after GET /api/people resolves.
 */
export const TEAM: string[] = [];
// Rename shim: read the new key first, fall back to the legacy one (existing
// browsers + tooling that presets it stay signed in); writes go to the new key.
const KEY = "opensession-user";
const LEGACY_KEY = "backstage-user";
const CHANGE_EVENT = "opensession-user-changed";

function setStoredUser(val: string) {
  const changed = getCurrentUser() !== val;
  localStorage.setItem(KEY, val);
  // Auth verification commonly confirms the identity already restored from
  // localStorage. Do not make every per-user store hydrate again in that case.
  if (changed) window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function getCurrentUser(): string {
  return (
    localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY) || "Anonymous"
  );
}

/** Switch the current user (used by the account menu's switcher). */
export function setCurrentUser(name: string) {
  setStoredUser(name);
}

/** Reactive current user — updates when the picker (or another tab) changes it. */
export function useCurrentUser(): string {
  const [user, setUser] = useState(() =>
    typeof localStorage === "undefined" ? "" : getCurrentUser(),
  );

  useEffect(() => {
    const handler = () => setUser(getCurrentUser());
    // Server-rendered component tests start without localStorage. Hydrate the
    // real browser identity as soon as the hook reaches the client.
    handler();
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  return user;
}

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  admin?: boolean;
  /** The server's own name, answered pre-auth so the sign-in card can say
   *  whose server this is (every other source sits behind the gate). */
  organizationName?: string;
  /** The organization's configured icon, revisioned; null when the server
   *  still wears the bundled app mark. The image itself is served pre-auth
   *  as a static asset — only the URL needs this response to travel. */
  organizationIconUrl?: string | null;
  /** Signed out because GitHub permanently rejected this person's grant, not
   *  because they never signed in: `login` is still theirs, and the way back
   *  in is the same authorize. */
  reconnectRequired?: boolean;
  login?: string;
  name?: string;
}

// Shared auth state: UserGate fetches /api/auth/status once on load; other
// components (Settings' account footer) read it reactively from here
// instead of re-fetching.
let authStatusCache: AuthStatus | null = null;

function setAuthStatusCache(status: AuthStatus) {
  authStatusCache = status;
  window.dispatchEvent(new Event(AUTH_STATUS_EVENT));
}

/** Publish an auth status discovered outside UserGate — the WebSocket layer
 *  learns the gate turned on (or that a fresh load landed on a gated instance)
 *  from a refused upgrade, and drives UserGate to the sign-in card through
 *  this, without a reload that would loop on the card's own refused socket. */
export function publishAuthStatus(status: AuthStatus): void {
  setAuthStatusCache(status);
}

/** Reactive sign-in state; null until /api/auth/status answers (or when the
 *  server predates it). `required && authenticated` ⇒ GitHub-verified user. */
export function useAuthStatus(): AuthStatus | null {
  const [status, setStatus] = useState(authStatusCache);
  useEffect(() => {
    const handler = () => setStatus(authStatusCache);
    window.addEventListener(AUTH_STATUS_EVENT, handler);
    return () => window.removeEventListener(AUTH_STATUS_EVENT, handler);
  }, []);
  return status;
}

/** Sign out of the GitHub web session and return to the sign-in screen. */
export async function signOut(): Promise<void> {
  await (async () => {
    await fetch(`${BASE_PATH}/api/auth/logout`, { method: "POST" });
  })().catch(async () => {});
  window.location.reload();
}

/**
 * The fixed light/dark artwork shared with marketing and onboarding. It is
 * vendored beside the app so the sign-in gate never depends on a public CDN.
 */
function AuthBackdrop() {
  const [theme, setTheme] = useState(effectiveTheme);
  useEffect(() => onThemeChanged(() => setTheme(effectiveTheme())), []);
  const name = theme === "dark" ? "onboarding-bg-dark" : "onboarding-bg";
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 select-none bg-surface bg-cover bg-center"
      style={{ backgroundImage: `url(${BASE_PATH}/${name}.webp)` }}
    />
  );
}

/**
 * The shell every pre-app screen shares: sign-in, the local name picker, the
 * expired-session notice, the retry after a failed status check. They were
 * four hand-built boxes with their own paddings and inline styles, which is
 * why the first thing a new teammate saw looked like a different product from
 * the one behind it.
 *
 * One card, one corner, one width. Its `rounded-3xl` shape is a small step
 * softer than the standard container, and its shared popup glass lets the new
 * artwork read through without competing with the content. The popup token
 * becomes opaque when blur is unavailable or reduced transparency is enabled.
 *
 * Its edge still changes with the theme through `--auth-card-edge` (base.css):
 * light gets a restrained cast, while dark gets the hairline that holds the
 * translucent shape without muddying the backdrop.
 *
 * Every screen opens on the organization's own mark when one is configured,
 * else the product icon — the same one the loading splash shows (index.html),
 * so the app you are signing in to is what you land on. GitHub is the method,
 * and it is named on the button.
 */
function AuthCard({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    // Before sign-in there is no sidebar or header, so the desktop shell has
    // none of the rows it normally makes draggable. The backdrop is the handle
    // here; the card opts back out so its controls stay clickable. The durable
    // shell capability keeps this working if WCO geometry disappears.
    <div className="relative flex h-screen items-center justify-center overflow-hidden p-6 [html.wco_&]:[-webkit-app-region:drag] [html.wco_&]:[app-region:drag] [html.desktop-shell_&]:[-webkit-app-region:drag] [html.desktop-shell_&]:[app-region:drag]">
      <AuthBackdrop />
      <div className="relative w-[400px] max-w-full rounded-3xl bg-popup-glass p-8 text-center shadow-(--auth-card-edge) [backdrop-filter:var(--popup-blur)] phone:p-6 [html.wco_&]:[-webkit-app-region:no-drag] [html.wco_&]:[app-region:no-drag] [html.desktop-shell_&]:[-webkit-app-region:no-drag] [html.desktop-shell_&]:[app-region:no-drag]">
        <AuthMark />
        {/* Medium, not semibold: at 19px on the card's own paper the heavier
				    step read as a slab rather than a heading. */}
        <h1 className="m-0 text-section-title font-title text-fg">{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** The card's mark: the organization's configured icon when one exists (its
 *  URL arrives pre-auth on /api/auth/status), else the bundled app mark. A
 *  configured icon that fails to load falls back rather than leaving a hole. */
function AuthMark() {
  const fallback = `${BASE_PATH}/mac-app-icon.png?v=7`;
  const configured = useAuthStatus()?.organizationIconUrl || null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const custom = configured !== null && configured !== failedSrc;
  const src = custom ? configured : fallback;
  return (
    <img
      src={src}
      alt=""
      width={56}
      height={56}
      // The bundled mark is drawn to the tile's edge; an uploaded org icon is
      // a full-bleed square (Settings → General crops it to one), so it rounds
      // like it does in the OrganizationSwitcher.
      className={cn(
        "mx-auto mb-5 block size-14",
        custom ? "rounded-control object-cover" : "",
      )}
      onError={() => {
        if (custom) setFailedSrc(src);
      }}
    />
  );
}

/** The sentence under an AuthCard's title. */
function AuthCopy({ children }: { children: React.ReactNode }) {
  return (
    // `last:mb-0` for the cards whose sentence IS the card (the expired
    // notice): the margin is air before whatever follows, and with nothing
    // following it just lands the card off-centre.
    <p className="mx-auto mt-2 mb-6 max-w-[32ch] text-supporting leading-normal text-dim last:mb-0">
      {children}
    </p>
  );
}

/**
 * Identity gate. Default: the historical localStorage name picker. When
 * GitHub web sign-in is active on the server (config
 * integrations.github.userPrAuth), the picker is replaced by a real GitHub
 * sign-in (device flow → HttpOnly cookie) — the server then ignores
 * client-claimed names, so the localStorage value is display-only and is
 * synced to the verified identity here.
 */
export function UserGate({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser();
  const roster = usePeople();
  TEAM.splice(0, TEAM.length, ...roster.map(({ name }) => name));
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const loadAuth = () => {
    setAuthFailed(false);
    fetch(`${BASE_PATH}/api/auth/status`)
      .then((r) => {
        if (!r.ok) throw new Error(`Authentication status failed: ${r.status}`);
        return r.json();
      })
      .then(async (body: AuthStatus | null) => {
        if (!body) throw new Error("Authentication status was empty");
        if (body.required && body.authenticated && body.name) {
          const user = body.name.split(" ")[0];
          setStoredUser(user);
          // Already signed in here: a Portal that redirected this browser
          // over only needed the cookie this origin holds.
          if (returnToPortalAfterSignIn()) return;
        } else if (!body.required && getCurrentUser() === "Anonymous") {
          // A fresh local instance has nobody to choose between. Wait for the
          // roster so a configured team still gets its picker, then enter an
          // empty or single-person instance directly into first-mile setup.
          await ensurePeople();
          const people = getPeople();
          if (people.length <= 1)
            setStoredUser(people[0]?.name ?? "Local User");
        }
        setAuth(body);
        // Publish readiness after localStorage carries the verified or local
        // name so deferred per-user stores hydrate the right account.
        setAuthStatusCache(body);
      })
      .catch(() => setAuthFailed(true));
  };

  useEffect(() => {
    loadAuth();
  }, []);

  // A refused WebSocket upgrade can reveal the gate is up before this
  // component's own status resolves (the optimistic paint below) or after it
  // resolved to no-gate (the gate was enabled under an open tab). Honor that
  // signal so the sign-in card, not a "reconnecting" overlay, stands in for a
  // browser the server will no longer accept.
  const liveAuth = useAuthStatus();
  const signedIn = (status: AuthStatus) => {
    if (returnToPortalAfterSignIn()) return;
    setAuth(status);
    setAuthStatusCache(status);
  };
  if (authGatesOut(liveAuth) && !(auth?.required && auth.authenticated)) {
    return (
      <GithubSignIn
        reconnect={liveAuth!.reconnectRequired === true}
        login={liveAuth!.login}
        onSignedIn={signedIn}
      />
    );
  }

  // Returning visitors already have a local identity. Let the app paint while
  // the server verifies its HttpOnly session, as it did before this check grew
  // a blocking loading screen. The server still enforces auth on every route.
  if (!auth && !authFailed && user !== "Anonymous") return <>{children}</>;

  if (!auth) {
    if (authFailed) {
      return (
        <AuthCard title="Couldn't check sign-in">
          <AuthCopy>
            The server didn't answer. It may still be starting up.
          </AuthCopy>
          <Button
            variant="primary"
            size="lg"
            className="min-h-10 w-full"
            onClick={loadAuth}
          >
            Try again
          </Button>
        </AuthCard>
      );
    }
    // The static launch splash stays visible while this returns nothing. Only
    // mount the sign-in scene once the server says it is actually needed.
    return null;
  }

  // GitHub sign-in is configured: it is the only way in, and the name picker
  // below is unreachable. The two are alternatives, never steps of one flow
  // (web-auth.ts: "Off (default): the UI keeps today's localStorage name
  // picker"), so nobody signing in with GitHub is ever asked to pick a name.
  if (auth?.required) {
    if (auth.authenticated) return <>{children}</>;
    return (
      <GithubSignIn
        reconnect={auth.reconnectRequired === true}
        login={auth.login}
        onSignedIn={signedIn}
      />
    );
  }

  if (user !== "Anonymous") return <>{children}</>;

  // No sign-in configured with more than one rostered person. Fresh and
  // single-person instances are assigned above and skip this choice entirely.
  return (
    <AuthCard title="Who are you?">
      <AuthCopy>
        Sign-in isn't set up here, so your name is only a label on your
        sessions.
      </AuthCopy>
      <div
        className={cn(
          "grid gap-2",
          // One tile has no column to pair with: a half-width button floating
          // in a card reads as a layout that lost its other half.
          roster.length > 1 ? "grid-cols-2 phone:grid-cols-1" : "grid-cols-1",
        )}
      >
        {(roster.length ? roster.map(({ name }) => name) : ["Local User"]).map(
          (name) => (
            <button
              key={name}
              // The raised-control optics of Button's `default` variant, at
              // tile proportions: a hairline is allowed here because the tile
              // is a control, not a card (see src/frontend/AGENTS.md).
              className="flex flex-col items-center gap-2 rounded-lg border border-line bg-button px-3 py-4 text-item-title font-medium text-fg smooth-shadow-xs transition-[border-color,scale] hover:border-line-strong active:scale-[0.98] focus-ring"
              onClick={() => setStoredUser(name)}
            >
              <UserAvatar name={name} size={36} />
              {roster.length ? name : "Continue locally"}
            </button>
          ),
        )}
      </div>
    </AuthCard>
  );
}

/**
 * Sign in with GitHub's device flow: the code is entered on github.com in
 * whatever browser the person already trusts, and this screen waits.
 *
 * It is the only flow, deliberately. An authorization-code redirect has to
 * come back to the exact origin it left, and on the iOS PWA it returns into
 * Safari instead of the installed app, stranding the person one tab away from
 * the thing they were signing in to. Entering a code is one step longer and
 * lands everywhere.
 */
function GithubSignIn({
  reconnect = false,
  login,
  onSignedIn,
}: {
  /** The grant behind an existing session died; this is the same screen and
   *  the same flow, saying which of the two happened. */
  reconnect?: boolean;
  login?: string;
  onSignedIn: (status: AuthStatus) => void;
}) {
  const [flow, setFlow] = useState<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    interval: number;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverName = useAuthStatus()?.organizationName || PRODUCT_NAME;

  // Poll GitHub (via the server) until the device code is authorized.
  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let intervalMs = Math.max(flow.interval, 5) * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await (async () => {
        const res = await fetch(`${BASE_PATH}/api/auth/device/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode: flow.deviceCode }),
        });
        const body = await res.json();
        if (cancelled) return;
        if (body.status === "ok") {
          if (body.name) setStoredUser(body.name.split(" ")[0]);
          onSignedIn({
            required: true,
            authenticated: true,
            admin: body.admin,
            login: body.login,
            name: body.name,
          });
          return;
        }
        if (body.status === "slow_down")
          intervalMs = Math.max(body.interval, 5) * 1000;
        if (body.status === "error" || body.error) {
          setError(body.error || "Sign-in failed");
          setFlow(null);
          return;
        }
      })().catch(async () => {});
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, onSignedIn]);

  async function start() {
    setError(null);
    setStarting(true);
    await (async () => {
      const res = await fetch(`${BASE_PATH}/api/auth/device`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
      setFlow(body);
    })().catch(async (error) => {
      setError(errorMessage(error, "Failed to start sign-in"));
    });
    setStarting(false);
  }

  return (
    <AuthCard
      title={
        flow
          ? "Enter this code"
          : reconnect
            ? "Reconnect GitHub"
            : `Sign in to ${serverName}`
      }
    >
      {!flow ? (
        <>
          <AuthCopy>
            {reconnect ? (
              <>
                GitHub's authorization
                {login ? <> for @{login}</> : null} expired. Sign in again to
                continue.
              </>
            ) : (
              "Open Session is your team’s control room for coding agents. Sign in with GitHub so pull requests from your sessions are authored by you."
            )}
          </AuthCopy>
          <Button
            variant="primary"
            size="lg"
            className="min-h-10 w-full"
            icon={<BrandMark name="github" size={20} />}
            disabled={starting}
            onClick={() => void start()}
          >
            {starting
              ? "Starting…"
              : reconnect
                ? "Reconnect with GitHub"
                : "Continue with GitHub"}
          </Button>
        </>
      ) : (
        <div className="flex flex-col items-center">
          <AuthCopy>
            GitHub will ask for it at{" "}
            <span className="font-medium text-fg">
              {flow.verificationUri.replace(/^https:\/\//, "")}
            </span>
            .
          </AuthCopy>
          {/* The code is what this screen is for, so it gets a clear display
              step and a translucent paper block rather than the shared input chrome. */}
          <DeviceCode
            code={flow.userCode}
            className="border-0 bg-surface/85 px-4 py-2.5 font-sans text-page-title [box-shadow:none]! hover:bg-surface/85"
          />
          <a
            href={flow.verificationUri}
            target="_blank"
            rel="noreferrer"
            className="mt-5 w-full"
          >
            <Button
              variant="primary"
              size="lg"
              className="min-h-10 w-full"
              icon={<IconArrowUpRight size={20} />}
            >
              Open GitHub
            </Button>
          </a>
          <span className="mt-3.5 flex items-center gap-2 text-label text-dim">
            <PulseDot size={7} />
            Waiting for GitHub…
          </span>
        </div>
      )}
      {error && (
        <InlineAlert variant="error" className="mt-5 text-left">
          {error}
        </InlineAlert>
      )}
    </AuthCard>
  );
}
