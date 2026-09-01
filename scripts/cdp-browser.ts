#!/usr/bin/env bun
/** Bounded headful Chrome+Xvfb launcher for agent-driven UI verification. */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  boundedCdpSystemdArgs,
  systemdUserEnv,
  waitForFile,
} from "./lib/cdp-browser";

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

function randomDisplay(): number {
  return 100 + Math.floor(Math.random() * 800);
}

if (command === "start") {
  const owner = (flag("owner", "unknown") || "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 24);
  const state = flag("state", `/tmp/opensession-cdp-${process.pid}.json`)!;
  const nonce = randomBytes(4).toString("hex");
  const unit = `opensession-cdp-${owner}-${nonce}.service`;
  const port = randomPort();
  const display = randomDisplay();
  const profile = `/tmp/opensession-cdp-profile-${nonce}`;
  const worker = import.meta.path;
  const args = [
    "systemd-run",
    "--user",
    `--unit=${unit}`,
    "--collect",
    "--quiet",
    `--description=Open Session bounded CDP browser owner=${owner}`,
    ...boundedCdpSystemdArgs(),
    "bun",
    worker,
    "worker",
    "--port",
    String(port),
    "--display",
    String(display),
    "--profile",
    profile,
    "--state",
    state,
  ];
  const env = systemdUserEnv();
  const proc = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    const detail = stderr.trim();
    // XDG_RUNTIME_DIR is always set now, so a bus error here means the user
    // manager itself is not running for this uid. Name that, instead of
    // leaving systemd's "No medium found" to be decoded from scratch again.
    throw new Error(
      /Failed to connect to bus|No medium found/.test(detail)
        ? `systemd-run failed: ${detail}\nThe user manager under ${env.XDG_RUNTIME_DIR} is unreachable; \`loginctl enable-linger\` for this user keeps one running.`
        : `systemd-run failed: ${detail}`,
    );
  }
  try {
    const ready = JSON.parse(await waitForFile(state, 20_000));
    console.log(JSON.stringify({ port: ready.port, unit }));
  } catch (error) {
    Bun.spawnSync(["systemctl", "--user", "stop", unit], { env });
    throw error;
  }
  process.exit(0);
}

if (command === "worker") {
  const port = Number(flag("port"));
  const display = Number(flag("display"));
  const profile = flag("profile")!;
  const state = flag("state")!;
  if (!port || !display || !profile || !state)
    throw new Error("worker requires port, display, profile, and state");
  if (
    await fetch(`http://127.0.0.1:${port}/json/version`)
      .then(() => true)
      .catch(() => false)
  )
    throw new Error(`CDP port ${port} is already in use`);
  const socket = `/tmp/.X11-unix/X${display}`;
  if (await Bun.file(socket).exists())
    throw new Error(`X display :${display} is already in use`);
  mkdirSync(profile, { recursive: true });
  const xvfb = Bun.spawn(
    ["/usr/bin/Xvfb", `:${display}`, "-screen", "0", "1600x1100x24"],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await sleep(500);
  const chrome = Bun.spawn(
    [
      Bun.which("google-chrome") || "/usr/bin/google-chrome",
      `--remote-debugging-port=${port}`,
      "--no-sandbox",
      "--disable-gpu",
      "--window-size=1600,1100",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    {
      env: { ...process.env, DISPLAY: `:${display}` },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await fetch(`http://127.0.0.1:${port}/json/version`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ready) break;
    if (chrome.exitCode !== null) break;
    await sleep(100);
  }
  if (!ready) {
    chrome.kill();
    xvfb.kill();
    rmSync(profile, { recursive: true, force: true });
    throw new Error("Chrome did not expose CDP within 10 seconds");
  }
  writeFileSync(state, JSON.stringify({ port, display, profile }));
  let idleSince = Date.now();
  const stop = () => {
    chrome.kill();
    xvfb.kill();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  while (chrome.exitCode === null && xvfb.exitCode === null) {
    await sleep(5_000);
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => r.json())
      .catch(() => [] as any[]);
    const busy =
      Array.isArray(targets) &&
      targets.some((t: any) => t.type === "page" && t.url !== "about:blank");
    if (busy) idleSince = Date.now();
    if (Date.now() - idleSince > 15 * 60_000) break;
  }
  stop();
  await Promise.race([Promise.all([chrome.exited, xvfb.exited]), sleep(5000)]);
  if (chrome.exitCode === null) chrome.kill(9);
  if (xvfb.exitCode === null) xvfb.kill(9);
  rmSync(profile, { recursive: true, force: true });
  rmSync(state, { force: true });
  process.exit(0);
}

if (command === "janitor") {
  const env = systemdUserEnv();
  const list = Bun.spawnSync(
    [
      "systemctl",
      "--user",
      "list-units",
      "--all",
      "--plain",
      "--no-legend",
      "opensession-cdp-*.service",
    ],
    { env },
  );
  const units = list.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  for (const unit of units) {
    const show = Bun.spawnSync(
      [
        "systemctl",
        "--user",
        "show",
        unit,
        "-p",
        "ActiveState",
        "-p",
        "MemoryCurrent",
        "-p",
        "TasksCurrent",
      ],
      { env },
    );
    const fields = Object.fromEntries(
      show.stdout
        .toString()
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2)),
    );
    if (
      fields.ActiveState === "active" &&
      (Number(fields.MemoryCurrent) > 4 * 1024 ** 3 ||
        Number(fields.TasksCurrent) > 256)
    ) {
      console.error(
        `stopping runaway ${unit}: memory=${fields.MemoryCurrent} tasks=${fields.TasksCurrent}`,
      );
      Bun.spawnSync(["systemctl", "--user", "stop", unit], { env });
    }
  }
  process.exit(0);
}

console.error("usage: bun scripts/cdp-browser.ts start|janitor");
process.exit(2);
