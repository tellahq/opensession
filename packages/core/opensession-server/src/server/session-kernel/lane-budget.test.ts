import { describe, expect, test } from "bun:test";
import {
  createLaneBudget,
  readIoSomeAvg10,
  scaledLaneBudgetMs,
} from "./lane-budget";

describe("lane budget", () => {
  test("reads PSI some avg10 and tolerates hosts without it", () => {
    expect(
      readIoSomeAvg10(
        () =>
          "some avg10=57.55 avg60=50.93 avg300=45.43 total=1\nfull avg10=47.35 avg60=37.67 avg300=32.88 total=2\n",
      ),
    ).toBe(57.55);
    expect(readIoSomeAvg10(() => "")).toBeNull();
  });

  test("keeps the base budget on a quiet host and stretches it under IO pressure", () => {
    expect(scaledLaneBudgetMs(5_000, null)).toBe(5_000);
    expect(scaledLaneBudgetMs(5_000, 0)).toBe(5_000);
    expect(scaledLaneBudgetMs(5_000, 25)).toBe(8_500);
    expect(scaledLaneBudgetMs(5_000, 50)).toBe(12_000);
    expect(scaledLaneBudgetMs(5_000, 90)).toBe(12_000);
    expect(scaledLaneBudgetMs(5_000, Number.NaN)).toBe(5_000);
  });

  test("never scales below the base budget", () => {
    expect(scaledLaneBudgetMs(20_000, 50, 12_000)).toBe(20_000);
    expect(scaledLaneBudgetMs(700, 50, 700)).toBe(700);
  });

  test("caches the pressure read for one second", () => {
    let clock = 0;
    let pressure = 0;
    let reads = 0;
    const budget = createLaneBudget({
      baseMs: 5_000,
      readIoPressure: () => {
        reads += 1;
        return pressure;
      },
      now: () => clock,
    });
    expect(budget()).toBe(5_000);
    pressure = 50;
    clock = 500;
    expect(budget()).toBe(5_000);
    expect(reads).toBe(1);
    clock = 1_000;
    expect(budget()).toBe(12_000);
    expect(reads).toBe(2);
  });

  test("does not read pressure when scaling is disabled", () => {
    let reads = 0;
    const budget = createLaneBudget({
      baseMs: 700,
      maxMs: 700,
      readIoPressure: () => {
        reads += 1;
        return 90;
      },
    });
    expect(budget()).toBe(700);
    expect(reads).toBe(0);
  });
});
