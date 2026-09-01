#!/usr/bin/env bun
/**
 * Screenshot the NATIVE app (os1-ios) in one command — the `capture-ui.ts` of
 * the Swift client.
 *
 * A Linux host has no Xcode and no simulator, so every native screenshot has to
 * happen on a Mac build node: rsync the tree, regenerate the Xcode project,
 * build, boot a device, install, launch with the server env, screenshot, copy
 * the PNG back. That chain was accumulated session lore rather than a command,
 * and the cost of rediscovering it is why native changes shipped without
 * walkthroughs while web changes got them for free.
 *
 * Two surfaces, and the second is not a consolation prize:
 *
 *   --platform ios   the simulator. What you want when the change is about a
 *                    phone: safe areas, the keyboard, sheets, Dynamic Type.
 *   --platform mac   the macOS target. The SAME SwiftUI views with no
 *                    simulator underneath, so it costs a fraction of the load
 *                    and renders when the box is too busy for a device. For a
 *                    transcript row, a chip, a colour or a layout fix it is
 *                    the better picture, not the fallback one.
 *
 * The app talks to the server over the TAILNET (`--server`, default the public
 * origin), not a reverse SSH tunnel. Tunnels were the old recipe and they are
 * the biggest source of silent failure here: the port collides between
 * sessions, a dead tunnel leaves a stale listener that makes every later `-R`
 * fail while the unit still reports active, and the server rejects human
 * web-session tokens on loopback while still answering `/api/auth/status` — so
 * the app looks signed in while every poll 401s and the UI sits on a loading
 * state for ever. The Mac node is on the tailnet; talking to the public origin
 * as the machine Automation identity avoids all of it.
 *
 * Every guard below turns a symptom that reads as "the app is broken" into a
 * sentence about the rig: a wedged CoreSimulator (out of disk — every simctl
 * verb then hangs with NO output), a load-pinned box (skeleton screen, frozen
 * simulator clock), a stale `OS1.xcodeproj` after rsync (a silently stale file
 * set), an archived session the launch hook ignores, another session's device.
 *
 *   bun scripts/capture-ios.ts /tmp/after.png
 *   bun scripts/capture-ios.ts /tmp/after.png --session os-… --theme dark
 *   bun scripts/capture-ios.ts /tmp/after.png --platform mac
 *   bun scripts/capture-ios.ts /tmp/after.png --env OS1_OPEN_SETTINGS=appearance
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { localAutomationToken } from "./lib/local-auth";

const argv = process.argv.slice(2);
const output = argv.find((value) => !value.startsWith("--"));
const flag = (name: string, fallback?: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);
/** Repeatable flag: every `--env K=V` occurrence, in order. */
const flags = (name: string) =>
  argv.flatMap((value, index) =>
    value === `--${name}` && argv[index + 1] ? [argv[index + 1]] : [],
  );

const USAGE = `usage: bun scripts/capture-ios.ts <output.png> [options]

  --platform ios|mac    simulator, or the macOS target (default: ios)
  --source <dir>        os1-ios directory to build (default: this checkout's).
                        A detached worktree here is how you capture a BEFORE.
  --session <id>        open this session on launch (OS1_OPEN_SESSION)
  --device <name>       simulator device type (default: iPhone 17 Pro)
  --theme light|dark    appearance (default: the app's own)
  --env KEY=VALUE       extra launch env, repeatable (node-only debug hooks)
  --wait <ms>           settle before the screenshot (default: 45000)
  --server <url>        server the app talks to (default: the configured origin)
  --node <host>         Mac build node over ssh (default: tella-mac-node)
  --max-load <n>        1-min load average the simulator needs (default: 100)
  --load-wait <ms>      how long to wait for a busy box (default: 300000)
  --rebuild             force xcodegen + a clean build
  --clean               delete the remote build tree afterwards (slow reruns)
  --keep-device         leave the simulator booted (it pins the box's load)`;

if (!output) {
  console.error(USAGE);
  process.exit(2);
}
if (!output.endsWith(".png")) throw new Error("output must be a .png path");

