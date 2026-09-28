import { beforeEach, expect, test } from "bun:test";
import {
  KEPT_FRAME_LIMIT,
  dropKeptFrame,
  getKeptFrame,
  getKeptFrames,
  hideKeptFrame,
  keptFrameLoaded,
  loadKeptFrame,
  resetKeptFrames,
  showKeptFrame,
  stepKeptFrame,
} from "./kept-frames";

// SAFETY: the store only compares slots by identity; it never reads them.
const slot = () => ({}) as HTMLElement;
const spec = (url: string) => ({ url, name: "Preview", title: "Preview" });
const keys = () => getKeptFrames().map((frame) => frame.key);

beforeEach(resetKeptFrames);

test("a hidden frame keeps what it navigated to", () => {
  const first = slot();
  showKeptFrame("staging:a", spec("https://a.example.test/"), first);
  loadKeptFrame("staging:a", "https://a.example.test/deep");
  keptFrameLoaded("staging:a");
  hideKeptFrame("staging:a", first);

  showKeptFrame("staging:a", spec("https://a.example.test/"), slot());
  const frame = getKeptFrame("staging:a")!;
  expect(frame.address).toBe("https://a.example.test/deep");
  expect(frame.loading).toBe(false);
  expect(frame.nonce).toBe(1);
});

test("a pane asking for a new URL starts the frame over", () => {
  const el = slot();
  showKeptFrame("portal:a", spec("https://one.example.test/"), el);
  loadKeptFrame("portal:a", "https://one.example.test/deep");
  showKeptFrame("portal:a", spec("https://two.example.test/"), el);
  expect(getKeptFrame("portal:a")!.address).toBe("https://two.example.test/");
  expect(getKeptFrame("portal:a")!.loading).toBe(true);
});

test("back and forward step through loaded addresses", () => {
  showKeptFrame("staging:a", spec("https://a.example.test/"), slot());
  loadKeptFrame("staging:a", "https://a.example.test/deep");
  stepKeptFrame("staging:a", -1);
  expect(getKeptFrame("staging:a")!.address).toBe("https://a.example.test/");
  stepKeptFrame("staging:a", 1);
  const frame = getKeptFrame("staging:a")!;
  expect(frame.address).toBe("https://a.example.test/deep");
  expect(frame.nonce).toBe(3);
  stepKeptFrame("staging:a", 1);
  expect(getKeptFrame("staging:a")).toBe(frame);
});

test("a new pane URL clears back and forward", () => {
  const el = slot();
  showKeptFrame("portal:a", spec("https://one.example.test/"), el);
  loadKeptFrame("portal:a", "https://one.example.test/deep");
  showKeptFrame("portal:a", spec("https://two.example.test/"), el);
  expect(getKeptFrame("portal:a")!.history.entries).toEqual([
    "https://two.example.test/",
  ]);
});

test(`keeps the ${KEPT_FRAME_LIMIT} most recently shown frames`, () => {
  const slots = ["a", "b", "c", "d"].map(() => slot());
  ["a", "b", "c"].forEach((id, i) => {
    showKeptFrame(id, spec(`https://${id}.example.test/`), slots[i]!);
    hideKeptFrame(id, slots[i]!);
  });
  // Coming back to "a" makes "b" the oldest.
  showKeptFrame("a", spec("https://a.example.test/"), slots[0]!);
  hideKeptFrame("a", slots[0]!);
  showKeptFrame("d", spec("https://d.example.test/"), slots[3]!);
  // Creation order is kept: the layer must never reorder its iframes.
  expect(keys()).toEqual(["a", "c", "d"]);
});

test("never evicts a frame that is on screen", () => {
  const slots = ["a", "b", "c", "d"].map(() => slot());
  ["a", "b", "c", "d"].forEach((id, i) =>
    showKeptFrame(id, spec(`https://${id}.example.test/`), slots[i]!),
  );
  expect(keys()).toEqual(["a", "b", "c", "d"]);
  hideKeptFrame("b", slots[1]!);
  expect(keys()).toEqual(["a", "c", "d"]);
});

test("a stale slot's cleanup does not hide the frame's new slot", () => {
  const old = slot();
  const next = slot();
  showKeptFrame("a", spec("https://a.example.test/"), old);
  showKeptFrame("a", spec("https://a.example.test/"), next);
  hideKeptFrame("a", old);
  expect(getKeptFrame("a")!.slot).toBe(next);
});

test("closing the tab unloads its page", () => {
  showKeptFrame("staging:a", spec("https://a.example.test/"), slot());
  dropKeptFrame("staging:a");
  expect(getKeptFrame("staging:a")).toBeUndefined();
});
