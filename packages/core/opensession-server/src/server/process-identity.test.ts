import { describe, expect, test } from "bun:test";
import {
  linuxProcessStartTicks,
  processIdentity,
  sameProcess,
} from "./process-identity";

describe("process identity", () => {
  test("matches the current process by boot and start ticks", () => {
    const identity = processIdentity();
    if (!identity) return;
    expect(linuxProcessStartTicks(process.pid)).toBe(identity.startTicks);
    expect(sameProcess(identity)).toBe(true);
    expect(
      sameProcess({ ...identity, startTicks: `${identity.startTicks}0` }),
    ).toBe(false);
  });
});
