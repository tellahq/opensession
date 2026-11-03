import { describe, expect, test } from "bun:test";
import {
  linuxProcessStartTicks,
  processIdentity,
  sameProcess,
} from "./process-identity";

describe("process identity", () => {
  test("matches the current process by boot and start ticks", async () => {
    const identity = await processIdentity();
    if (!identity) return;
    expect(await linuxProcessStartTicks(process.pid)).toBe(identity.startTicks);
    expect(await sameProcess(identity)).toBe(true);
    expect(
      await sameProcess({ ...identity, startTicks: `${identity.startTicks}0` }),
    ).toBe(false);
  });
});
