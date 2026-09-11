#!/usr/bin/env bun
/** UI verification fixture only. No Xcode, idb, device or app is started.
 * Run through start_portal so the real viewer transport stays authenticated. */
import sharp from "sharp";
import { buildSimulatorViewer } from "../packages/core/opensession-server/src/simulator-portal/assets";
import { startSimulatorViewer } from "../packages/core/opensession-server/src/simulator-portal/server";
import type { SimulatorInput } from "../packages/core/opensession-server/src/simulator-portal/idb";

const port = Number(process.env.PORT);
const origin = process.env.PORTAL_URL;
if (!Number.isInteger(port) || port < 1024 || !origin)
  throw new Error("Start this fixture through an Open Session Portal");
const assets = await buildSimulatorViewer();
const inputs: SimulatorInput[] = [];
let emit: ((frame: Uint8Array) => void) | undefined;
async function frame() {
  const image = `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844"><rect width="390" height="844" fill="white"/><g fill="black" font-family="sans-serif" text-anchor="middle"><text x="195" y="190" font-size="25">Simulator viewer test</text><text x="195" y="230" font-size="16">No iOS runtime is running</text><rect x="55" y="310" width="280" height="100" rx="20" fill="lightgray"/><text x="195" y="355" font-size="20">Tap or swipe here</text><text x="195" y="390" font-size="18">Inputs received: ${inputs.length}</text><text x="195" y="520" font-size="16">Keyboard and Home work too</text></g></svg>`;
  return new Uint8Array(await sharp(Buffer.from(image)).jpeg().toBuffer());
}
function record() {
  assets.set(
    "/test-inputs.json",
    new Blob([JSON.stringify(inputs)], { type: "application/json" }),
  );
}
record();
const viewer = startSimulatorViewer({
  port,
  origin,
  assets,
  openSimulator: async () => {
    if (process.argv.includes("--failure"))
      throw new Error("Test fixture: Xcode or idb is not installed");
    return {
      udid: "test-fixture",
      deviceName: "Test fixture",
      dimensions: { width: 390, height: 844 },
      density: 1,
      async startVideo(onFrame) {
        emit = onFrame;
        onFrame(await frame());
        return async () => {
          emit = undefined;
        };
      },
      async input(command) {
        inputs.push(command);
        record();
        emit?.(await frame());
      },
      async close() {},
    };
  },
});
const stop = () => {
  void viewer.stop().then(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
console.log("Simulator viewer test fixture, no iOS runtime is running");
