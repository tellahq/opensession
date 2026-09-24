/**
 * Warm a Sandbox Portal's first pages once it listens.
 *
 * A dev server such as Next with Turbopack compiles each route on its first
 * request. On a freshly adopted Sandbox that first compile reads a lazily
 * restored disk and can take minutes (measured on tella-fusion: 69 s for
 * /videos, 34 s for the editor, plus a few seconds per API route it calls).
 * Whoever opens the Portal first used to pay that.
 *
 * The repository names the routes worth warming in `.agents/preview.json`
 * (`warmRoutes`, the same list its prepared image uses). A route with a
 * dynamic segment can name any value there: the compile is per route, not
 * per record. After the Portal's relay connects, a detached script inside
 * the Sandbox requests each route in order, then every script and stylesheet
 * a page references. The Portal URL is not held back: a person who opens a
 * page meanwhile shares the compile already in progress.
 */
import { configuredServer } from "./config";
import {
  remoteLayoutForProvider,
  shellQuoteWord,
} from "./sandbox/adapters/bootstrap";
import { sandboxHttpsPortFor } from "./sandbox/preview-ports";
import type { Sandbox } from "./sandbox/provider";

const MAX_ROUTES = 20;
const ROUTE_PATTERN = /^\/[A-Za-z0-9._~%/?=&:@+,-]*$/;

/** The routes to warm from a `.agents/preview.json` body; `fallback` (the
 *  Portal's default path, else "/") when it declares none. */
export function portalWarmRoutes(
  previewJson: string | null,
  fallback?: string,
): string[] {
  let declared: unknown;
  try {
    declared = previewJson ? JSON.parse(previewJson)?.warmRoutes : undefined;
  } catch {
    declared = undefined;
  }
  const routes = (Array.isArray(declared) ? declared : [fallback || "/"])
    .filter(
      (route): route is string =>
        typeof route === "string" &&
        route.length <= 512 &&
        ROUTE_PATTERN.test(route),
    )
    .slice(0, MAX_ROUTES);
  return [...new Set(routes)];
}

/** The detached script: each route in order against the Portal's loopback
 *  port with the Host the app sees through the Portal, then the page's
 *  referenced assets a few at a time. One line per route in `logPath`. */
export function portalWarmScript(input: {
  port: number;
  host: string;
  routes: string[];
  logPath: string;
}): string {
  const base = `http://127.0.0.1:${input.port}`;
  const headers = `-H ${shellQuoteWord(`Host: ${input.host}`)} -H 'X-Forwarded-Proto: https'`;
  const routes = input.routes.map(shellQuoteWord).join(" ");
  return [
    `exec >${shellQuoteWord(input.logPath)} 2>&1`,
    `page=$(mktemp)`,
    `for route in ${routes}; do`,
    `  result=$(curl -s -o "$page" -m 300 ${headers} -w '%{http_code} %{time_total}s' ${shellQuoteWord(base)}"$route")`,
    `  echo "$route $result"`,
    `  grep -oE '/_next/static/[^"'"'"' <>]+\\.(js|css)' "$page" 2>/dev/null | sort -u | ` +
      `xargs -P 6 -I{} curl -s -o /dev/null -m 120 ${headers} ${shellQuoteWord(base)}{}`,
    `done`,
    `rm -f "$page"`,
    `echo done`,
  ].join("\n");
}

/** Start warming a Sandbox Portal in the background. Never throws. */
export async function warmSandboxPortal(input: {
  sandbox: Sandbox;
  port: number;
  logPath: string;
  defaultPath?: string;
}): Promise<void> {
  try {
    const preview = await input.sandbox.exec([
      "bash",
      "-c",
      "cat .agents/preview.json 2>/dev/null || true",
    ]);
    const routes = portalWarmRoutes(
      preview.stdout.trim() || null,
      input.defaultPath,
    );
    if (!routes.length) return;
    const host = `${configuredServer().previewHost}:${sandboxHttpsPortFor(input.sandbox.id, input.port)}`;
    const script = portalWarmScript({
      port: input.port,
      host,
      routes,
      logPath: input.logPath,
    });
    // Detached like the Portal process itself: macOS has no setsid, and the
    // provider's background lane already detaches there.
    const detach =
      remoteLayoutForProvider(input.sandbox.provider).os === "darwin"
        ? ""
        : "setsid ";
    const launch = `${detach}bash -c ${shellQuoteWord(script)} </dev/null >/dev/null 2>&1 &`;
    await input.sandbox.exec(["bash", "-c", launch], {
      background: true,
      timeoutMs: 15_000,
    });
  } catch (error) {
    console.warn(
      `[sandbox] ${input.sandbox.id}: could not warm Portal on ${input.port}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}
