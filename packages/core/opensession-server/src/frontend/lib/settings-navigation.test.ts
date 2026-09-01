import { describe, expect, test } from "bun:test";
import {
  settingsReturnForNavigation,
  type SettingsReturn,
} from "./settings-navigation";

const origin: SettingsReturn = {
  path: "/workspace/ws-1/session/session-1",
  depth: 2,
  steps: 1,
};

describe("settingsReturnForNavigation", () => {
  test("remembers the page that opened Settings", () => {
    expect(
      settingsReturnForNavigation({
        currentIsSettings: false,
        nextIsSettings: true,
        currentPath: origin.path,
        currentDepth: origin.depth,
        replace: false,
      }),
    ).toEqual(origin);
  });

  test("counts section entries while preserving the opening page", () => {
    expect(
      settingsReturnForNavigation({
        currentIsSettings: true,
        nextIsSettings: true,
        currentReturn: origin,
        currentPath: "/settings",
        currentDepth: 3,
        replace: false,
      }),
    ).toEqual({ ...origin, steps: 2 });
  });

  test("keeps the same return point when replacing a Settings entry", () => {
    expect(
      settingsReturnForNavigation({
        currentIsSettings: true,
        nextIsSettings: true,
        currentReturn: origin,
        currentPath: "/settings",
        currentDepth: 3,
        replace: true,
      }),
    ).toBe(origin);
  });

  test("does not attach a Settings return point to ordinary navigation", () => {
    expect(
      settingsReturnForNavigation({
        currentIsSettings: true,
        nextIsSettings: false,
        currentReturn: origin,
        currentPath: "/settings/preferences",
        currentDepth: 3,
        replace: false,
      }),
    ).toBeUndefined();
  });
});
