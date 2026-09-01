/**
 * The page a browser OAuth flow lands on when it comes back.
 *
 * This is the only hand-written HTML the app serves: the consent screen
 * redirects a NEW TAB to /api/connections/mcp-oauth/callback, so there is no
 * SPA around it and no stylesheet to inherit. It still has to look like Open
 * Session, so the tokens below are the ones from styles/base.css, picked by
 * `prefers-color-scheme` rather than the app's `data-theme` (the tab has no
 * app state to read a theme from).
 *
 * The mark is the service's real logo, the same BRANDS/BRAND_LOGOS data the
 * Connections tiles use, with a small status badge: the tab that opens is
 * visibly about the thing you just clicked Connect on. "You can close this
 * tab" was the whole page's call to action, so the useful next step is a
 * button now. It differs by outcome: closing the tab when the grant landed,
 * going back to the app when it did not.
 */

import {
  BRANDS,
  brandKey,
  brandLogo,
  displayName,
} from "../frontend/brand-logos";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const ALERT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6.5v7"/><path d="M12 17.5h.01"/></svg>';

/** The service's brand square, badged with the outcome. */
function mark(server: string | undefined, ok: boolean): string {
  const key = server?.toLowerCase() || "";
  const brand = BRANDS[brandKey(key)];
  const logo = brandLogo(key);
  // No server name at all (a redirect that lost its state): the badge has
  // nothing to sit on, so the alert becomes the mark.
  if (!server)
    return `<div class="mark"><span class="tile tile-alert">${ALERT}</span></div>`;
  const face = logo
    ? `<svg viewBox="${logo.viewBox}" fill="currentColor" aria-hidden="true">${logo.paths
        .map((d, index) => {
          const fill = logo.fills?.[index]
            ? ` fill="${logo.fills[index]}"`
            : "";
          const opacity =
            logo.opacities?.[index] != null
              ? ` opacity="${logo.opacities[index]}"`
              : "";
          const rule = logo.evenOdd ? ' fill-rule="evenodd"' : "";
          return `<path d="${d}"${fill}${opacity}${rule}/>`;
        })
        .join("")}</svg>`
    : esc(server.charAt(0).toUpperCase());
  const style = brand
    ? `background:${brand.bg};color:${brand.fg || "#fff"}`
    : "background:var(--wash);color:var(--dim)";
  return `<div class="mark"><span class="tile" style="${style}">${face}</span><span class="badge ${
    ok ? "ok" : "warn"
  }">${ok ? CHECK : ALERT}</span></div>`;
}

const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  color-scheme:dark light;
  --page:#1c1c1c;--surface:#262626;--border:#333333;--text:#e9e9e9;--dim:#a2a2a2;
	--ok:#3fb950;--bad:#f85149;--wash:rgba(255,255,255,.07);
  --shadow:0 1px 2px rgba(0,0,0,.4),0 20px 50px rgba(0,0,0,.36);
}
@media (prefers-color-scheme:light){
  :root{
    --page:#f6f6f6;--surface:#ffffff;--border:#e2e2e2;--text:#1a1a1a;--dim:#646464;
    --ok:#1a7f37;--bad:#cf222e;--wash:rgba(0,0,0,.05);
    --shadow:0 1px 2px rgba(0,0,0,.06),0 20px 50px rgba(0,0,0,.08);
  }
}
html,body{height:100%}
body{
  margin:0;display:grid;place-items:center;padding:24px;
  background:var(--page);color:var(--text);
  font:400 14px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;
}
.card{
  width:min(360px,100%);padding:32px 28px 24px;text-align:center;
  background:var(--surface);border:1px solid var(--border);border-radius:18px;
  box-shadow:var(--shadow);animation:rise .3s cubic-bezier(.2,.7,.3,1) both;
}
.mark{position:relative;display:inline-flex}
.tile{
  width:56px;height:56px;border-radius:16px;display:grid;place-items:center;
  font-size:24px;font-weight:600;
}
.tile svg{width:31px;height:31px}
/* Stands in for a brand tile when the redirect lost the server name, so it
   keeps the tile's shape rather than going round: under the squircle
   @supports below, a 50% radius renders as a rounded square anyway. */
