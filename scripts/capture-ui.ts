#!/usr/bin/env bun
/** Capture the running app with Mac/Retina-quality desktop defaults. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openCdpSession } from "./lib/cdp-session";
import { localAutomationToken } from "./lib/local-auth";
import { captureInitScript, captureViewport } from "./lib/visual-capture";

const argv = process.argv.slice(2);

// Flags that consume the next argument. Tracking them is what keeps a selector
// or a route from being read as the output path.
const VALUE_FLAGS = new Set([
  "route",
  "width",
  "height",
  "theme",
  "wait",
  "step-wait",
  "seek",
  "click",
  "hover",
  "eval",
  "script",
]);
type StepKind = "click" | "hover" | "eval" | "script";
const STEP_FLAGS = new Set<string>(["click", "hover", "eval", "script"]);

// Steps run in the order they were written, so --hover x --click y is a
// sequence rather than a set.
const steps: { kind: StepKind; value: string }[] = [];
const consumed = new Set<number>();
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]!;
  if (!arg.startsWith("--")) continue;
  const name = arg.slice(2);
  if (!VALUE_FLAGS.has(name)) continue;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`--${name} needs a value`);
  consumed.add(index + 1);
  if (STEP_FLAGS.has(name)) steps.push({ kind: name as StepKind, value });
}

const outputArg = argv.find(
  (value, index) => !value.startsWith("--") && !consumed.has(index),
);
const flag = (name: string, fallback?: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
if (!outputArg) {
  console.error(
    [
      "usage: bun scripts/capture-ui.ts <output.png> [--route /] [--width 1440] [--height 900]",
      "         [--theme light|dark] [--web] [--wait 3000]",
      "  drive the page before capturing (repeatable, runs in the order written):",
      "         [--hover <selector>] [--click <selector>] [--eval <js>] [--script <file.js>]",
      "         [--step-wait 500]",
      "  keep motion alive instead of freezing it:",
      "         [--motion] [--seek <ms>]",
      "",
      "  --eval and --script run in page context inside an async wrapper, so they can",
      "  await, and `return` prints the value.",
      "  --seek pauses document.getAnimations() at <ms> and implies --motion.",
    ].join("\n"),
  );
  process.exit(2);
}

const APP = process.env.OPENSESSION_URL ?? "http://127.0.0.1:3850";
const output = resolve(outputArg);
const route = flag("route", "/")!;
const width = Number(flag("width", "1440"));
const height = Number(flag("height", "900"));
const theme = flag("theme", "light");
// A session route loads its transcript after the app shell, so 3s catches it
// mid-"Checking sign-in". Give slow routes a longer settle rather than a
// screenshot of the loading state.
const settleMs = Number(flag("wait", "3000"));
const stepWaitMs = Number(flag("step-wait", "500"));
const seekArg = flag("seek");
const seekMs = seekArg === undefined ? undefined : Number(seekArg);
if (!Number.isFinite(settleMs) || settleMs < 0)
  throw new Error("wait must be a non-negative number of milliseconds");
if (!Number.isFinite(stepWaitMs) || stepWaitMs < 0)
  throw new Error("step-wait must be a non-negative number of milliseconds");
if (seekMs !== undefined && (!Number.isFinite(seekMs) || seekMs < 0))
  throw new Error("seek must be a non-negative number of milliseconds");
if (
  !Number.isInteger(width) ||
  !Number.isInteger(height) ||
  width < 1 ||
  height < 1
)
  throw new Error("width and height must be positive integers");
if (theme !== "light" && theme !== "dark")
  throw new Error("theme must be light or dark");
const viewport = captureViewport(width, height);
const electronMaterial = !viewport.mobile && !argv.includes("--web");
// Seeking a paused animation is meaningless once the freeze stylesheet has set
// `animation: none`, so --seek turns motion back on by itself.
const liveMotion = argv.includes("--motion") || seekMs !== undefined;

const FREEZE = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; }
`;
// A caret is neither a transition nor an animation, and it blinks into the
// frame at random, so a motion capture still hides it.
const HIDE_CARET = `
  *, *::before, *::after { caret-color: transparent !important; }
`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const session = await openCdpSession();
const { send, evaluate } = session;

/**
 * Centre of the first match that actually occupies space. Several controls are
 * rendered twice (a phone bar and a desktop rail), and the copy the reader
 * cannot see is regularly first in document order.
 */
