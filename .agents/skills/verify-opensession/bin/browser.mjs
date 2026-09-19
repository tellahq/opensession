#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const argv = process.argv.slice(2);
const runDir = argv.shift();
const command = argv.shift();
if (!runDir || !command) {
  fail(
    "usage: browser.mjs <run-dir> <open|click|fill|press|wait|snapshot|screenshot|url|eval> [flags]",
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function requiredFlag(name) {
  const value = flag(name);
  if (value === undefined) fail(`--${name} is required`);
  return value;
}

function readMetadata() {
  const rows = readFileSync(`${runDir}/run.env`, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("=", 2));
  return Object.fromEntries(rows);
}

const metadata = readMetadata();
const cdpPort = Number(metadata.CDP_PORT);
const appUrl = metadata.APP_URL;
if (!Number.isInteger(cdpPort) || !appUrl) fail("run metadata is incomplete");

async function targetForApp(create) {
  const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(
    (response) => response.json(),
  );
  const appTarget = targets.find(
    (target) => target.type === "page" && target.url.startsWith(appUrl),
  );
  if (appTarget) return appTarget;
  const blank = targets.find(
    (target) => target.type === "page" && target.url === "about:blank",
  );
  if (blank) return blank;
  if (!create)
    fail(`no browser page belongs to ${appUrl}; run browser open first`);
  return fetch(`http://127.0.0.1:${cdpPort}/json/new?url=about:blank`, {
    method: "PUT",
  }).then((response) => response.json());
}

const target = await targetForApp(command === "open");
if (!target.webSocketDebuggerUrl) fail("CDP target has no debugger URL");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
  socket.addEventListener("open", resolveOpen, { once: true });
  socket.addEventListener(
    "error",
    () => rejectOpen(new Error("CDP connection failed")),
    { once: true },
  );
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  if (message.error)
    entry.reject(
      new Error(`CDP ${entry.method} failed: ${message.error.message}`),
    );
  else entry.resolve(message.result);
});
socket.addEventListener("close", () => {
  for (const entry of pending.values())
    entry.reject(new Error(`CDP closed before ${entry.method} replied`));
  pending.clear();
});
function send(method, params = {}) {
  return new Promise((resolveSend, rejectSend) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveSend, reject: rejectSend, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await Promise.all([
  send("Page.enable"),
  send("Runtime.enable"),
  send("DOM.enable"),
  send("Accessibility.enable"),
]);

/**
 * Chrome drops parts of the emulation state when a CDP client disconnects,
 * and every helper command is its own connection. The viewport chosen at
 * `open` is recorded in the run directory and re-applied on each command so
 * a screenshot or media query later in the run still sees the same device.
 */
const viewportFile = `${runDir}/viewport.json`;

function readViewport() {
  try {
    return JSON.parse(readFileSync(viewportFile, "utf8"));
  } catch {
    return null;
  }
}

async function applyViewport({ width, height }) {
  const phone = width <= 720;
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: phone ? 3 : 2,
    mobile: phone,
  });
  // A phone is touch-first: the UI reads `(hover: none) and (pointer:
  // coarse)` to swap hover-only affordances for inline ones, so the emulated
  // page must report what a real phone does.
  await send("Emulation.setTouchEmulationEnabled", {
    enabled: phone,
    maxTouchPoints: phone ? 5 : 1,
  });
  await send("Emulation.setEmulatedMedia", {
    features: phone
      ? [
          { name: "hover", value: "none" },
          { name: "pointer", value: "coarse" },
        ]
      : [
          { name: "hover", value: "hover" },
          { name: "pointer", value: "fine" },
        ],
  });
}

const role = flag("role");
const name = flag("name");
const timeout = Number(flag("timeout", "10000"));
const index = Number(flag("index", "0"));
if (!Number.isInteger(index) || index < 0)
  fail("--index must be a non-negative integer");

