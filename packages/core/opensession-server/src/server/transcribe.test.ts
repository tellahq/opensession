import { describe, expect, test } from "bun:test";
import { inLocalLane, LOCAL_LANES, LOCAL_QUEUE } from "./transcribe";

describe("local transcription lanes", () => {
  test("runs a bounded number at once, queues a few, and refuses the rest", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const task = () =>
      new Promise<string>((resolve) => {
        active++;
        peak = Math.max(peak, active);
        releases.push(() => {
          active--;
          resolve("ok");
        });
      });
    const accepted = Array.from({ length: LOCAL_LANES + LOCAL_QUEUE }, () =>
      inLocalLane(task),
    );
    await expect(inLocalLane(task)).rejects.toThrow("busy");
    // Let every run finish, one lane at a time.
    while (releases.length || active) {
      await Bun.sleep(0);
      releases.shift()?.();
    }
    expect(await Promise.all(accepted)).toEqual(
      Array(LOCAL_LANES + LOCAL_QUEUE).fill("ok"),
    );
    expect(peak).toBe(LOCAL_LANES);
    // A lane frees up again once the backlog is gone.
    const after = inLocalLane(task);
    await Bun.sleep(0);
    releases.shift()?.();
    expect(await after).toBe("ok");
  });
});