const NODE = flag("node", process.env.OS1_MAC_NODE || "tella-mac-node")!;
const PLATFORM = flag("platform", "ios")!;
const DEVICE_TYPE = flag("device", "iPhone 17 Pro")!;
const THEME = flag("theme");
const SESSION = flag("session");
const WAIT_MS = Number(flag("wait", "45000"));
const MAX_LOAD = Number(flag("max-load", "100"));
const LOAD_WAIT_MS = Number(flag("load-wait", "300000"));
const LAUNCH_ENV = flags("env");

if (PLATFORM !== "ios" && PLATFORM !== "mac")
  throw new Error("platform must be ios or mac");
if (THEME && THEME !== "light" && THEME !== "dark")
  throw new Error("theme must be light or dark");
for (const [name, value] of [
  ["wait", WAIT_MS],
  ["max-load", MAX_LOAD],
  ["load-wait", LOAD_WAIT_MS],
] as const) {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a non-negative number`);
}
for (const pair of LAUNCH_ENV) {
  if (!/^[A-Z_][A-Z0-9_]*=/.test(pair))
    throw new Error(`--env must be KEY=VALUE (uppercase key): ${pair}`);
}

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(output);
const SOURCE = resolve(flag("source", `${ROOT}/packages/clients/ios`)!);

/**
 * One build tree per Open Session session, not per invocation: a cold build is
 * 5-8 minutes and an incremental one is seconds, so a stable path is what makes
 * a second screenshot cheap enough to actually take. Keyed on the session id
 * (never a shared literal like `/tmp/os1-check`) because parallel sessions
 * adopting each other's trees, devices and ports is a recurring, silent failure
 * here — one session's build lands in another's tree and the screenshot shows
 * the wrong code. The source dir is part of the key too, so capturing a BEFORE
 * from a detached worktree does not evict the AFTER tree and force both sides
 * of a pair to rebuild cold.
 */
const TAG = createHash("sha256")
  .update(
    `${process.env.OPENSESSION_SESSION_ID || process.env.OPENSESSION_RUN_KEY || ROOT}\0${SOURCE}`,
  )
  .digest("hex")
  .slice(0, 8);
const TREE = `/tmp/os1-capture-${TAG}`;
const DEVICE_NAME = `os1cap-${TAG}`;
const REMOTE_SHOT = `${TREE}/shot.png`;

const SERVER =
  flag("server") ||
  process.env.OPENSESSION_PUBLIC_URL ||
  "https://os.tella.dev";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const step = (message: string) => console.error(`[capture-ios] ${message}`);

/** Run a script on the Mac node over stdin — no quoting to get wrong. */
async function node(
  script: string,
  opts: { quiet?: boolean } = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", NODE, "bash", "-s"], {
    stdin: new TextEncoder().encode(`set -euo pipefail\n${script}\n`),
    stdout: "pipe",
    stderr: opts.quiet ? "pipe" : "inherit",
  });
  const [code, out] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  return { code, out: out.trim() };
}

async function nodeOrThrow(script: string, what: string): Promise<string> {
  const { code, out } = await node(script);
  if (code !== 0) throw new Error(`${what} failed on ${NODE} (exit ${code})`);
  return out;
}

/**
 * Build, and on failure print the compile errors rather than a bare
 * "** BUILD FAILED **" — `-quiet` swallows everything else, so the log is kept
 * on the node and the `error:` lines are pulled out of it.
 *
 * The hint matters as much as the errors: this repo builds from a SHARED
 * checkout where other sessions have uncommitted edits, so a Swift error in a
 * file you never touched is usually someone else's work in flight, not yours.
 */
async function build(scheme: string, extra: string): Promise<void> {
  step(`xcodebuild ${scheme} (a cold build takes 5-8 minutes)`);
  const log = `${TREE}/build.log`;
  // -skipMacroValidation: SwiftStreamingMarkdown pins the Equatable compiler
  // macro, whose trust prompt cannot be answered over SSH.
  const result = await node(
    `
    cd ${TREE}/os1-ios
    set +e
    xcodebuild build -skipMacroValidation -project OS1.xcodeproj -scheme ${scheme} \
      ${extra} -derivedDataPath ${TREE}/dd >${log} 2>&1
    code=$?
    set -e
    [ $code -eq 0 ] || grep -E 'error:' ${log} | head -25
    exit $code
  `,
    { quiet: true },
  );
  if (result.code === 0) return;
  const errors = result.out || "(no error: lines — see the log)";
  throw new Error(
    `xcodebuild ${scheme} failed:\n${errors}\n\n` +
      `Full log: ${NODE}:${log}\n` +
      `If an error names a file you did not touch, check whether another session is ` +
      `mid-edit in this shared checkout — \`git status --porcelain packages/clients/ios/\`, and ` +
      `\`git show HEAD:<file>\` to compare. Capture a known-good build meanwhile with ` +
      `--source from a detached worktree: ` +
      `\`git worktree add --detach /tmp/wt-$$ HEAD\` then \`--source /tmp/wt-$$/packages/clients/ios\`.`,
  );
}

