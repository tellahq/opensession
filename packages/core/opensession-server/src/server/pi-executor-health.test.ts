import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  detectExecutorHealthWarning,
  piExecutorHealthTools,
  type ExecutorHealthWarning,
} from "./pi-executor-health";

describe("detectExecutorHealthWarning", () => {
  test("detects OOM / exit 137 and disk-full ENOSPC signals", () => {
    const oom = detectExecutorHealthWarning(
      "Command exited with status 137 (Killed)",
    );
    expect(oom?.kind).toBe("oom");

    const heap = detectExecutorHealthWarning(
      "FATAL ERROR: Reached heap limit Allocation failed",
    );
    expect(heap?.kind).toBe("oom");

    const disk = detectExecutorHealthWarning(
      "write failed: ENOSPC: no space left on device",
    );
    expect(disk?.kind).toBe("disk-full");

    const ok = detectExecutorHealthWarning("All 42 tests passed", {
      exitCode: 0,
    });
    expect(ok).toBeNull();
  });

  test("detects critical host memory pressure on failing tools", () => {
    const lowMem = detectExecutorHealthWarning("build failed", {
      failed: true,
      freeMemRatio: 0.02,
    });
    expect(lowMem?.kind).toBe("memory-pressure");
    expect(lowMem?.summary).toContain("2% free");

    const healthy = detectExecutorHealthWarning("build failed", {
      failed: true,
      freeMemRatio: 0.4,
    });
    expect(healthy).toBeNull();
  });
});

describe("piExecutorHealthTools", () => {
  test("annotates failing OOM commands and deduplicates transcript warnings per kind", async () => {
    const seen: ExecutorHealthWarning[] = [];
    const bashTool: ToolDefinition<any, any, any> = {
      name: "bash",
      label: "bash",
      description: "bash",
      parameters: {} as any,
      execute: async () => {
        throw new Error("Command exited with code 137");
      },
    };
    const [wrapped] = piExecutorHealthTools([bashTool], {
      onWarning: (w) => seen.push(w),
      freeMemRatio: () => 0.5,
    });

    await expect(
      wrapped!.execute(
        "c1",
        { command: "bun test" },
        undefined,
        undefined,
        {} as any,
      ),
    ).rejects.toThrow('<executor_health kind="oom">');
    await expect(
      wrapped!.execute(
        "c2",
        { command: "bun test" },
        undefined,
        undefined,
        {} as any,
      ),
    ).rejects.toThrow('<executor_health kind="oom">');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe("oom");
  });
});
