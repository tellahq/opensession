import { describe, expect, test } from "bun:test";

const appSource = await Bun.file(new URL("../App.tsx", import.meta.url)).text();
const hookSource = await Bun.file(
  new URL("useSubagentTabs.ts", import.meta.url),
).text();

describe("sub-agent tab ownership", () => {
  test("delegates sub-agent tabs once from App", () => {
    expect(appSource.match(/useSubagentTabs\(\{/g)).toHaveLength(1);
    expect(appSource).toContain(
      "const subagentStack = stackFor(currentSession?.id)",
    );
    expect(appSource).toContain("subagentStack: stackFor(viewerSession.id)");
    expect(appSource).not.toContain("setSubagentTabs");
    expect(appSource).not.toContain("SUBAGENT_LINK_LABEL");
  });

  test("keeps one stable empty-stack fallback", () => {
    expect(hookSource).toContain("const NO_SUBAGENTS: SubagentRef[] = []");
    expect(hookSource).toContain("sessionId === undefined");
    expect(hookSource).toContain("subagentTabs[sessionId] ?? NO_SUBAGENTS");
  });

  test("keeps route sync in an effect event", () => {
    expect(hookSource).toContain(
      "const syncRouteSubagents = useEffectEvent(() => {",
    );
    expect(hookSource).toContain(
      "if (!routeSubagentKey) return;\n    syncRouteSubagents();\n  }, [routeSubagentKey]);",
    );
  });

  test("clears a selected sub-agent functionally when its tab closes", () => {
    expect(hookSource).toContain(
      'setActiveViewTabState((cur) => (cur === "subagent" ? null : cur))',
    );
  });

  test("exports only the hook", () => {
    expect(hookSource.match(/\bexport\s+/g)).toHaveLength(1);
    expect(hookSource).toContain("export function useSubagentTabs({");
  });
});