async function loadAverage(): Promise<number> {
  const { out } = await node(`sysctl -n vm.loadavg | awk '{print $2}'`, {
    quiet: true,
  });
  return Number(out);
}

// ── Preflight ───────────────────────────────────────────────────────────────

step(`preflight on ${NODE} (${PLATFORM})`);
const preflight = await node(
  `
  echo "xcode=$(xcodebuild -version 2>/dev/null | head -1 || echo none)"
  echo "freeGB=$(df -g /System/Volumes/Data | tail -1 | awk '{print $4}')"
  echo "load1=$(sysctl -n vm.loadavg | awk '{print $2}')"
  echo "cpus=$(sysctl -n hw.ncpu)"
  echo "xcodegen=$(command -v xcodegen >/dev/null && echo yes || echo no)"
`,
  { quiet: true },
);
if (preflight.code !== 0)
  throw new Error(
    `cannot reach the Mac build node "${NODE}" over ssh. Native screenshots need one; ` +
      `set --node or OS1_MAC_NODE, or say in your summary that native capture was unavailable.`,
  );
const facts = Object.fromEntries(
  preflight.out.split("\n").map((line) => line.split("=") as [string, string]),
);
if (facts.xcodegen !== "yes")
  throw new Error(
    `${NODE} has no xcodegen on PATH — the Xcode project is generated`,
  );
const freeGB = Number(facts.freeGB);
step(
  `Xcode ${(facts.xcode || "").replace("Xcode ", "")} · ${freeGB}GB free · ` +
    `load ${facts.load1} on ${facts.cpus} cores`,
);

// Below ~8GB the build dies mid-compile with per-file "Mkdtemp … No space left
// on device" errors, and CoreSimulator wedges machine-wide: every simctl verb
// hangs for ever with no output while `simctl io screenshot` keeps working, so
// it looks like the app rather than the box.
if (Number.isFinite(freeGB) && freeGB < 8)
  throw new Error(
    `${NODE} has only ${freeGB}GB free. Below ~8GB builds fail mid-compile and ` +
      `CoreSimulator wedges machine-wide. Free space first: delete your own ` +
      `/tmp/os1-* trees and \`xcrun simctl delete\` your own simulators.`,
  );

