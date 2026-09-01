/**
 * One-command Open Session desktop development:
 *   1. serve this worktree's frontend against the production API
 *   2. wait until that proxy is accepting requests
 *   3. launch the vendored Electron shell against it
 *
 * Ctrl+C (or either child exiting) shuts down both processes.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAC_APP_ROOT = join(ROOT, "packages", "clients", "mac");
// electron-builder names the bundle and its executable after productName, so
// read that rather than repeating a label here: it is the app's visible name,
// and it moves.
const MAC_APP_LABEL = JSON.parse(
  readFileSync(join(MAC_APP_ROOT, "package.json"), "utf8"),
).productName as string;
const MAC_APP_EXECUTABLE = join(
  MAC_APP_ROOT,
  `dist/mac-arm64/${MAC_APP_LABEL}.app/Contents/MacOS/${MAC_APP_LABEL}`,
);
const PORT = Number(process.env.PORT || 3851);
const APP_URL = `http://127.0.0.1:${PORT}`;
const children: Bun.Subprocess[] = [];
let interrupted = false;

function spawn(command: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(child);
  return child;
}

function stopChildren() {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = true;
    stopChildren();
  });
}

async function waitForFrontend(frontend: Bun.Subprocess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (frontend.exitCode !== null) {
      throw new Error(
        `frontend dev proxy exited with code ${frontend.exitCode}`,
      );
    }
    try {
      const response = await fetch(APP_URL, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`frontend dev proxy did not start at ${APP_URL} within 30s`);
}

console.log(`Starting frontend dev proxy at ${APP_URL} ...`);
const frontend = spawn(["bun", "scripts/frontend-dev.ts"], ROOT);

try {
  await waitForFrontend(frontend);
  if (process.platform !== "darwin") {
    throw new Error("app:dev currently requires macOS");
  }
  if (!existsSync(join(MAC_APP_ROOT, "node_modules/electron/package.json"))) {
    console.log("Installing Open Session shell dependencies ...");
    const install = spawn(
      ["bun", "install", "--frozen-lockfile"],
      MAC_APP_ROOT,
    );
    if ((await install.exited) !== 0) {
      throw new Error("Open Session shell dependency installation failed");
    }
  }

  // Running `electron .` always presents Electron.app's own bundle identity to
  // macOS, so the Dock label remains "Electron" regardless of app.setName().
  // A directory build is fast and gives the dev process the real Open Session name,
  // icon, identifier, and native vibrancy while the loaded frontend still HMRs.
  console.log("Preparing Open Session development app ...");
  const packager = spawn(
    ["bunx", "electron-builder", "--mac", "--dir", "--publish", "never"],
    MAC_APP_ROOT,
    { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  );
  if ((await packager.exited) !== 0) {
    throw new Error("Open Session development app packaging failed");
  }
  if (frontend.exitCode !== null) {
    throw new Error(`frontend dev proxy exited with code ${frontend.exitCode}`);
  }
  if (!existsSync(MAC_APP_EXECUTABLE)) {
    throw new Error(
      `packaged Open Session executable not found at ${MAC_APP_EXECUTABLE}`,
    );
  }

  console.log("Launching Open Session ...");
  const electron = spawn([MAC_APP_EXECUTABLE], MAC_APP_ROOT, {
    ...process.env,
    OS1_URL: APP_URL,
  });

  const result = await Promise.race([
    frontend.exited.then((code) => ({ process: "frontend", code })),
    electron.exited.then((code) => ({ process: "Electron", code })),
  ]);
  if (!interrupted && result.code !== 0) {
    console.error(`${result.process} exited with code ${result.code}`);
  }
  process.exitCode = interrupted ? 130 : result.code;
} catch (error) {
  if (!interrupted)
    console.error(error instanceof Error ? error.message : error);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  stopChildren();
}
