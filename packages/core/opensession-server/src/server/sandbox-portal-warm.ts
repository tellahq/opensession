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
 * the Sandbox requests the routes a few at a time, then every script and
 * stylesheet each page references. The Portal URL is not held back: a person who opens a
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
  /** Leave a Portal alone whose last warm-up finished after its app
   *  started (a relay rebuilt after a server restart). A dev server that
   *  restarted since, after a wake for instance, is warmed again. */
  skipIfWarm?: boolean;
  /** How long to wait for the app to listen before giving up. */
  waitSeconds?: number;
  /** Routes requested at once (default 3). */
  parallel?: number;
}): string {
  const base = `http://127.0.0.1:${input.port}`;
  const headers = `-H ${shellQuoteWord(`Host: ${input.host}`)} -H 'X-Forwarded-Proto: https'`;
  const routes = input.routes.map(shellQuoteWord).join(" ");
  const log = shellQuoteWord(input.logPath);
  const lock = shellQuoteWord(`${input.logPath}.lock`);
  return [
    // Nothing to warm until the app listens: a relay rebuilt during a
    // relaunch comes up first. Leave the log untouched meanwhile.
    `waited=0`,
    `until (exec 3<>/dev/tcp/127.0.0.1/${input.port}) 2>/dev/null; do`,
    `  [ "$waited" -ge ${Math.max(0, Math.floor(input.waitSeconds ?? 600))} ] && exit 0`,
    `  sleep 2; waited=$((waited + 2))`,
    `done`,
    ...(input.skipIfWarm
      ? [
          // Finished, and by the app listening now: its process has run
          // longer than the log has existed unchanged. Without ss or ps
          // (macOS) the Portal is warmed again, which is only slower.
          `if [ "$(tail -n 1 ${log} 2>/dev/null)" = done ]; then`,
          `  pid=$(ss -Hltnp "sport = :${input.port}" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2)`,
          `  if [ -n "$pid" ]; then`,
          `    age=$(( $(date +%s) - $(stat -c %Y ${log} 2>/dev/null || echo 0) ))`,
          `    ran=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')`,
          `    [ -n "$ran" ] && [ "$ran" -ge "$age" ] && exit 0`,
          `  fi`,
          `fi`,
        ]
      : []),
    // One warm-up at a time; a lock older than 15 minutes is a dead run's.
    `find ${lock} -maxdepth 0 -mmin +15 -exec rmdir {} \\; 2>/dev/null`,
    `mkdir ${lock} 2>/dev/null || exit 0`,
    `trap 'rmdir ${lock} 2>/dev/null' EXIT`,
    `exec >${log} 2>&1`,
    // A few routes at a time: a dev server compiles independent routes in
    // parallel, so the editor no longer queues behind the slowest page.
    // Lines are logged as routes finish, not in declaration order.
    `for route in ${routes}; do`,
    `  while [ "$(jobs -rp | wc -l)" -ge ${Math.max(1, Math.floor(input.parallel ?? 3))} ]; do sleep 0.2; done`,
    `  (`,
    `    page=$(mktemp)`,
    `    result=$(curl -s -o "$page" -m 300 ${headers} -w '%{http_code} %{time_total}s' ${shellQuoteWord(base)}"$route")`,
    `    echo "$route $result"`,
    `    grep -oE '/_next/static/[^"'"'"' <>]+\\.(js|css)' "$page" 2>/dev/null | sort -u | ` +
      `xargs -P 6 -I{} curl -s -o /dev/null -m 120 ${headers} ${shellQuoteWord(base)}{}`,
    `    rm -f "$page"`,
    `  ) &`,
    `done`,
    `wait`,
    `echo done`,
  ].join("\n");
}

/** Start warming a Sandbox Portal in the background. Never throws. */
export async function warmSandboxPortal(input: {
  sandbox: Sandbox;
  port: number;
  logPath: string;
  defaultPath?: string;
  skipIfWarm?: boolean;
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
      skipIfWarm: input.skipIfWarm,
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
