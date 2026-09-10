import { expect, test } from "bun:test";
import { simulatorGesture, simulatorPointer } from "./simulator-viewer";

test("pointer mapping ignores letterbox space at desktop and phone widths", () => {
  const rect = { left: 100, top: 50, width: 600, height: 800 };
  expect(
    simulatorPointer({
      rect,
      width: 400,
      height: 800,
      clientX: 100,
      clientY: 450,
    }),
  ).toBeNull();
  expect(
    simulatorPointer({
      rect,
      width: 400,
      height: 800,
      clientX: 400,
      clientY: 450,
    }),
  ).toEqual({ x: 0.5, y: 0.5 });
  expect(
    simulatorPointer({
      rect: { left: 0, top: 0, width: 300, height: 800 },
      width: 400,
      height: 800,
      clientX: 150,
      clientY: 100,
    }),
  ).toEqual({ x: 0.5, y: 0 });
});

test("short movement taps, larger movement swipes with a bounded duration", () => {
  const start = { x: 0.5, y: 0.5, time: 0 };
  expect(simulatorGesture(start, { x: 0.501, y: 0.5 }, 100)).toEqual({
    type: "tap",
    x: 0.501,
    y: 0.5,
  });
  expect(simulatorGesture(start, { x: 0.1, y: 0.8 }, 10_000)).toEqual({
    type: "swipe",
    x: 0.5,
    y: 0.5,
    endX: 0.1,
    endY: 0.8,
    duration: 2,
  });
});