async function pointAt(selector: string) {
  const found = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const visible = nodes.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!visible) return { count: nodes.length };
    visible.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const rect = visible.getBoundingClientRect();
    return {
      count: nodes.length,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`);
  if (typeof found?.x !== "number")
    throw new Error(
      `no element with a visible box matched ${selector} (${found?.count ?? 0} matched the selector)`,
    );
  if (found.x < 0 || found.y < 0 || found.x > width || found.y > height)
    throw new Error(
      `${selector} sits outside the ${width}x${height} viewport at ${Math.round(found.x)},${Math.round(found.y)}`,
    );
  return found as { x: number; y: number };
}

// A synthetic .click() does not navigate this app, so drive the real input
// pipeline instead.
async function movePointer(selector: string) {
  const { x, y } = await pointAt(selector);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  return { x, y };
}

async function clickAt(selector: string) {
  const { x, y } = await movePointer(selector);
  const button = { button: "left", buttons: 1, clickCount: 1 };
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, ...button });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    ...button,
    buttons: 0,
  });
}

async function runSource(kind: "eval" | "script", value: string) {
  const source = kind === "script" ? readFileSync(resolve(value), "utf8") : value;
  // The wrapper lets a step await, and lets a file hold statements rather than
  // one expression. The newline keeps a trailing line comment from eating it.
  const result = await evaluate(`(async () => { ${source}\n})()`);
  if (result !== undefined) console.log(`--${kind} returned ${JSON.stringify(result)}`);
}

try {
  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  await send("Emulation.setEmulatedMedia", {
    features: [
      {
        name: "prefers-reduced-motion",
        value: liveMotion ? "no-preference" : "reduce",
      },
    ],
  });
  const token = localAutomationToken();
  if (token) {
    await send("Network.setCookie", {
      name: "opensession_auth",
      value: token,
      url: APP,
      path: "/",
    });
  }
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: captureInitScript({
      theme,
      electronMaterial,
      freezeCss: liveMotion ? HIDE_CARET : FREEZE,
    }),
  });
  await send("Emulation.setDeviceMetricsOverride", viewport);
  await send("Page.navigate", { url: new URL(route, APP).href });
  await sleep(settleMs);
  await send("Page.bringToFront");
  const probe = await send("Runtime.evaluate", {
    expression: `({
		  width: innerWidth,
		  height: innerHeight,
		  dpr: devicePixelRatio,
		  material: document.documentElement.classList.contains('material-backdrop'),
		  wco: document.documentElement.classList.contains('wco'),
		  platform: document.documentElement.dataset.platform
		})`,
    returnByValue: true,
  });
  const actual = probe?.result?.value;
  const expected: [string, unknown, unknown][] = [
    ["width", actual?.width, width],
    ["height", actual?.height, height],
    ["dpr", actual?.dpr, viewport.deviceScaleFactor],
  ];
  if (electronMaterial)
    expected.push(
      ["material", actual?.material, true],
      ["wco", actual?.wco, true],
      ["platform", actual?.platform, "mac"],
    );
  // Name the field that tripped: printing every value made a missing shell
  // class read as a viewport problem.
  const wrong = expected.filter(([, got, want]) => got !== want);
  if (wrong.length) {
    throw new Error(
      `capture emulation did not apply: ${wrong
        .map(
          ([name, got, want]) =>
            `${name} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        )
        .join("; ")} (probe ${JSON.stringify(actual)})`,
    );
  }

  for (const step of steps) {
    if (step.kind === "hover") await movePointer(step.value);
    else if (step.kind === "click") await clickAt(step.value);
    else await runSource(step.kind, step.value);
    await sleep(stepWaitMs);
  }

  if (seekMs !== undefined) {
    const count = await evaluate(`(() => {
      const animations = document.getAnimations();
      for (const animation of animations) {
        animation.pause();
        try { animation.currentTime = ${seekMs}; } catch (error) {}
      }
      return animations.length;
    })()`);
    console.log(`paused ${count} animations at ${seekMs}ms`);
    await sleep(50);
  }
  if (steps.length || seekMs !== undefined) await send("Page.bringToFront");

  let screenshot = "";
  // Waiting for two identical frames is how a still capture avoids a loading
  // state, but live motion never repeats a frame, so seek or take one shot.
  if (liveMotion && seekMs === undefined) {
    const result = await send("Page.captureScreenshot", { format: "png" });
    screenshot = result?.data ?? "";
  } else {
    let previous = "";
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const result = await send("Page.captureScreenshot", { format: "png" });
      screenshot = result?.data ?? "";
      if (screenshot && screenshot === previous) break;
      previous = screenshot;
      await sleep(600);
    }
  }
  if (!screenshot) throw new Error("Chrome returned no screenshot data");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, Buffer.from(screenshot, "base64"));
  const drove = [
    steps.length ? `${steps.length} step${steps.length > 1 ? "s" : ""}` : "",
    liveMotion ? (seekMs === undefined ? "motion live" : `motion at ${seekMs}ms`) : "",
  ].filter(Boolean);
  console.log(
    `${output}\nCSS viewport ${width}x${height}; PNG ${width * viewport.deviceScaleFactor}x${height * viewport.deviceScaleFactor}; DPR ${viewport.deviceScaleFactor}; ${electronMaterial ? "Electron material" : "web"}${drove.length ? `; ${drove.join("; ")}` : ""}`,
  );
} finally {
  await session.close();
}
