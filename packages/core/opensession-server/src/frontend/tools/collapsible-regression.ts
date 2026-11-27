#!/usr/bin/env bun
/** Real-browser nested disclosure regression, including interrupted motion.
 * Run: bun packages/core/opensession-server/src/frontend/tools/collapsible-regression.ts
 * No gateway, session state, or external services are used.
 */
import { join } from "node:path";
import {
  acquireCdpBrowser,
  cdpSender,
  closeCdpTarget,
  releaseCdpBrowser,
} from "../../../../../../scripts/lib/cdp-browser";
import { activeFrontendDist, compileAssets } from "../../server/frontend-build";
import { stylexBuildPlugin } from "../../server/stylex-transform";

const meta = await compileAssets();
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "collapsible-fixture.tsx")],
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
  // The fixture renders ui/ primitives; their StyleX CSS is in the
  // compileAssets() sheet linked below, under the same class names.
  plugins: [stylexBuildPlugin()],
});
if (!build.success) throw new Error(build.logs.join("\n"));
const script = await build.outputs[0]!.text();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/")
      return new Response(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${meta.cssName}"><link rel="stylesheet" href="/${meta.twName}"><div id="root"></div><script type="module" src="/fixture.js"></script>`,
        { headers: { "content-type": "text/html" } },
      );
    if (path === "/fixture.js")
      return new Response(script, {
        headers: { "content-type": "text/javascript" },
      });
    const file = Bun.file(join(activeFrontendDist(), path));
    return (await file.exists())
      ? new Response(file)
      : new Response("Not found", { status: 404 });
  },
});
const lease = await acquireCdpBrowser();
let targetId: string | undefined;
let socket: WebSocket | undefined;
try {
  const target = await (
    await fetch(`http://127.0.0.1:${lease.port}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json();
  targetId = target.id;
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) =>
    socket!.addEventListener("open", resolve, { once: true }),
  );
  const send = cdpSender(socket);
  const evaluate = async (expression: string) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const settle = () =>
    evaluate(`new Promise(resolve => {
    let count = 0;
    function frame() { if (++count === 30) resolve(true); else requestAnimationFrame(frame); }
    requestAnimationFrame(frame);
  })`);
  const click = async (name: string) => {
    const { nodes } = await send("Accessibility.getFullAXTree");
    const node = nodes.find(
      (n: any) => n.role?.value === "button" && n.name?.value === name,
    );
    if (!node) throw new Error(`Missing button: ${name}`);
    await send("DOM.scrollIntoViewIfNeeded", {
      backendNodeId: node.backendDOMNodeId,
    });
    const { model } = await send("DOM.getBoxModel", {
      backendNodeId: node.backendDOMNodeId,
    });
    const q = model.border;
    for (const type of ["mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", {
        type,
        x: (q[0] + q[2]) / 2,
        y: (q[1] + q[5]) / 2,
        button: "left",
        clickCount: 1,
      });
  };
  const assertFits = async (phase: string) => {
    const geometry = await evaluate(
      `Array.from(document.querySelectorAll('[style*="--collapsible-panel-height"]')).map(e => ({height:e.clientHeight, content:e.scrollHeight}))`,
    );
    if (
      !geometry.length ||
      geometry.some((g: any) => g.content > g.height + 1 || g.height === 0)
    )
      throw new Error(
        `${phase}: clipped disclosure ${JSON.stringify(geometry)}`,
      );
  };
  for (const width of [1440, 390]) {
    for (const reduced of [false, true]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: width === 390 ? 844 : 900,
        deviceScaleFactor: width === 390 ? 3 : 2,
        mobile: width === 390,
      });
      await send("Emulation.setEmulatedMedia", {
        features: [
          {
            name: "prefers-reduced-motion",
            value: reduced ? "reduce" : "no-preference",
          },
        ],
      });
      await send("Page.navigate", { url: server.url.origin });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(`!!document.querySelector('[data-outer]')`)) break;
        await settle();
      }
      await settle();
      await assertFits("initially open");
      await click("Toggle work");
      await settle();
      await click("Toggle step");
      await settle();
      await assertFits("nested expansion");
      await click("Append output");
      await settle();
      await assertFits("output growth");
      await click("Toggle work");
      await settle();
      if (
        await evaluate(
          `!!document.querySelector('[data-outer] [style*="--collapsible-panel-height"]')`,
        )
      )
        throw new Error("Closed content remained mounted");
      // Browser animation cancellation must not leave an open panel pinned to
      // its old measurement. This deliberately exercises completion cleanup
      // failing, rather than relying on a platform-specific cancellation race.
      await click("Toggle work");
      if (!reduced) {
        const cancelled = await evaluate(`new Promise(resolve => {
          let frames = 0;
          function cancel() {
            if (++frames < 6) { requestAnimationFrame(cancel); return; }
            const panel = document.querySelector('[data-outer] [style*="--collapsible-panel-height"]');
            const animations = panel.getAnimations();
            animations.forEach(animation => animation.cancel());
            resolve(animations.length);
          }
          requestAnimationFrame(cancel);
        })`);
        if (!cancelled) throw new Error("Opening animation was not exercised");
      }
      await settle();
      await click("Append output");
      await settle();
      await assertFits("growth after interrupted open");
      await click("Toggle work");
      await click("Toggle work");
      await settle();
      await assertFits("rapid close and reopen");
      console.log(`PASS ${width}px ${reduced ? "reduced" : "normal"} motion`);
    }
  }
} finally {
  socket?.close();
  await closeCdpTarget(lease.port, targetId);
  await releaseCdpBrowser(lease);
  server.stop(true);
}
