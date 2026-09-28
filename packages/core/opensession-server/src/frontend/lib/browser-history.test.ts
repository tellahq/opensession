import { expect, test } from "bun:test";
import {
  canStep,
  currentAddress,
  startHistory,
  stepHistory,
  visitAddress,
} from "./browser-history";

const a = "https://a.example.test/";
const b = "https://a.example.test/b";
const c = "https://a.example.test/c";

test("back and forward move through visited addresses", () => {
  let history = visitAddress(visitAddress(startHistory(a), b), c);
  expect(canStep(history, 1)).toBe(false);
  history = stepHistory(stepHistory(history, -1), -1);
  expect(currentAddress(history)).toBe(a);
  expect(canStep(history, -1)).toBe(false);
  expect(stepHistory(history, -1)).toBe(history);
  history = stepHistory(history, 1);
  expect(currentAddress(history)).toBe(b);
});

test("visiting after going back drops the forward entries", () => {
  const history = visitAddress(
    stepHistory(visitAddress(visitAddress(startHistory(a), b), c), -1),
    a,
  );
  expect(history.entries).toEqual([a, b, a]);
  expect(canStep(history, 1)).toBe(false);
});

test("reloading the shown address adds no entry", () => {
  const history = visitAddress(startHistory(a), b);
  expect(visitAddress(history, b)).toBe(history);
});
