/** Shared Caddy reverse-proxy settings for generated configuration. */

/**
 * How long Caddy keeps a proxied WebSocket open after a config reload
 * retires the handler that carried it.
 *
 * Every Portal route change reloads Caddy's whole config. With the default
 * (0) the reload itself writes a close frame to every proxied WebSocket,
 * with no deadline, while holding Caddy's config lock. One peer that has
 * stopped reading (a sleeping laptop's tab, a stalled relay) then blocks
 * that write, the reload never finishes, and every later admin call hangs,
 * so no Portal route anywhere can change until Caddy is restarted. It also
 * dropped every live HMR connection on each Portal start. With a delay the
 * reload only arms a timer, and old connections end on their own or later.
 * Used by the Portal routes (preview.ts) and the Caddyfile generators
 * (private-app-domain.ts, sandbox/caddy-ingress.ts).
 */
export const CADDY_STREAM_CLOSE_DELAY = "1h";