function axValue(property) {
  return typeof property?.value === "string"
    ? property.value
    : String(property?.value ?? "");
}

async function axNodes() {
  const result = await send("Accessibility.getFullAXTree");
  return Array.isArray(result.nodes) ? result.nodes : [];
}

async function matchingNode() {
  if (!role || name === undefined) fail("--role and --name are required");
  const deadline = Date.now() + timeout;
  let matches = [];
  while (Date.now() <= deadline) {
    matches = (await axNodes()).filter(
      (node) =>
        axValue(node.role) === role &&
        axValue(node.name) === name &&
        node.backendDOMNodeId,
    );
    if (matches[index]) return matches[index];
    await Bun.sleep(100);
  }
  const nearby = (await axNodes())
    .filter((node) => axValue(node.role) === role)
    .map((node) => axValue(node.name))
    .filter(Boolean)
    .slice(0, 30);
  fail(
    `no ${role} named ${JSON.stringify(name)} at index ${index}; visible ${role} names: ${JSON.stringify(nearby)}`,
  );
}

/**
 * Mouse input travels in viewport coordinates, so a target parked below the
 * fold of the page or of a scrollable dialog has to be brought into view
 * first. Without this the press lands wherever those coordinates happen to
 * fall — usually on a backdrop, which dismisses the dialog and looks like a
 * click that did nothing.
 */
async function scrollIntoView(node) {
  await send("DOM.scrollIntoViewIfNeeded", {
    backendNodeId: node.backendDOMNodeId,
  });
}

async function nodeCenter(node) {
  await scrollIntoView(node);
  const model = await send("DOM.getBoxModel", {
    backendNodeId: node.backendDOMNodeId,
  });
  const quad = model?.model?.border;
  if (!Array.isArray(quad) || quad.length < 8)
    fail("target has no clickable box");
  const center = {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
  // Still outside the viewport after scrolling: report it instead of
  // dispatching a press at coordinates no element occupies.
  const { cssLayoutViewport: viewportBox } = await send(
    "Page.getLayoutMetrics",
  );
  if (
    viewportBox &&
    (center.x < 0 ||
      center.y < 0 ||
      center.x > viewportBox.clientWidth ||
      center.y > viewportBox.clientHeight)
  )
    fail(
      `target sits outside the ${viewportBox.clientWidth}x${viewportBox.clientHeight} viewport at ${Math.round(center.x)},${Math.round(center.y)} even after scrolling`,
    );
  return center;
}

/** Move the mouse over the node without pressing: opens hover-only UI such
 * as tooltips. */
async function hoverNode(node) {
  const { x, y } = await nodeCenter(node);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

async function clickNode(node) {
  const { x, y } = await nodeCenter(node);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function resolveNode(node) {
  const result = await send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId,
  });
  if (!result?.object?.objectId) fail("could not resolve target DOM node");
  return result.object.objectId;
}

async function waitForReady() {
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    const result = await send("Runtime.evaluate", {
      expression: "document.readyState === 'complete'",
      returnByValue: true,
    });
    if (result?.result?.value === true) return;
    await Bun.sleep(100);
  }
  fail("page did not finish loading");
}

