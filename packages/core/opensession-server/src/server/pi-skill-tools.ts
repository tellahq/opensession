import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

/**
 * Skill-unlocked MCP tool hydration.
 *
 * When a `SKILL.md` file declares `unlocks_mcp` / `mcp_servers` or
 * `unlocks_tools` in its YAML frontmatter, reading that skill automatically
 * hydrates the matching policy-permitted MCP tool schemas and appends them to
 * the `read` tool result. The model can invoke `mcp_call` immediately without
 * burning extra `mcp_search` turns, while the session's initial system prompt
 * and tool declarations stay slim and cache-stable.
 */

export interface SkillUnlockSpec {
  readonly skillName?: string;
  readonly servers: readonly string[];
  readonly toolPatterns: readonly string[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseYamlStringList(
  lines: readonly string[],
  startIndex: number,
  inlineRest: string,
): { values: string[]; nextIndex: number } {
  const rest = inlineRest.trim();
  if (rest.startsWith("[") && rest.endsWith("]")) {
    const inner = rest.slice(1, -1).trim();
    if (!inner) return { values: [], nextIndex: startIndex + 1 };
    const values = inner.split(",").map(unquote).filter(Boolean);
    return { values, nextIndex: startIndex + 1 };
  }
  if (rest.length > 0) {
    const values = rest.split(",").map(unquote).filter(Boolean);
    return { values, nextIndex: startIndex + 1 };
  }

  const values: string[] = [];
  let i = startIndex + 1;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (!item) break;
    const cleaned = unquote(item[1]!);
    if (cleaned) values.push(cleaned);
    i++;
  }
  return { values, nextIndex: i };
}

export function parseSkillUnlockFrontmatter(content: string): SkillUnlockSpec {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { servers: [], toolPatterns: [] };
  }
  const endIdx = normalized.indexOf("\n---", 4);
  if (endIdx === -1) return { servers: [], toolPatterns: [] };

  const fmLines = normalized.slice(4, endIdx).split("\n");
  let skillName: string | undefined;
  const servers: string[] = [];
  const toolPatterns: string[] = [];

  for (let i = 0; i < fmLines.length;) {
    const line = fmLines[i]!;
    const keyMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!keyMatch) {
      i++;
      continue;
    }
    const key = keyMatch[1]!.toLowerCase();
    const rest = keyMatch[2]!;
    if (key === "name") {
      const cleaned = unquote(rest);
      if (cleaned) skillName = cleaned;
      i++;
      continue;
    }
    if (key === "unlocks_mcp" || key === "mcp_servers") {
      const parsed = parseYamlStringList(fmLines, i, rest);
      servers.push(...parsed.values);
      i = parsed.nextIndex;
      continue;
    }
    if (key === "unlocks_tools") {
      const parsed = parseYamlStringList(fmLines, i, rest);
      toolPatterns.push(...parsed.values);
      i = parsed.nextIndex;
      continue;
    }
    i++;
  }

  return {
    skillName,
    servers: [...new Set(servers)],
    toolPatterns: [...new Set(toolPatterns)],
  };
}

export function isSkillFilePath(filePath: string): boolean {
  const base = basename(filePath.trim()).toLowerCase();
  return base === "skill.md";
}

export function matchToolPattern(pattern: string, toolName: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(toolName);
}

/** Server names in MCP tool IDs never contain `_`, so `server_*` or `server_tool`
 *  identifies the exact server to hydrate without waking unrelated servers. */
export function extractServersFromPatterns(
  patterns: readonly string[],
): string[] | null {
  const servers = new Set<string>();
  for (const pat of patterns) {
    const underscore = pat.indexOf("_");
    if (underscore <= 0) return null;
    const prefix = pat.slice(0, underscore);
    if (prefix.includes("*")) return null;
    servers.add(prefix);
  }
  return [...servers];
}

export interface SkillToolUnlocker {
  unlockTools(filter: {
    readonly servers?: readonly string[];
    readonly toolPatterns?: readonly string[];
  }): Promise<readonly ToolDefinition<any, any, any>[]>;
}

const MAX_UNLOCKED_PER_SKILL = 16;

function formatUnlockedTools(
  skillLabel: string,
  tools: readonly ToolDefinition<any, any, any>[],
): string {
  const brief = (text: string) =>
    text.length > 500 ? `${text.slice(0, 500)}… [truncated]` : text;
  const body = tools
    .slice(0, MAX_UNLOCKED_PER_SKILL)
    .map(
      (t) =>
        `${t.name}: ${brief(t.description || "")}\narguments: ${JSON.stringify(t.parameters)}`,
    )
    .join("\n\n");
  return `<unlocked_mcp_tools skill="${skillLabel}">\nUse mcp_call with these exact tool names and argument schemas:\n\n${body}\n</unlocked_mcp_tools>`;
}

/**
 * Wrap the `read` tool so reading a `SKILL.md` with `unlocks_mcp` or
 * `unlocks_tools` frontmatter hydrates and appends those permitted MCP tool
 * schemas once per run.
 */
export function piSkillUnlockTools(
  tools: readonly ToolDefinition<any, any, any>[],
  unlocker: SkillToolUnlocker,
): ToolDefinition<any, any, any>[] {
  const unlockedNames = new Set<string>();

  return tools.map((tool) => {
    if (tool.name !== "read") return tool;
    return {
      ...tool,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const result = await tool.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        );
        const path =
          params && typeof params === "object"
            ? (params as { path?: unknown }).path
            : undefined;
        if (typeof path !== "string" || !isSkillFilePath(path)) return result;
        if (
          !result ||
          typeof result !== "object" ||
          !Array.isArray(result.content)
        ) {
          return result;
        }

        const textContent = result.content
          .filter(
            (item: unknown): item is { type: "text"; text: string } =>
              Boolean(item) &&
              typeof item === "object" &&
              (item as { type?: unknown }).type === "text" &&
              typeof (item as { text?: unknown }).text === "string",
          )
          .map((item: { text: string }) => item.text)
          .join("\n");

        const spec = parseSkillUnlockFrontmatter(textContent);
        if (spec.servers.length === 0 && spec.toolPatterns.length === 0) {
          return result;
        }

        try {
          const candidates = await unlocker.unlockTools({
            servers: spec.servers,
            toolPatterns: spec.toolPatterns,
          });
          const fresh = candidates.filter((t) => !unlockedNames.has(t.name));
          if (fresh.length === 0) return result;
          for (const t of fresh.slice(0, MAX_UNLOCKED_PER_SKILL)) {
            unlockedNames.add(t.name);
          }

          const block = {
            type: "text" as const,
            text: formatUnlockedTools(spec.skillName || basename(path), fresh),
          };
          return {
            ...result,
            content: [...result.content, block],
          };
        } catch {
          return result;
        }
      },
    };
  });
}
