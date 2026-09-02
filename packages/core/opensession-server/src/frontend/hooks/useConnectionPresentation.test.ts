import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { CONNECTION_PRESENTATION_GRACE_MS } from "../lib/connection-presentation";

type Effect = () => void | (() => void);

let effect: Effect | undefined;
let updates: unknown[] = [];

mock.module("react", () => ({
  useEffect: (nextEffect: Effect) => {
    effect = nextEffect;
  },
  useState: (initial: unknown) => [
    initial,
    (next: unknown) => updates.push(next),
  ],
}));

const { useConnectionPresentation } =
  await import("./useConnectionPresentation");
const viewerSource = await Bun.file(
  new URL("../components/SessionViewer.tsx", import.meta.url),
).text();

function installDocument(visibilityState: DocumentVisibilityState) {
  let visibility = visibilityState;
  let onVisibilityChange: (() => void) | undefined;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (name: string, listener: () => void) => {
        if (name === "visibilitychange") onVisibilityChange = listener;
      },
      removeEventListener: () => {
        onVisibilityChange = undefined;
      },
    },
  });
  return {
    show: () => {
      visibility = "visible";
      onVisibilityChange?.();
    },
    hide: () => {
      visibility = "hidden";
      onVisibilityChange?.();
    },
  };
}

afterEach(() => {
  jest.useRealTimers();
  Reflect.deleteProperty(globalThis, "document");
  effect = undefined;
  updates = [];
});

describe("connection presentation grace", () => {
  test("delays a visible connection loss for eight seconds", () => {
    jest.useFakeTimers();
    installDocument("visible");

    expect(CONNECTION_PRESENTATION_GRACE_MS).toBe(8_000);
    expect(useConnectionPresentation(false)).toBe(true);
    const cleanup = effect?.();

    jest.advanceTimersByTime(CONNECTION_PRESENTATION_GRACE_MS - 1);
    expect(updates).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(updates).toEqual([true]);
    cleanup?.();
  });

  test("does not count background time toward the grace", () => {
    jest.useFakeTimers();
    const page = installDocument("visible");

    useConnectionPresentation(false);
    const cleanup = effect?.();
    jest.advanceTimersByTime(4_000);
    page.hide();
    expect(updates).toEqual([false]);

    jest.advanceTimersByTime(CONNECTION_PRESENTATION_GRACE_MS);
    expect(updates).toEqual([false]);
    page.show();
    jest.advanceTimersByTime(CONNECTION_PRESENTATION_GRACE_MS);
    expect(updates).toEqual([false, true]);
    cleanup?.();
  });

  test("applies the delayed state only to session presentation", () => {
    expect(viewerSource).toContain(
      "const presentedConnected = useConnectionPresentation(connected)",
    );
    expect(viewerSource).toContain("connected: presentedConnected");
  });
});
