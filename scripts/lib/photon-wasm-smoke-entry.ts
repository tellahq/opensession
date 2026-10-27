// Entry point for the compiled-binary smoke test in photon-wasm.test.ts. It
// resizes the PNG at argv[2] through Pi's public resizeImage, the same path a
// compiled `opensession` takes for every image in a Pi turn.
import { readFileSync } from "fs";
import { resizeImage } from "@earendil-works/pi-coding-agent";

const input = new Uint8Array(readFileSync(process.argv[2]!));
const resized = await resizeImage(input, "image/png", {
  maxWidth: 2,
  maxHeight: 2,
});
console.log(
  JSON.stringify(resized && { width: resized.width, height: resized.height }),
);
