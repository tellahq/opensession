import { describe, expect, test } from "bun:test";
import { installUnhandledRejectionGuard } from "./process-guards";

describe("installUnhandledRejectionGuard", () => {
  test("installs once and logs the rejection instead of exiting", () => {
    const logged: Array<[string, unknown]> = [];
    const log = (message: string, reason: unknown) => {
      logged.push([message, reason]);
    };
    expect(installUnhandledRejectionGuard(log)).toBe(true);
    expect(installUnhandledRejectionGuard(log)).toBe(false);

    const reason = new Error(
      "Session kernel actor timed out handling delivery snapshot",
    );
    process.emit("unhandledRejection", reason, Promise.resolve());

    expect(logged).toEqual([
      ["[process] unhandled promise rejection (kept running):", reason],
    ]);
  });
});
