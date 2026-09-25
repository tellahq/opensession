/**
 * Compile a repository's Portal once while its Sandbox image is built.
 *
 * A dev server with an on-disk compile cache (Next with Turbopack) compiles
 * each page once per cache. Without one in the image, every new session's
 * first Portal start compiled the whole app from nothing: about two minutes
 * for tella-fusion. Here the image build starts the repository's first
 * Portal recipe on the port a session's first Portal gets, requests the
 * repository's `warmRoutes` (the same warm-up a Portal runs on start), and
 * stops it again, so the cache is sealed into the image.
 *
 * The cache can hold values from the app's environment, secrets included
 * (Turbopack stores what it inlines). So this is an operator opt-in per repo,
 * `perRepo[repo].prebuildPortal` in the Sandbox config, never something a
 * repository turns on for itself, and only for Boat, which runs interactive
 * sessions alone (box.ts refuses automations).
 *
 * The dev server runs with a Portal's workload identity and its own
 * temporary directory, which is removed afterwards along with Open Session's
 * port file, and tracked files it rewrote are restored so the image still
 * seals clean. Any failure leaves the image without a cache, never broken.
 */
import { configuredServer } from "../config";
import { portalWarmRoutes, portalWarmScript } from "../sandbox-portal-warm";
import { createWorkloadIdentityEnv } from "../workload-identity";
import {
  remoteWarmWorkspaceDir,
  shellQuoteWord,
  type RemoteDriver,
  type RemoteLayout,
} from "./adapters/bootstrap";

/** The port a session's first Sandbox Portal is given (portal-supervisor.ts's
 *  allocateSandboxPort). Apps that compile PORT in need the same one. */
export const PREBUILD_PORTAL_PORT = 4_000;
const READY_SECONDS = 600;
const RUN_TIMEOUT_MS = 20 * 60_000;

export function portalPrebuildScript(input: {
  dir: string;
  layout: Pick<RemoteLayout, "home" | "path" | "lifecycleDir">;
  name: string;
  command: string;
  port: number;
  host: string;
  routes: string[];
  env: Record<string, string>;
}): string {
  const log = `${input.layout.lifecycleDir}/portal-prebuild.log`;
  const warmLog = `${input.layout.lifecycleDir}/portal-prebuild-warm.log`;
  const envArgs = Object.entries(input.env)
    .map(([key, value]) => `${key}=${shellQuoteWord(value)}`)
    .join(" ");
  const warm = portalWarmScript({
    port: input.port,
    host: input.host,
    routes: input.routes,
    logPath: warmLog,
    waitSeconds: READY_SECONDS,
  });
  return [
    `mkdir -p ${shellQuoteWord(input.layout.lifecycleDir)}`,
    `cd ${shellQuoteWord(input.dir)} || exit 1`,
    `rm -f ${shellQuoteWord(warmLog)}`,
    `tmp=$(mktemp -d)`,
    `env HOME=${input.layout.home} PATH=${shellQuoteWord(input.layout.path)} TMPDIR="$tmp" ` +
      `PORT=${input.port} PORTAL_URL=${shellQuoteWord(`https://${input.host}`)} ` +
      `OPENSESSION_PORTAL=${shellQuoteWord(input.name)} ${envArgs} ` +
      `setsid bash -c ${shellQuoteWord(`exec ${input.command}`)} </dev/null >${shellQuoteWord(log)} 2>&1 &`,
    `pid=$!`,
    `bash -c ${shellQuoteWord(warm)}`,
    `result=$(tail -n 1 ${shellQuoteWord(warmLog)} 2>/dev/null)`,
    // The whole process group: the app, its watchers, the identity refresher.
    `kill -s TERM -- -"$pid" 2>/dev/null`,
    `for i in $(seq 1 30); do kill -s 0 -- -"$pid" 2>/dev/null || break; sleep 1; done`,
    `kill -s KILL -- -"$pid" 2>/dev/null`,
    `rm -rf "$tmp" .ports.conf .ports`,
    `find . -maxdepth 5 -path '*/.next/dev/lock' -not -path '*/node_modules/*' -delete 2>/dev/null`,
    `dirty=$(git status --porcelain --untracked-files=no)`,
    `if [ -n "$dirty" ]; then echo "restored: $dirty" | head -5; git checkout -q -- .; fi`,
    `cat ${shellQuoteWord(warmLog)} 2>/dev/null`,
    `[ "$result" = done ]`,
  ].join("\n");
}

/** Returns whether the pages compiled. Never throws. */
export async function prebuildPortalCache(
  driver: RemoteDriver,
  layout: RemoteLayout,
  repo: { id: string },
  identity: { sandboxId: string; provider: string },
  label: string,
): Promise<boolean> {
  const log = (message: string) =>
    console.log(`[sandbox:${label}] Portal prebuild: ${message}`);
  try {
    const dir = remoteWarmWorkspaceDir(repo.id, layout);
    const read = async (path: string) => {
      const result = await driver.exec(`cat ${shellQuoteWord(path)}`, {
        cwd: dir,
      });
      return result.exitCode === 0 ? result.stdout : null;
    };
    const { parsePreviewPortalRecipes, recipeCommand } =
      await import("../preview");
    const recipe = parsePreviewPortalRecipes(
      await read(".agents/portals.json"),
    ).find((candidate) => candidate.command);
    const routes = portalWarmRoutes(await read(".agents/preview.json"));
    if (!recipe || !routes.length) {
      log("skipped (no Portal recipe or warm routes)");
      return false;
    }
    const started = Date.now();
    const result = await driver.exec(
      portalPrebuildScript({
        dir,
        layout,
        name: recipe.id,
        command: recipeCommand(recipe),
        port: PREBUILD_PORTAL_PORT,
        host: configuredServer().previewHost,
        routes,
        env: createWorkloadIdentityEnv({
          ...identity,
          repoId: repo.id,
          lifecycle: "preview",
          trustProfile: "interactive",
        }),
      }),
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    const seconds = Math.round((Date.now() - started) / 1000);
    const detail = result.stdout.trim().split("\n").slice(-12).join("; ");
    if (result.exitCode !== 0) {
      log(`did not finish in ${seconds}s (image ships without it): ${detail}`);
      return false;
    }
    log(`compiled in ${seconds}s: ${detail}`);
    return true;
  } catch (error) {
    log(
      `failed (image ships without it): ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
