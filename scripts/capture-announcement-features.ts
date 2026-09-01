/**
 * Capture the focused product screenshots used in the announcement article.
 *
 * The shots use the same deterministic fixture as the landing demo. The
 * article supplies the blue stage itself, so these files contain only clean,
 * zoomed crops of the real product UI.
 *
 *   bun run website:build && bun scripts/capture-announcement-features.ts
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
const APP_WIDTH = 1260;
const APP_HEIGHT = 787;
const DPR = 2;

const shots = [
  {
    name: "announcement-collaboration",
    feature: "collaboration",
    ready: `!!document.querySelector('.composer-textarea, [class*="composer"] textarea')`,
    clip: { x: 0, y: 0, width: 650, height: 720 },
  },
  {
    name: "announcement-sessions",
    feature: "sessions",
    ready: `document.body.innerText.includes('49 checks') && !!document.querySelector('img[src$="audio-waveform-options.svg"]')?.complete`,
    viewport: { width: 1600, height: 1000 },
    clip: { x: 0, y: 0, width: 1600, height: 1000 },
  },
  {
    name: "announcement-desk",
    feature: "desk",
    actionReady: `!!document.querySelector('[aria-label="Open the Desk"]')`,
    action: `document.querySelector('[aria-label="Open the Desk"]')?.click()`,
    ready: `document.body.innerText.includes('What’s being worked on right now?')`,
    clip: { x: 145, y: 90, width: 970, height: 606 },
  },
  {
    name: "announcement-automations",
    feature: "automations",
    ready: `document.body.innerText.includes('Review stale pull requests')`,
    clip: { x: 300, y: 18, width: 960, height: 380 },
  },
  {
    name: "announcement-walkthroughs",
    feature: "walkthroughs",
    ready: `document.body.innerText.includes('Workspace presence is now visible at a glance')`,
    clip: { x: 300, y: 0, width: 960, height: 787 },
  },
] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(
  port: number,
  targetId: string,
  mediaBodies: { before: string; after: string },
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  await new Promise((resolve) => (ws.onopen = () => resolve(null)));
  let id = 0;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const messageId = ++id;
      pending.set(messageId, { resolve, reject });
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });

  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Fetch.requestPaused") {
      void send("Fetch.fulfillRequest", {
        requestId: message.params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "image/webp" }],
        body: message.params.request.url.includes("before")
          ? mediaBodies.before
          : mediaBodies.after,
      });
      return;
    }
    const request = message.id && pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error
      ? request.reject(new Error(JSON.stringify(message.error)))
      : request.resolve(message.result);
  };
  return { send, close: () => ws.close() };
}

const suppliedBase = process.env.OPENSESSION_WEBSITE_URL?.replace(/\/$/, "");
if (
  !suppliedBase &&
  !(await Bun.file(join(WEBSITE, ".next", "BUILD_ID")).exists())
) {
  throw new Error("no Next.js build — run `bun run website:build` first");
}

let nextServer: ReturnType<typeof Bun.spawn> | undefined;
let base = suppliedBase;
if (!base) {
  const reservation = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(""),
  });
  const port = reservation.port;
  reservation.stop(true);
  nextServer = Bun.spawn(
    ["bun", "--cwd", WEBSITE, "start", "--port", String(port)],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  base = `http://127.0.0.1:${port}`;
}
const serverDeadline = Date.now() + 20_000;
while (
  !(await fetch(`${base}/product-demo.html`)
    .then((response) => response.ok)
    .catch(() => false))
) {
  if (Date.now() > serverDeadline)
    throw new Error("Next.js website did not start");
  await sleep(100);
}

const scratch = mkdtempSync(join(tmpdir(), "announcement-features-"));
const mediaBodies = {
  before: Buffer.from(
    await Bun.file(join(WEBSITE, "download-mac.webp")).arrayBuffer(),
  ).toString("base64"),
  after: Buffer.from(
    await Bun.file(join(WEBSITE, "demo-poster.webp")).arrayBuffer(),
  ).toString("base64"),
};
const lease = await acquireCdpBrowser();
try {
  for (const shot of shots) {
    const created = await fetch(
      `http://127.0.0.1:${lease.port}/json/new?about:blank`,
      { method: "PUT" },
    ).then((response) => response.json());
    const target = await connect(lease.port, created.id, mediaBodies);
    try {
      await target.send("Page.enable");
      await target.send("Runtime.enable");
      await target.send("Fetch.enable", {
        patterns: [{ urlPattern: "*/media?path=*", requestStage: "Request" }],
      });
      await target.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "light" }],
      });
      const viewport =
        "viewport" in shot
          ? shot.viewport
          : { width: APP_WIDTH, height: APP_HEIGHT };
      await target.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: DPR,
        mobile: false,
      });
      await target.send("Page.navigate", {
        url: `${base}/product-demo.html?feature=${shot.feature}`,
      });

      if ("action" in shot) {
        const actionDeadline = Date.now() + 40_000;
        for (;;) {
          const { result } = await target.send("Runtime.evaluate", {
            expression: shot.actionReady,
            returnByValue: true,
          });
          if (result.value) break;
          if (Date.now() > actionDeadline) {
            throw new Error(`${shot.name} action never became available`);
          }
          await sleep(250);
        }
        await target.send("Runtime.evaluate", { expression: shot.action });
      }

      const readyDeadline = Date.now() + 40_000;
      for (;;) {
        const { result } = await target.send("Runtime.evaluate", {
          expression: shot.ready,
          returnByValue: true,
        });
        if (result.value) break;
        if (Date.now() > readyDeadline) {
          throw new Error(`${shot.name} never finished painting`);
        }
        await sleep(250);
      }
      if (shot.feature === "walkthroughs") {
        await target.send("Runtime.evaluate", {
          expression: `Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Walkthrough'))?.scrollIntoView({ block: 'center' })`,
        });
      }
      await sleep(1_200);
      await target.send("Page.bringToFront");
      const frame = await target.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        clip: { ...shot.clip, scale: 1 },
      });
      const png = join(scratch, `${shot.name}.png`);
      writeFileSync(png, Buffer.from(frame.data, "base64"));
      const output = join(WEBSITE, `${shot.name}.webp`);
      const convert = Bun.spawnSync([
        "python3",
        "-c",
        `from PIL import Image; Image.open(${JSON.stringify(png)}).convert("RGB").save(${JSON.stringify(output)}, "WEBP", quality=84, method=6)`,
      ]);
      if (convert.exitCode !== 0) throw new Error(convert.stderr.toString());
      console.log(
        `${shot.name}: ${output} (${(Bun.file(output).size / 1024).toFixed(0)} KB)`,
      );
    } finally {
      target.close();
      await closeCdpTarget(lease.port, created.id);
    }
  }
} finally {
  await releaseCdpBrowser(lease);
  if (nextServer) {
    nextServer.kill();
    await nextServer.exited;
  }
  rmSync(scratch, { recursive: true, force: true });
}
