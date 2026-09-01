import { describe, expect, test } from "bun:test";
import { _withDockerLifecycleLockForTest } from "./docker";

describe("Docker sandbox lifecycle ownership", () => {
  test("serializes ensure and destroy work for one sandbox", async () => {
    let releaseEnsure!: () => void;
    const ensureGate = new Promise<void>(
      (resolve) => (releaseEnsure = resolve),
    );
    const events: string[] = [];

    const ensure = _withDockerLifecycleLockForTest("sandbox-a", async () => {
      events.push("ensure:start");
      await ensureGate;
      events.push("ensure:end");
    });
    const destroy = _withDockerLifecycleLockForTest("sandbox-a", async () => {
      events.push("destroy");
    });

    await Bun.sleep(10);
    expect(events).toEqual(["ensure:start"]);
    releaseEnsure();
    await Promise.all([ensure, destroy]);
    expect(events).toEqual(["ensure:start", "ensure:end", "destroy"]);
  });

  test("does not serialize unrelated sandboxes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let secondRan = false;

    const first = _withDockerLifecycleLockForTest("sandbox-a", () => gate);
    await _withDockerLifecycleLockForTest("sandbox-b", async () => {
      secondRan = true;
    });

    expect(secondRan).toBe(true);
    release();
    await first;
  });
});
