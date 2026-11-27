import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  extractServersFromPatterns,
  isSkillFilePath,
  matchToolPattern,
  parseSkillUnlockFrontmatter,
  piSkillUnlockTools,
} from "./pi-skill-tools";

describe("parseSkillUnlockFrontmatter", () => {
  test("parses unlocks_mcp, mcp_servers, and unlocks_tools from YAML frontmatter", () => {
    const md = [
      "---",
      "name: demo-skill",
      "description: Verify UI",
      "unlocks_mcp:",
      "  - opensession-portals",
      "  - opensession-walkthrough",
      "unlocks_tools: [opensession-assets_write_asset, opensession-charts_*]",
      "---",
      "# Body",
    ].join("\n");

    expect(parseSkillUnlockFrontmatter(md)).toEqual({
      skillName: "demo-skill",
      servers: ["opensession-portals", "opensession-walkthrough"],
      toolPatterns: ["opensession-assets_write_asset", "opensession-charts_*"],
    });
  });

  test("returns empty arrays when frontmatter has no unlock keys", () => {
    expect(parseSkillUnlockFrontmatter("---\nname: plain\n---\nBody")).toEqual({
      skillName: "plain",
      servers: [],
      toolPatterns: [],
    });
    expect(parseSkillUnlockFrontmatter("No frontmatter")).toEqual({
      servers: [],
      toolPatterns: [],
    });
  });
});

describe("helpers", () => {
  test("identifies SKILL.md paths and extracts server prefixes from tool patterns", () => {
    expect(isSkillFilePath("/repo/.agents/skills/demo/SKILL.md")).toBe(true);
    expect(isSkillFilePath("/repo/AGENTS.md")).toBe(false);
    expect(
      matchToolPattern(
        "opensession-portals_*",
        "opensession-portals_start_portal",
      ),
    ).toBe(true);
    expect(
      matchToolPattern("opensession-portals_*", "opensession-repos_list"),
    ).toBe(false);
    expect(
      extractServersFromPatterns([
        "opensession-portals_*",
        "opensession-assets_write_asset",
      ]),
    ).toEqual(["opensession-portals", "opensession-assets"]);
    expect(extractServersFromPatterns(["*_list"])).toBeNull();
  });
});

describe("piSkillUnlockTools", () => {
  test("hydrates and appends unlocked MCP tool schemas when reading a SKILL.md and deduplicates", async () => {
    const skillText = [
      "---",
      "name: verify-ui",
      "unlocks_mcp: [opensession-portals]",
      "unlocks_tools: [opensession-walkthrough_publish_walkthrough]",
      "---",
      "Steps...",
    ].join("\n");

    const readTool: ToolDefinition<any, any, any> = {
      name: "read",
      label: "read",
      description: "read",
      parameters: {} as any,
      execute: async () => ({
        content: [{ type: "text", text: skillText }],
        details: {},
      }),
    };

    const unlockedDefs: ToolDefinition<any, any, any>[] = [
      {
        name: "opensession-portals_start_portal",
        label: "Start portal",
        description: "Start a supervised portal",
        parameters: {
          type: "object",
          properties: { port: { type: "number" } },
        } as any,
        execute: async () => ({ content: [], details: {} }),
      },
      {
        name: "opensession-walkthrough_publish_walkthrough",
        label: "Publish walkthrough",
        description: "Publish visual proof",
        parameters: {
          type: "object",
          properties: { title: { type: "string" } },
        } as any,
        execute: async () => ({ content: [], details: {} }),
      },
    ];

    let unlockCalls = 0;
    const [wrapped] = piSkillUnlockTools([readTool], {
      unlockTools: async () => {
        unlockCalls++;
        return unlockedDefs;
      },
    });

    const first = await wrapped!.execute(
      "c1",
      { path: "/repo/.agents/skills/verify-ui/SKILL.md" },
      undefined,
      undefined,
      {} as any,
    );
    expect(unlockCalls).toBe(1);
    expect(first.content).toHaveLength(2);
    const block = (first.content[1] as { text: string }).text;
    expect(block).toContain('<unlocked_mcp_tools skill="verify-ui">');
    expect(block).toContain("opensession-portals_start_portal");
    expect(block).toContain("opensession-walkthrough_publish_walkthrough");

    // Second read of the same skill does not duplicate already-unlocked schemas.
    const second = await wrapped!.execute(
      "c2",
      { path: "/repo/.agents/skills/verify-ui/SKILL.md" },
      undefined,
      undefined,
      {} as any,
    );
    expect(second.content).toHaveLength(1);
  });
});
