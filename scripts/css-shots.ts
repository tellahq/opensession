#!/usr/bin/env bun
/**
 * Visual gate for the Tailwind migration: screenshots the running app across
 * routes x {desktop, mobile} x {dark, light} so a CSS change can be diffed
 * against a baseline.
 *
 *   bun scripts/css-shots.ts baseline          # capture a baseline
 *   ...make a change, rebuild the frontend...
 *   bun scripts/css-shots.ts after            # capture again
 *   bun scripts/css-shots.ts --diff baseline after
 *
 * Shots land in .frontend-dist/../.css-shots/<name>/ (gitignored).
 *
 * Starts a private, bounded headful Chrome+Xvfb automatically. Set CDP_PORT
 * only when deliberately connecting to an externally managed browser.
 *
 * Determinism matters more than it looks. Three things made early runs report
 * differences that were not there:
 *   · flipping the theme after load animates, so a capture can catch a dark
 *     sidebar against a still-light pane — the theme is seeded before navigation;
 *   · transitions/animations are frozen during capture;
 *   · the app renders live session data, so a fixed delay races it — each shot
 *     polls until two consecutive frames are identical.
 * Even so, list routes carry a noise floor of a few hundred pixels as
 * timestamps tick over. Capture two baselines back to back to measure it
 * before believing any small diff.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireCdpBrowser,
  cdpSender,
  closeCdpTarget,
  releaseCdpBrowser,
} from "./lib/cdp-browser";
import { localAutomationToken } from "./lib/local-auth";
import { captureInitScript, captureViewport } from "./lib/visual-capture";

const ROOT = join(import.meta.dir, "..");
const SHOTS = join(ROOT, ".css-shots");
const APP = process.env.OPENSESSION_URL ?? "http://127.0.0.1:3850";

const ROUTES: [string, string][] = [
  ["home", "/"],
  // The new-session palette. It is the densest cluster of controls in the app
  // and the surface whose phone layout was retrofitted after it shipped, so
  // it is the one most worth pinning at both widths.
  ["new", "/new"],
  ["settings", "/settings"],
  ["preferences", "/settings/preferences"],
  ["reviews", "/reviews"],
  ["automations", "/automations"],
];
const VIEWPORTS: [string, number, number][] = [
  ["desktop", 1440, 900],
  ["mobile", 390, 844],
];
const THEMES = ["dark", "light"];

const FREEZE = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; }
`;

// ── diff mode ───────────────────────────────────────────────────────────────
if (process.argv[2] === "--diff") {
  const [a, b] = [process.argv[3], process.argv[4]];
  if (!a || !b) {
    console.error("usage: bun scripts/css-shots.ts --diff <baseline> <after>");
    process.exit(2);
  }
  let worst = 0;
  for (const name of readdirSync(join(SHOTS, a)).sort()) {
    if (!name.endsWith(".png")) continue;
    let x: Buffer, y: Buffer;
    try {
      x = readFileSync(join(SHOTS, a, name));
      y = readFileSync(join(SHOTS, b, name));
    } catch {
      console.log(`  ${name.padEnd(38)} MISSING`);
      continue;
    }
    // Byte equality is the fast path; anything else needs a real look.
    const same = x.length === y.length && x.equals(y);
    if (!same) worst++;
    console.log(
      `  ${name.padEnd(38)} ${same ? "identical" : "DIFFERS — inspect"}`,
    );
  }
  console.log(
    `\n${worst} frame(s) differ. Byte-compare only: list routes tick timestamps,` +
      "\nso inspect the crops before concluding the CSS caused it.",
  );
  process.exit(0);
}

const OUT = join(SHOTS, process.argv[2] ?? "shots");
mkdirSync(OUT, { recursive: true });

// ── capture ─────────────────────────────────────────────────────────────────
const lease = await acquireCdpBrowser();
const PORT = lease.port;
let target: any;
let ws!: WebSocket;
try {
  target = await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`, {
    method: "PUT",
  }).then((r) => r.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const send = cdpSender(ws);

  const token = localAutomationToken();

  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  if (token)
    await send("Network.setCookie", {
      name: "opensession_auth",
      value: token,
      url: APP,
      path: "/",
    });
  /** Screenshot repeatedly until two consecutive frames match, or we give up. */
  async function settledShot(maxMs = 20000): Promise<string> {
    const t0 = Date.now();
    let prev = "";
    while (Date.now() - t0 < maxMs) {
      const s = await send("Page.captureScreenshot", { format: "png" });
      const cur = s?.data ?? "";
      if (cur && cur === prev) return cur;
      prev = cur;
      await new Promise((r) => setTimeout(r, 600));
    }
    return prev;
  }

  for (const [rname, path] of ROUTES) {
    for (const [vname, w, h] of VIEWPORTS) {
      await send(
        "Emulation.setDeviceMetricsOverride",
        captureViewport(w, h, vname === "mobile"),
      );
      for (const theme of THEMES) {
        const initScript = await send("Page.addScriptToEvaluateOnNewDocument", {
          source: captureInitScript({
            theme: theme as "light" | "dark",
            electronMaterial: vname === "desktop",
            freezeCss: FREEZE,
          }),
        });
        await send("Page.navigate", { url: "about:blank" });
        await new Promise((r) => setTimeout(r, 200));
        await send("Page.navigate", { url: APP + path });
        await new Promise((r) => setTimeout(r, 2500));
        const data = await settledShot();
        if (initScript?.identifier) {
          await send("Page.removeScriptToEvaluateOnNewDocument", {
            identifier: initScript.identifier,
          });
        }
        const file = join(OUT, `${rname}__${vname}__${theme}.png`);
        if (!data) {
          console.log(`  FAILED ${rname}/${vname}/${theme}`);
          continue;
        }
        writeFileSync(file, Buffer.from(data, "base64"));
        console.log(`  ${file.replace(ROOT + "/", "")}`);
      }
    }
  }
} finally {
  await closeCdpTarget(PORT, target?.id);
  ws?.close();
  await releaseCdpBrowser(lease);
}
