import { beforeEach, expect, test } from "bun:test";
import {
  KEPT_FRAME_LIMIT,
  audibleFrameScopes,
  keptFrameAudible,
  viewTabScope,
  dropKeptFrame,
  getKeptFrame,
  getKeptFrames,
  hideKeptFrame,
  keptFrameLoaded,
  keptFrameNavigated,
  keptFrameStepped,
  loadKeptFrame,
  resetKeptFrames,
  showKeptFrame,
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
  keptFrameLoaded("staging:a", 1);
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

test("navigation inside a frame enables Back until a reload", () => {
  showKeptFrame("portal:a", spec("https://a.example.test/"), slot());
  keptFrameLoaded("portal:a", 2);
  keptFrameLoaded("portal:a", 3);
  keptFrameStepped("portal:a", -1, 3);
  const { back, forward } = getKeptFrame("portal:a")!.history;
  expect([back, forward]).toEqual([0, 1]);
  loadKeptFrame("portal:a", "https://a.example.test/");
  keptFrameLoaded("portal:a", 3);
  expect(getKeptFrame("portal:a")!.history.forward).toBe(0);
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

test("a reported location shows until the frame loads something else", () => {
  showKeptFrame("staging:a", spec("https://a.example.test/"), slot());
  keptFrameNavigated("staging:a", "https://a.example.test/settings");
  expect(getKeptFrame("staging:a")!.location).toBe(
    "https://a.example.test/settings",
  );
  loadKeptFrame("staging:a", "https://a.example.test/settings");
  expect(getKeptFrame("staging:a")!.location).toBeNull();
});

test("audible pages name their scope until they reload", () => {
  showKeptFrame("staging:ws-a", spec("https://a.example.test/"), slot());
  showKeptFrame("portal:ws-b", spec("https://b.example.test/"), slot());
  expect(audibleFrameScopes()).toBe("");
  keptFrameAudible("staging:ws-a", true);
  keptFrameAudible("portal:ws-b", true);
  expect(audibleFrameScopes()).toBe("ws-a\nws-b");
  loadKeptFrame("staging:ws-a", "https://a.example.test/next");
  expect(audibleFrameScopes()).toBe("ws-b");
  keptFrameAudible("portal:ws-b", false);
  expect(audibleFrameScopes()).toBe("");
});

test("a session's view tabs live under its workspace, worktree, or itself", () => {
  expect(viewTabScope({ id: "s1", workspaceId: "w1" })).toBe("w1");
  expect(viewTabScope({ id: "s1", worktreeDir: "/home/x/worktrees/b" })).toBe(
    "/home/x/worktrees/b",
  );
  expect(viewTabScope({ id: "s1", worktreeDir: "/home/x/repo" })).toBe("s1");
});