// A booted simulator runs a full iOS userspace, so a shared box is BUSY by
// default and a hard refusal would just push runs back to skipping the
// screenshot. Wait for the spike to pass (a freshly booted device settles in a
// couple of minutes), and only then refuse — naming the surface that does not
// need a simulator at all.
if (PLATFORM === "ios" && MAX_LOAD > 0) {
  const deadline = Date.now() + LOAD_WAIT_MS;
  let load = Number(facts.load1);
  while (load > MAX_LOAD && Date.now() < deadline) {
    step(
      `load ${load} is above ${MAX_LOAD} — waiting up to ` +
        `${Math.ceil((deadline - Date.now()) / 1000)}s for the box to settle`,
    );
    await sleep(20_000);
    load = await loadAverage();
  }
  if (load > MAX_LOAD) {
    const booted = await node(
      `xcrun simctl list devices booted | grep Booted || true`,
      { quiet: true },
    );
    throw new Error(
      `${NODE} is still at load ${load} (ceiling ${MAX_LOAD}). A simulator will not ` +
        `render in time — the app hangs on its skeleton and the simulator clock freezes ` +
        `in screenshots.\nUse --platform mac instead: the macOS target runs the same ` +
        `SwiftUI views with no simulator underneath, which is enough for any transcript, ` +
        `chip, colour or layout change.\nBooted devices right now:\n${booted.out || "  (none)"}`,
    );
  }
}

const token = localAutomationToken();
if (!token)
  throw new Error(
    "no Automation web identity to authenticate the app with — restart the server",
  );

// The app is useless without a server it can reach, and an unreachable one
// looks exactly like a broken screen. Prove reachability FROM THE NODE before
// spending minutes on a build, against a real data route: /api/auth/status is
// exempt from some rejections and answers 200 even when every poll 401s.
step(`checking ${SERVER} from ${NODE}`);
const reach = await node(
  `curl -s -o /dev/null -m 15 -w '%{http_code}' -H 'Authorization: Bearer ${token}' ` +
    `'${SERVER}/api/sessions?archived=exclude&slim=1'`,
  { quiet: true },
);
if (reach.out !== "200")
  throw new Error(
    `${NODE} cannot reach ${SERVER} as the Automation identity (HTTP ${reach.out || "no response"}). ` +
      `The app would launch and sit on a loading state for ever. Check the tailnet, or pass --server.`,
  );

