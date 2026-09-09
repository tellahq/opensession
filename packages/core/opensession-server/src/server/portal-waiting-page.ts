/**
 * The page a person sees while a Portal is not ready.
 *
 * Caddy forward-authenticates every Portal request against
 * `/api/portal-auth/<port>` and copies a non-2xx answer straight back to the
 * browser. When that probe finds the route needs rebuilding (a gateway
 * restart, a Sandbox that went to sleep or that its provider restarted), the
 * rebuild can take a couple of minutes: waking the Sandbox, relaunching the
 * dev server, waiting for it to listen. Holding the navigation open for all
 * of that shows a blank tab that eventually times out on a phone. Instead
 * the probe answers a 503 with this small self-refreshing page, and the
 * browser comes back until the route is live.
 *
 * The page is self-contained on purpose: it is served from the Portal port,
 * which has none of the app's assets, and it must never leak anything about
 * the Sandbox beyond "not yet".
 */

export type PortalWaitingState = "waking" | "unavailable";

type PortalWaitingInput = {
  state: PortalWaitingState;
  /** Link back to the owning session, when it is known. */
  sessionUrl?: string;
  /** Seconds between refreshes while waking. */
  retrySeconds?: number;
};

const DEFAULT_RETRY_SECONDS = 3;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeSessionUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.href;
  } catch {
    return null;
  }
}

const STYLE = `
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center;
    background: #ffffff; color: #1a1a1a;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 26rem; padding: 2rem 1.5rem; text-align: center; }
  h1 { font-size: 1.125rem; font-weight: 600; margin: 1rem 0 0.375rem; letter-spacing: -0.01em; }
  p { margin: 0; color: #646464; text-wrap: pretty; }
  a { color: inherit; }
  .ring {
    width: 1.5rem; height: 1.5rem; margin: 0 auto; box-sizing: border-box;
    border: 2px solid #646464; border-right-color: transparent; border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  .dot {
    width: 0.625rem; height: 0.625rem; margin: 0.4375rem auto;
    border-radius: 50%; background: #949494;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .ring { animation-duration: 3s; }
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1c1c; color: #e9e9e9; }
    p, .ring { color: #a2a2a2; border-color: #a2a2a2; }
    .ring { border-right-color: transparent; }
    .dot { background: #767676; }
  }
`;

function page(input: {
  title: string;
  body: string;
  refreshSeconds?: number;
  sessionUrl: string | null;
  spinner: boolean;
}): string {
  const refresh = input.refreshSeconds
    ? `<meta http-equiv="refresh" content="${input.refreshSeconds}">`
    : "";
  const script = input.refreshSeconds
    ? `<script>setTimeout(function(){location.replace(location.href)},${input.refreshSeconds * 1000})</script>`
    : "";
  const link = input.sessionUrl
    ? `<p><a href="${escapeHtml(input.sessionUrl)}">Open the session</a></p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh}
<title>${escapeHtml(input.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="${input.spinner ? "ring" : "dot"}" aria-hidden="true"></div>
<h1>${escapeHtml(input.title)}</h1>
<p>${escapeHtml(input.body)}</p>
${link}
</main>
${script}
</body>
</html>
`;
}

/**
 * The HTML answer for a Portal that is not ready. `waking` is a 503 with a
 * Retry-After and a page that refreshes itself; `unavailable` is a 404 with a
 * way back to the session.
 */
export function portalWaitingResponse(input: PortalWaitingInput): Response {
  const sessionUrl = safeSessionUrl(input.sessionUrl);
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (input.state === "waking") {
    const retrySeconds = Math.max(
      1,
      Math.round(input.retrySeconds ?? DEFAULT_RETRY_SECONDS),
    );
    headers["Retry-After"] = String(retrySeconds);
    return new Response(
      page({
        title: "Starting the Portal",
        body: "The Sandbox is waking up and its service is starting. This page refreshes on its own.",
        refreshSeconds: retrySeconds,
        sessionUrl: null,
        spinner: true,
      }),
      { status: 503, headers },
    );
  }
  return new Response(
    page({
      title: "This Portal is not running",
      body: "Its Sandbox is gone or the service was stopped. Start it again from the session.",
      sessionUrl,
      spinner: false,
    }),
    { status: 404, headers },
  );
}