try {
  if (command !== "open") {
    const viewport = readViewport();
    if (viewport) await applyViewport(viewport);
  }
  switch (command) {
    case "open": {
      const route = flag("route", "/");
      const width = Number(flag("width", "1440"));
      const height = Number(flag("height", "900"));
      const viewport = { width, height };
      writeFileSync(viewportFile, JSON.stringify(viewport));
      await applyViewport(viewport);
      await send("Page.navigate", { url: new URL(route, appUrl).href });
      await waitForReady();
      console.log(new URL(route, appUrl).href);
      break;
    }
    case "click": {
      const node = await matchingNode();
      await clickNode(node);
      console.log(`clicked ${role} ${JSON.stringify(name)}`);
      break;
    }
    case "hover": {
      const node = await matchingNode();
      await hoverNode(node);
      console.log(`hovering ${role} ${JSON.stringify(name)}`);
      break;
    }
    case "fill": {
      const value = requiredFlag("value");
      const node = await matchingNode();
      const objectId = await resolveNode(node);
      await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function () { this.focus(); if (typeof this.select === 'function') this.select(); }",
      });
      if (value) {
        await send("Input.insertText", { text: value });
      } else {
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
      }
      console.log(`filled ${role} ${JSON.stringify(name)}`);
      break;
    }
    case "press": {
      // "Control+i", "Meta+Shift+g": modifiers are named before the key, and
      // travel as CDP's modifier bitmask so the page sees a real chord.
      const spelled = requiredFlag("key");
      const parts = spelled.split("+");
      const key = parts.pop();
      const modifierBits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
      let modifiers = 0;
      for (const part of parts) {
        const bit = modifierBits[part];
        if (!bit) throw new Error(`unknown modifier ${JSON.stringify(part)}`);
        modifiers |= bit;
      }
      const codes = {
        Enter: ["Enter", "Enter", 13],
        Escape: ["Escape", "Escape", 27],
        Tab: ["Tab", "Tab", 9],
        ArrowDown: ["ArrowDown", "ArrowDown", 40],
        ArrowUp: ["ArrowUp", "ArrowUp", 38],
        "/": ["/", "Slash", 191],
      };
      const [keyName, code, windowsVirtualKeyCode] = codes[key] ?? [
        key,
        key,
        0,
      ];
      // A chord never inserts text; a bare character does.
      const text = key.length === 1 && modifiers === 0 ? key : undefined;
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: keyName,
        code,
        windowsVirtualKeyCode,
        modifiers,
        ...(text ? { text } : {}),
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: keyName,
        code,
        windowsVirtualKeyCode,
        modifiers,
      });
      console.log(`pressed ${spelled}`);
      break;
    }
    case "wait": {
      await matchingNode();
      console.log(`found ${role} ${JSON.stringify(name)}`);
      break;
    }
    case "snapshot": {
      const nodes = await axNodes();
      const lines = nodes
        .filter((node) => !node.ignored)
        .map((node) => {
          const nodeRole = axValue(node.role);
          const nodeName = axValue(node.name);
          const details = (node.properties ?? [])
            .filter((property) =>
              [
                "checked",
                "disabled",
                "expanded",
                "focused",
                "level",
                "pressed",
                "selected",
                "value",
              ].includes(property.name),
            )
            .map(
              (property) =>
                `${property.name}=${JSON.stringify(property.value?.value)}`,
            );
          return `${nodeRole}${nodeName ? ` ${JSON.stringify(nodeName)}` : ""}${details.length ? ` [${details.join(", ")}]` : ""}`;
        });
      const output = `${lines.join("\n")}\n`;
      const path = flag("path");
      if (path) {
        const absolute = resolve(path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, output);
        console.log(absolute);
      } else process.stdout.write(output);
      break;
    }
    case "screenshot": {
      const path = resolve(requiredFlag("path"));
      const deadline = Date.now() + 10_000;
      let previous = "";
      let data = "";
      while (Date.now() < deadline) {
        const result = await send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        data = result.data;
        if (data && data === previous) break;
        previous = data;
        await Bun.sleep(300);
      }
      if (!data) fail("Chrome returned no screenshot data");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(data, "base64"));
      console.log(path);
      break;
    }
    case "url": {
      const result = await send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      console.log(result?.result?.value ?? "");
      break;
    }
    case "eval": {
      const expression = requiredFlag("expression");
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result?.exceptionDetails)
        fail(result.exceptionDetails.text || "evaluation failed");
      console.log(JSON.stringify(result?.result?.value, null, 2));
      break;
    }
    default:
      fail(`unknown browser command: ${command}`);
  }
} finally {
  socket.close();
}
