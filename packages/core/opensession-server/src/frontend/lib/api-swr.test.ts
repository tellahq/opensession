import { describe, expect, test } from "bun:test";
import { apiSWRKey, sessionApiKeyFilter } from "./api-swr";

describe("sessionApiKeyFilter", () => {
  const matches = sessionApiKeyFilter("os-new");

  test("selects every resource keyed by that session", () => {
    expect(matches(apiSWRKey.session("os-new"))).toBe(true);
    expect(matches(apiSWRKey.sessionPr("os-new", "opensession", "main"))).toBe(
      true,
    );
    expect(matches(apiSWRKey.sessionGit("os-new"))).toBe(true);
    expect(matches(apiSWRKey.sessionDiff("os-new"))).toBe(true);
    expect(matches(apiSWRKey.sessionAssets("os-new"))).toBe(true);
    expect(matches(apiSWRKey.workspaceOverview("sessions:os-new"))).toBe(true);
  });

  test("leaves other sessions, workspaces, and previews alone", () => {
    expect(matches(apiSWRKey.session("os-other"))).toBe(false);
    expect(matches(apiSWRKey.sessionPr("os-other", "opensession"))).toBe(false);
    expect(matches(apiSWRKey.workspaceOverview("ws-1"))).toBe(false);
    expect(matches(apiSWRKey.previewPr("opensession", "os-new"))).toBe(false);
    expect(matches("api/session/os-new")).toBe(false);
    expect(matches(null)).toBe(false);
  });
});
