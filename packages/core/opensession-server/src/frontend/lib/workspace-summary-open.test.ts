import { describe, expect, test } from "bun:test";
import {
  WS_SUMMARY_MAX_SHIFT,
  WS_SUMMARY_OPEN_EVENT,
  WS_SUMMARY_OPEN_KEY,
  WS_SUMMARY_ROOM_W,
  openWorkspaceSummary,
  workspaceSummaryCanStand,
  workspaceSummaryOpen,
  workspaceSummaryShift,
  workspaceSummaryShouldDismissAfterRouting,
  workspaceSummarySideOffset,
} from "./workspace-summary-open";

/**
 * Opening the card deliberately composes the transcript and card side by side:
 * every pane that can show the card gets the same visible left step, while a
 * pane too narrow to show it stays still.
 */
describe("workspaceSummaryShift", () => {
  test("moves the transcript and composer by the full step when the card fits", () => {
    expect(workspaceSummaryShift(WS_SUMMARY_ROOM_W)).toBe(WS_SUMMARY_MAX_SHIFT);
  });

  test("keeps the visible step on wider panes", () => {
    expect(workspaceSummaryShift(WS_SUMMARY_ROOM_W + 320)).toBe(
      WS_SUMMARY_MAX_SHIFT,
    );
    expect(workspaceSummaryShift(2400)).toBe(WS_SUMMARY_MAX_SHIFT);
  });

  test("does not move a pane too narrow to show the card", () => {
    expect(workspaceSummaryShift(WS_SUMMARY_ROOM_W - 1)).toBe(0);
    expect(workspaceSummaryShift(0)).toBe(0);
  });
});

describe("workspace summary preference", () => {
  test("defaults open until the person explicitly closes it", () => {
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    const stored = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
    try {
      expect(workspaceSummaryOpen()).toBe(true);
      stored.set(WS_SUMMARY_OPEN_KEY, "true");
      expect(workspaceSummaryOpen()).toBe(true);
      stored.set(WS_SUMMARY_OPEN_KEY, "false");
      expect(workspaceSummaryOpen()).toBe(false);
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("can be reopened when another surface yields room", () => {
    const previousStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    const previousWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    const stored = new Map([[WS_SUMMARY_OPEN_KEY, "false"]]);
    const events: string[] = [];
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        dispatchEvent: (event: Event) => {
          events.push(event.type);
          return true;
        },
      },
    });
    try {
      openWorkspaceSummary();
      expect(workspaceSummaryOpen()).toBe(true);
      expect(events).toEqual([WS_SUMMARY_OPEN_EVENT]);
    } finally {
      if (previousStorage)
        Object.defineProperty(globalThis, "localStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
      if (previousWindow)
        Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

describe("workspace summary in Review", () => {
  test("stands wherever there is room, Review included", () => {
    expect(workspaceSummaryCanStand(true)).toBe(true);
    expect(workspaceSummaryCanStand(false)).toBe(false);
  });

  test("keeps a standing card open when a row routes to Review", () => {
    expect(workspaceSummaryShouldDismissAfterRouting(true)).toBe(false);
    expect(workspaceSummaryShouldDismissAfterRouting(false)).toBe(true);
  });

  test("places every summary below the workspace tabs", () => {
    expect(workspaceSummarySideOffset(true)).toBe(49);
    expect(workspaceSummarySideOffset(false)).toBe(20);
  });
});
