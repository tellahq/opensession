/**
 * Re-shoot the landing page's product poster.
 *
 * The landing page paints these local files immediately, then fades its
 * deterministic fixture app over the desktop poster when that app is ready.
 * This script turns the same isolated fixture into the desktop and phone
 * images shipped by the site, keeping the first frame aligned with the demo.
 *
 * Re-run it whenever the demo's fixtures or the app's chrome change:
 *
 *   bun run website:build && bun scripts/capture-demo-poster.ts
 *
 * One shot per theme, because the preview follows the visitor's system theme.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireCdpBrowser,
  closeCdpTarget,
  releaseCdpBrowser,
} from "./lib/cdp-browser";

const ROOT = join(import.meta.dir, "..");
const WEBSITE = join(ROOT, "packages", "clients", "website");

/**
 * The app's layout width used to produce the desktop poster.
 *
 * It is a zoom, not a taste. The window stands for a 14-inch MacBook Pro's
 * screen, which is 1512pt across, so laying the app out at 1260 draws its UI
 * at 1.2x life size: a page is looked at from desk distance rather than held,
 * and at 1.0x the product in it stops being readable. The phone below carries
 * the same 1.2x, which is what keeps the two from disagreeing.
 */
const APP_WIDTH = 1260;
/**
 * The desktop window's aspect: a 3:2 stage less an even 5.6% inset on all four
 * sides, which is 0.888W by 0.5547W. Narrower windows crop the poster from the
 * top rather than stretching it.
 */
const APP_HEIGHT = Math.round((APP_WIDTH * 0.5547) / 0.888);

/**
 * The phone beside it, at the same 1.2x. An iPhone 17 Pro is 393pt across a
 * 68mm screen in a 71.9mm body, and the poster fills the body, so 346pt is
 * that device's UI drawn 1.2x life. The shape stays the device's own.
 */
const PHONE_WIDTH = 346;
const PHONE_HEIGHT = Math.round((PHONE_WIDTH * 852) / 393);
/**
 * The status bar's band, handed to the page as a real safe-area inset rather
 * than as padding, so the app reserves it the way it does on a device: its
 * phone header already measures `env(safe-area-inset-top)` into its own
 * height. product-demo.html paints the clock and the indicators into it.
 *
 * 54pt is the bar on a 393pt iPhone 17 Pro, carried to this layout at the
 * same 1.2x the rest of the UI is drawn at.
 */
const PHONE_STATUS_H = Math.round((54 * PHONE_WIDTH) / 393);

const SHOTS = [
  {
    name: "demo-poster",
    width: APP_WIDTH,
    height: APP_HEIGHT,
    mobile: false,
    dpr: 2,
  },
  {
    name: "demo-phone",
    width: PHONE_WIDTH,
    height: PHONE_HEIGHT,
    mobile: true,
    dpr: 2,
  },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(port: number, targetId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  await new Promise((resolve) => (ws.onopen = () => resolve(null)));
  let id = 0;
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error
      ? p.reject(new Error(JSON.stringify(msg.error)))
      : p.resolve(msg.result);
  };
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { send, close: () => ws.close() };
}

if (!(await Bun.file(join(WEBSITE, ".next", "BUILD_ID")).exists()))
  throw new Error("no Next.js build — run `bun run website:build` first");

const reservation = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(""),
});
const port = reservation.port;
reservation.stop(true);
const nextServer = Bun.spawn(
  ["bun", "--cwd", WEBSITE, "start", "--port", String(port)],
  { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
);
const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 20_000;
while (
  !(await fetch(`${base}/product-demo.html`)
    .then((response) => response.ok)
    .catch(() => false))
) {
  if (Date.now() > deadline) throw new Error("Next.js website did not start");
  await sleep(100);
}
const scratch = mkdtempSync(join(tmpdir(), "demo-poster-"));

const lease = await acquireCdpBrowser();
try {
  for (const shot of SHOTS)
    for (const theme of ["light", "dark"] as const) {
      const created = await fetch(
        `http://127.0.0.1:${lease.port}/json/new?about:blank`,
        { method: "PUT" },
      ).then((r) => r.json());
      const t = await connect(lease.port, created.id);
      try {
        await t.send("Page.enable");
        await t.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        if (shot.mobile)
          await t.send("Emulation.setSafeAreaInsetsOverride", {
            insets: { top: PHONE_STATUS_H },
          });
        await t.send("Emulation.setDeviceMetricsOverride", {
          width: shot.width,
          height: shot.height,
          deviceScaleFactor: shot.dpr,
          mobile: shot.mobile,
        });
        await t.send("Page.navigate", { url: `${base}/product-demo.html` });

        // The composer is the last thing the demo paints, so it standing in the
        // window is the signal that there is a product to photograph.
        const deadline = Date.now() + 40_000;
        for (;;) {
          const { result } = await t.send("Runtime.evaluate", {
            expression: `!!document.querySelector('.composer-textarea, [class*="composer"] textarea')`,
            returnByValue: true,
          });
          if (result.value) break;
          if (Date.now() > deadline)
            throw new Error("the demo never finished painting");
          await sleep(250);
        }
        // The phone shows the list rather than the session: the window beside it
        // is already the transcript, and a pair that says the same paragraph
        // twice reads as one screenshot pasted at two sizes. The whole product
        // in a pocket is the claim worth making.
        if (shot.mobile) {
          await t.send("Runtime.evaluate", {
            expression: `document.querySelector('[aria-label="Back to sidebar"]')?.click()`,
          });
          await sleep(1200);
        }
        await sleep(1500);
        await t.send("Page.bringToFront");
        const frame = await t.send("Page.captureScreenshot", { format: "png" });
        const png = join(scratch, `${shot.name}-${theme}.png`);
        writeFileSync(png, Buffer.from(frame.data, "base64"));
        const out = join(
          ROOT,
          "packages",
          "clients",
          "website",
          `${shot.name}${theme === "dark" ? "-dark" : ""}.webp`,
        );
        const convert = Bun.spawnSync([
          "python3",
          "-c",
          `from PIL import Image; Image.open(${JSON.stringify(png)}).convert("RGB").save(${JSON.stringify(out)}, "WEBP", quality=82, method=6)`,
        ]);
        if (convert.exitCode !== 0) throw new Error(convert.stderr.toString());
        const size = Bun.file(out).size / 1024;
        console.log(
          `${shot.name} ${theme}: ${out} (${size.toFixed(0)} KB, ${shot.width}x${shot.height} at ${shot.dpr}x)`,
        );
      } finally {
        t.close();
        await closeCdpTarget(lease.port, created.id);
      }
    }
} finally {
  await releaseCdpBrowser(lease);
  nextServer.kill();
  await nextServer.exited;
  rmSync(scratch, { recursive: true, force: true });
}
