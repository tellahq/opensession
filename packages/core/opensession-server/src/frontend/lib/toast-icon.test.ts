import { describe, expect, test } from "bun:test";
import { toastIconName } from "./toast-icon";

describe("toastIconName", () => {
  test.each([
    ["Archived", "archive"],
    ["Archived 3 sessions", "archive"],
    ["Memory restored", "restore"],
    ["Pairing command copied", "copy"],
    ["Provider removed", "trash"],
    ["Usage tracking connected", "plug"],
    ["Linked into a stack", "link"],
    ["Moved to main", "branches"],
    ["Repository registered", "plus"],
    ["Server restarted", "server"],
    ["Snapshot build started", "play"],
    ["Message sent", "send"],
  ] as const)("maps %s to %s", (message, icon) => {
    expect(toastIconName(message, "success")).toBe(icon);
  });

  test("keeps errors unmistakable", () => {
    expect(toastIconName("Could not connect", "error")).toBe("error");
  });

  test("uses a check for other success receipts", () => {
    expect(toastIconName("Settings saved", "success")).toBe("check");
    expect(toastIconName("Still working", "default")).toBeNull();
  });
});