.tile-alert{background:var(--wash);color:var(--bad)}
.tile-alert svg{width:26px;height:26px}
.badge{
  position:absolute;right:-4px;bottom:-4px;width:22px;height:22px;border-radius:50%;
  display:grid;place-items:center;color:#fff;box-shadow:0 0 0 3px var(--surface);
  animation:pop .28s cubic-bezier(.2,1.3,.4,1) .14s both;
}
.badge svg{width:12px;height:12px}
.badge.ok{background:var(--ok)}
.badge.warn{background:var(--bad)}
h1{margin:18px 0 0;font-size:17px;font-weight:600;letter-spacing:-.01em;text-wrap:balance}
.msg{margin:6px auto 0;max-width:32ch;color:var(--dim);overflow-wrap:anywhere;text-wrap:pretty}
.btn{
  display:inline-flex;align-items:center;justify-content:center;
  margin-top:22px;min-height:32px;padding:0 14px;border:0;border-radius:12px;
  background:var(--text);color:var(--page);text-decoration:none;
  font:600 13px/1 inherit;cursor:pointer;transition:opacity .12s ease,transform .12s ease;
}
.btn:hover{opacity:.86}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.45;cursor:default;transform:none}
.btn:focus-visible{outline:2px solid var(--text);outline-offset:2px}
/* The fallback line keeps its space from the start, so a browser that refuses
   window.close() reveals it without the card jumping. */
.foot{margin:12px 0 0;font-size:12px;color:var(--dim);visibility:hidden}
.foot[data-show],.foot.always{visibility:visible}
@supports (corner-shape:squircle){.card,.tile,.btn{corner-shape:squircle}}
@keyframes rise{from{opacity:0;transform:translateY(6px)}}
@keyframes pop{from{opacity:0;transform:scale(.5)}}
@media (prefers-reduced-motion:reduce){
  .card,.badge{animation:none}
  .btn{transition:none}
  .btn:active{transform:none}
}`;

// window.close() only works for a tab that was opened by script (Connections
// opens the consent with window.open), not for one a person navigated to by
// hand, so the fallback line covers the refusal rather than the button making
// a promise it cannot keep. focusVisible:false gives the keyboard its focus
// without painting a ring on a page nobody arrived at by tabbing.
const CLOSE_SCRIPT = `
const btn=document.getElementById('close'),foot=document.getElementById('foot');
btn.addEventListener('click',()=>{
  window.close();
  setTimeout(()=>{foot.dataset.show='1';btn.disabled=true},200);
});
btn.focus({preventScroll:true,focusVisible:false});`;

/**
 * The page itself. Exported for the other flow that lands a browser here: the
 * Linear agent's own OAuth callback (src/agents/linear/oauth.ts), which runs on
 * the webhook server and writes its own copy.
 */
export function connectResultPage(opts: {
  ok: boolean;
  /** Server/brand name for the mark. Omit when the redirect lost it. */
  server?: string;
  title: string;
  message: string;
  /** The useful next step: close this tab, or go somewhere. */
  action: { close: true } | { href: string; label: string };
  status?: number;
}): Response {
  const action = opts.action;
  const close = "close" in action;
  const button = close
    ? `<button class="btn" id="close" type="button">Close tab</button>
<p class="foot" id="foot">You can close this tab.</p>`
    : `<a class="btn" href="${esc(action.href)}">${esc(action.label)}</a>
<p class="foot always">Or close this tab.</p>`;
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · Open Session</title>
<style>${CSS}</style>
</head>
<body>
<main class="card">
${mark(opts.server, opts.ok)}
<h1>${esc(opts.title)}</h1>
<p class="msg">${esc(opts.message)}</p>
${button}
</main>
${close ? `<script>${CLOSE_SCRIPT}</script>` : ""}
</body>
</html>`,
    {
      status: opts.status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

/** The grant landed. `teamName` present = it is that teammate's own account. */
export function connectedPage(server: string, teamName?: string): Response {
  const name = displayName(server);
  return connectResultPage({
    ok: true,
    server,
    title: `${name} connected`,
    message: teamName
      ? `Sessions you run will use ${teamName}'s ${name} account.`
      : `Every session in this workspace can use this ${name} account.`,
    action: { close: true },
  });
}

/** The flow came back broken: a lost state, a refused consent, a token exchange that failed. */
export function connectFailedPage(
  server: string | undefined,
  error: string,
): Response {
  return connectResultPage({
    ok: false,
    server,
    title: server ? `${displayName(server)} not connected` : "Connect failed",
    message: error,
    action: { href: "/settings/connections", label: "Back to connections" },
  });
}
