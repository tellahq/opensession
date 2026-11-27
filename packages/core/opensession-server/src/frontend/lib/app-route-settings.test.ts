import { expect, test } from "bun:test";
import { settingsRoute, settingsSectionOf } from "./app-route";

test("a tool that lives in Settings is linked by its own route", () => {
  expect(settingsRoute("automations")).toEqual({ view: "automations" });
  expect(settingsRoute("goals")).toEqual({ view: "goals" });
  expect(settingsRoute("security")).toEqual({ view: "security" });
});

test("a plain section, or none, is a settings route", () => {
  expect(settingsRoute("repos")).toEqual({
    view: "settings",
    section: "repos",
  });
  expect(settingsRoute()).toEqual({ view: "settings", section: undefined });
});

test("the section a route shows includes the tools", () => {
  expect(settingsSectionOf({ view: "goals" })).toBe("goals");
  expect(settingsSectionOf({ view: "settings", section: "memory" })).toBe(
    "memory",
  );
  expect(settingsSectionOf({ view: "feed" })).toBeUndefined();
});