// An archived session is absent from the app's live list, and the launch hook
// only matches that list — so the app silently lands on the sessions list and
// it reads as the env being ignored.
if (SESSION) {
  const probe = await fetch(
    `${SERVER}/api/sessions/${encodeURIComponent(SESSION)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).catch(() => null);
  const session = probe?.ok
    ? ((await probe.json()) as { archived?: boolean })
    : null;
  if (!session) step(`warning: session ${SESSION} not found on ${SERVER}`);
  else if (session.archived)
    step(
      `warning: session ${SESSION} is ARCHIVED — the app only auto-opens sessions in ` +
        `its live list, so it will land on the sessions list instead. Unarchive it first ` +
        `(POST /api/sessions/${SESSION}/archive {"archived":false}).`,
    );
}

// ── Sync + generate ─────────────────────────────────────────────────────────

if (has("rebuild")) {
  step("--rebuild: clearing the remote tree");
  await nodeOrThrow(`rm -rf ${TREE}`, "clean");
}

if (!existsSync(`${SOURCE}/project.yml`))
  throw new Error(
    `--source must be an os1-ios directory (no project.yml in ${SOURCE})`,
  );

step(`syncing ${SOURCE} to ${NODE}:${TREE}`);
// Spotlight indexing abandoned build trees has pinned this box at >100% CPU
// with no build running at all; the marker costs nothing and prevents it.
await nodeOrThrow(
  `mkdir -p ${TREE}/os1-ios && touch ${TREE}/.metadata_never_index`,
  "mkdir",
);
const rsync = Bun.spawn(
  [
    "rsync",
    "-a",
    "--delete",
    // Never ship the generated project or derived data over the wire: the
    // project is regenerated below, and derived data must stay on the node.
    "--exclude=OS1.xcodeproj",
    "--exclude=dd/",
    `${SOURCE}/`,
    `${NODE}:${TREE}/os1-ios/`,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await rsync.exited) !== 0) throw new Error("rsync to the Mac node failed");

// The generated project lists sources EXPLICITLY and rsync --delete removes it,
// so a reused tree without this step compiles a stale file set — which surfaces
// as "cannot find type X in scope" in files you never touched, or as a
// false-green build that silently omitted your new file.
step("xcodegen generate");
await nodeOrThrow(
  `cd ${TREE}/os1-ios && xcodegen generate --quiet`,
  "xcodegen",
);

/** Launch env, shell-quoted. Native launches read these directly; simulator
 *  launches take the same names under simctl's SIMCTL_CHILD_ prefix. */
function launchEnv(prefix: string): string {
  return [
    `OS1_SERVER=${SERVER}`,
    `OS1_TOKEN=${token}`,
    ...(SESSION ? [`OS1_OPEN_SESSION=${SESSION}`] : []),
    ...LAUNCH_ENV,
  ]
    .map((pair) => {
      const eq = pair.indexOf("=");
      return `${prefix}${pair.slice(0, eq)}='${pair.slice(eq + 1)}'`;
    })
    .join(" ");
}

let captured = false;
let cleanup = async () => {};

try {
  if (PLATFORM === "ios") {
    // Create the device BEFORE building so the build targets its exact runtime.
    // Our own device, named after this session: sibling sessions adopt whatever
    // is Booted otherwise and drive their commands into it.
    step(`simulator ${DEVICE_NAME} (${DEVICE_TYPE})`);
    const udid = await nodeOrThrow(
      `
      existing=$(xcrun simctl list devices | grep "${DEVICE_NAME} (" | head -1 | sed -E 's/.*\\(([0-9A-Fa-f-]{36})\\).*/\\1/' || true)
      if [ -z "$existing" ]; then
        runtime=$(xcrun simctl list runtimes | grep -E '^iOS' | tail -1 | sed -E 's/.*(com\\.apple\\.CoreSimulator\\.SimRuntime\\.iOS-[0-9-]+).*/\\1/')
        existing=$(xcrun simctl create "${DEVICE_NAME}" "${DEVICE_TYPE}" "$runtime")
      fi
      echo "$existing"
    `,
      "simctl create",
    );
    if (!/^[0-9A-Fa-f-]{36}$/.test(udid))
      throw new Error(
        `could not resolve a simulator udid (got: ${udid.slice(0, 120)})`,
      );

    cleanup = async () => {
      // A booted device is the single biggest load source on this box — six of
      // them took the 1-minute load average past 300 with no build running.
      // Always shut ours down; it stays registered so the next run reuses it.
      if (!has("keep-device")) {
        step("shutting the simulator down");
        await node(`xcrun simctl shutdown ${udid} 2>/dev/null || true`, {
          quiet: true,
        });
      }
      if (has("clean"))
        await node(
          `rm -rf ${TREE}; xcrun simctl delete ${udid} 2>/dev/null || true`,
          {
            quiet: true,
          },
        );
    };

    await build("OS1", `-destination "platform=iOS Simulator,id=${udid}"`);

    step("install + launch");
    await nodeOrThrow(
      `
      xcrun simctl boot ${udid} 2>/dev/null || true
      xcrun simctl bootstatus ${udid} -b >/dev/null
      app=$(find ${TREE}/dd/Build/Products/Debug-iphonesimulator -maxdepth 1 -name '*.app' | head -1)
      [ -n "$app" ] || { echo "no built .app found" >&2; exit 1; }
      bundle=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")
      ${THEME ? `xcrun simctl ui ${udid} appearance ${THEME}` : ""}
      # Reinstall every run: a stored value shadows a launch-env default, so a
      # changed --env would otherwise be silently ignored.
      xcrun simctl uninstall ${udid} "$bundle" 2>/dev/null || true
      xcrun simctl install ${udid} "$app"
      ${launchEnv("SIMCTL_CHILD_")} xcrun simctl launch ${udid} "$bundle" >/dev/null
      sleep ${Math.ceil(WAIT_MS / 1000)}
      xcrun simctl io ${udid} screenshot ${REMOTE_SHOT} >/dev/null 2>&1
    `,
      "install/launch/screenshot",
    );
  } else {
    // CODE_SIGNING_ALLOWED=NO: a Mac-target errSecInternalComponent CodeSign
    // failure over SSH is the box's locked keychain, not a code error.
    await build(
      "OS1Mac",
      `-destination "platform=macOS" CODE_SIGNING_ALLOWED=NO`,
    );

    cleanup = async () => {
      await node(`pkill -f '${TREE}/dd/Build/Products' 2>/dev/null || true`, {
        quiet: true,
      });
      if (has("clean")) await node(`rm -rf ${TREE}`, { quiet: true });
    };

    step("launch + capture the window");
    // Capture the WINDOW, not a screen rect. This box is shared, and a region
    // capture picks up whatever another session put on screen — a foreign
    // permission dialog landed in the middle of the first Mac capture. Window
    // capture excludes everything above it. CGWindowID needs a real API call,
    // and the node has no pyobjc, so a throwaway Swift script does it; owner
    // name (unlike window name) needs no screen-recording grant.
    await nodeOrThrow(
      `cat > ${TREE}/windowid.swift <<'SWIFT'
import CoreGraphics
import Foundation
let owner = CommandLine.arguments[1]
let windows = CGWindowListCopyWindowInfo(
  [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
) as? [[String: Any]] ?? []
for window in windows {
  guard window[kCGWindowOwnerName as String] as? String == owner,
        window[kCGWindowLayer as String] as? Int == 0,
        let number = window[kCGWindowNumber as String] as? Int else { continue }
  print(number)
  exit(0)
}
exit(1)
SWIFT`,
      "write windowid helper",
    );
    // The Mac target's PRODUCT_NAME is the app's LABEL, so neither the .app nor
    // the executable has a fixed name here — read both off the bundle.
    await nodeOrThrow(
      `
      app=$(find ${TREE}/dd/Build/Products/Debug -maxdepth 1 -name '*.app' | head -1)
      [ -n "$app" ] || { echo "no built .app found" >&2; exit 1; }
      # A macOS bundle keeps its Info.plist under Contents/, not at the root
      # like an iOS one.
      exe=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
      pkill -f "$app/Contents/MacOS/" 2>/dev/null || true
      ${launchEnv("")} nohup "$app/Contents/MacOS/$exe" >/tmp/os1-capture-${TAG}.log 2>&1 </dev/null &
      sleep ${Math.ceil(WAIT_MS / 1000)}
      # Park the window at a fixed rect: sibling sessions' windows steal the
      # foreground, so raise ours in the SAME breath as the capture.
      osascript -e 'tell application "System Events" to tell process "'"$exe"'"
        set frontmost to true
        set position of window 1 to {80, 60}
        set size of window 1 to {1280, 860}
      end tell' >/dev/null 2>&1 || true
      sleep 3
      id=$(swift ${TREE}/windowid.swift "$exe" 2>/dev/null || true)
      if [ -n "$id" ]; then
        screencapture -x -o -l"$id" ${REMOTE_SHOT}
      else
        # Fall back to the rect we parked the window at. Anything another
        # session floats over that rect lands in the frame — check the shot.
        echo "warning: no window id for $exe; capturing the region instead" >&2
        screencapture -x -R80,60,1280,860 ${REMOTE_SHOT}
      fi
    `,
      "launch/capture",
    );
  }

  step("copying the screenshot back");
  mkdirSync(dirname(OUT), { recursive: true });
  const scp = Bun.spawn(["scp", "-q", `${NODE}:${REMOTE_SHOT}`, OUT], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await scp.exited) !== 0) throw new Error("scp of the screenshot failed");
  captured = true;
} finally {
  await cleanup();
}

if (captured) {
  const size = await node(
    `sips -g pixelWidth -g pixelHeight ${REMOTE_SHOT} 2>/dev/null | tail -2 | awk '{print $2}' | paste -sd x -`,
    { quiet: true },
  );
  console.log(
    `${OUT}\n${size.out || "device-native"} · ` +
      `${PLATFORM === "ios" ? DEVICE_TYPE : "macOS"}${THEME ? ` · ${THEME}` : ""} · ` +
      `build tree ${NODE}:${TREE} (reused next run; --clean to remove)`,
  );
}
