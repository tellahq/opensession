import { dirname, relative, resolve, sep } from "path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const GUIDANCE_FILENAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md"] as const;
const MAX_GUIDANCE_FILE_BYTES = 32 * 1024;
const MAX_GUIDANCE_PER_CALL_BYTES = 96 * 1024;

export interface DiscoveredGuidance {
  path: string;
  relativePath: string;
  content: string;
}

export interface GuidanceRule {
  path: string;
  /** Directory of the AGENTS.md file that mentioned this guidance file. */
  sourceDir: string;
  globs: string[];
}

export interface PiGuidanceDiscovery {
  discoverForPath(accessedPath: string): Promise<DiscoveredGuidance[]>;
  discoverForPaths(
    accessedPaths: readonly string[],
  ): Promise<DiscoveredGuidance[]>;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isInsideRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Parse YAML frontmatter `globs` from a guidance file.
 * Supports `globs: "*.rs"`, `globs: ["*.rs", "Cargo.toml"]`, and block lists.
 */
export function parseGuidanceFrontmatter(content: string): {
  globs: string[];
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { globs: [], body: content };
  const frontmatter = match[1] || "";
  const body = content.slice(match[0].length);
  const lines = frontmatter.split(/\r?\n/);
  const globs: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const keyMatch = /^\s*globs\s*:\s*(.*)$/.exec(line);
    if (!keyMatch) continue;
    const inline = (keyMatch[1] || "").trim();
    if (inline.startsWith("[") && inline.endsWith("]")) {
      const inner = inline.slice(1, -1).trim();
      if (inner) {
        for (const item of inner.split(",")) {
          const cleaned = stripQuotes(item);
          if (cleaned) globs.push(cleaned);
        }
      }
      break;
    }
    if (inline) {
      const cleaned = stripQuotes(inline);
      if (cleaned) globs.push(cleaned);
      break;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (/^\s*$/.test(next) || /^\s*#/.test(next)) continue;
      const itemMatch = /^\s*-\s+(.+?)\s*$/.exec(next);
      if (!itemMatch) break;
      const cleaned = stripQuotes(itemMatch[1]!);
      if (cleaned) globs.push(cleaned);
    }
    break;
  }

  return { globs, body };
}

/**
 * Extract relative `@path` / `@glob` guidance references outside fenced and
 * inline code blocks. Ignores emails, absolute paths, and home paths.
 */
export function extractGuidanceMentions(content: string): string[] {
  const withoutFences = content.replace(
    /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm,
    "",
  );
  const withoutCode = withoutFences.replace(/`[^`\n]+`/g, "");
  const mentions = new Set<string>();
  const re = /(?:^|[\s([;,:])@([A-Za-z0-9._*?[\]{}/-]+)/gm;

  for (const match of withoutCode.matchAll(re)) {
    let raw = match[1] || "";
    raw = raw.replace(/[.,;:)\]]+$/, "");
    if (!raw || raw.startsWith("/") || raw.startsWith("~")) continue;
    if (
      !raw.includes("/") &&
      !raw.includes("*") &&
      !/\.(?:md|mdx|mdc|txt)$/i.test(raw)
    ) {
      continue;
    }
    mentions.add(raw);
  }
  return [...mentions];
}

function globMatches(pattern: string, target: string): boolean {
  try {
    return new Bun.Glob(pattern).match(target);
  } catch {
    return false;
  }
}

/**
 * Check whether an accessed file matches any `globs` entry from a guidance file.
 * Patterns starting with `./` or `../` resolve relative to the guidance file's
 * own directory; other patterns match relative to `sourceDir` (the mentioning
 * AGENTS.md directory) both directly and with an implicit `**\/` prefix.
 */
export function matchesGuidanceGlobs(
  accessedPath: string,
  sourceDir: string,
  globs: readonly string[],
  guidanceFileDir: string = sourceDir,
): boolean {
  if (!globs.length) return false;
  const relFromSource = toPosixPath(relative(sourceDir, accessedPath));
  if (
    !relFromSource ||
    relFromSource.startsWith("../") ||
    relFromSource === ".."
  ) {
    return false;
  }

  for (const rawPattern of globs) {
    const pattern = toPosixPath(rawPattern.trim());
    if (!pattern) continue;
    if (pattern.startsWith("./") || pattern.startsWith("../")) {
      const anchoredTarget = resolve(guidanceFileDir, pattern);
      const relFromAnchor = toPosixPath(relative(sourceDir, anchoredTarget));
      if (globMatches(relFromAnchor, relFromSource)) return true;
      continue;
    }
    if (globMatches(pattern, relFromSource)) return true;
    if (
      !pattern.startsWith("**/") &&
      globMatches(`**/${pattern}`, relFromSource)
    ) {
      return true;
    }
  }
  return false;
}

function truncateGuidance(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, "utf-8");
  if (buf.byteLength <= maxBytes) return content;
  return `${buf.subarray(0, maxBytes).toString("utf-8")}\n[guidance truncated]`;
}

export function createPiGuidanceDiscovery(opts: {
  workspaceRoot: string;
  readText: (absPath: string) => Promise<string | null>;
  listGlob?: (pattern: string, baseDir: string) => Promise<string[]>;
}): PiGuidanceDiscovery {
  const root = resolve(opts.workspaceRoot);
  const seenFiles = new Set<string>();
  const indexedSources = new Set<string>();
  const checkedDirs = new Set<string>();
  const globRules = new Map<string, GuidanceRule>();
  let rootInitialized = false;

  async function indexMentionsFrom(
    sourcePath: string,
    content: string,
  ): Promise<void> {
    if (indexedSources.has(sourcePath)) return;
    indexedSources.add(sourcePath);

    const sourceDir = dirname(sourcePath);
    const mentions = extractGuidanceMentions(content);
    for (const mention of mentions) {
      let candidates: string[] = [];
      if (/[*?[\]{}]/.test(mention)) {
        if (!opts.listGlob) continue;
        try {
          candidates = await opts.listGlob(mention, sourceDir);
        } catch {
          candidates = [];
        }
      } else {
        candidates = [resolve(sourceDir, mention)];
      }

      for (const candidate of candidates) {
        const abs = resolve(candidate);
        if (!isInsideRoot(abs, root)) continue;
        if (globRules.has(abs)) continue;
        const text = await opts.readText(abs).catch(() => null);
        if (text === null) continue;
        const { globs } = parseGuidanceFrontmatter(text);
        if (globs.length > 0) {
          globRules.set(abs, {
            path: abs,
            sourceDir,
            globs,
          });
        }
      }
    }
  }

  async function findDirGuidance(
    dir: string,
  ): Promise<{ path: string; content: string } | null> {
    for (const filename of GUIDANCE_FILENAMES) {
      const candidate = resolve(dir, filename);
      const text = await opts.readText(candidate).catch(() => null);
      if (text !== null) {
        return { path: candidate, content: text };
      }
    }
    return null;
  }

  async function ensureRootIndexed(): Promise<void> {
    if (rootInitialized) return;
    rootInitialized = true;
    const rootDoc = await findDirGuidance(root);
    if (rootDoc) {
      seenFiles.add(rootDoc.path);
      await indexMentionsFrom(rootDoc.path, rootDoc.content);
    }
  }

  async function discoverForPath(
    rawPath: string,
  ): Promise<DiscoveredGuidance[]> {
    if (!rawPath) return [];
    const absPath = resolve(root, rawPath);
    if (!isInsideRoot(absPath, root)) return [];

    await ensureRootIndexed();

    const discovered: DiscoveredGuidance[] = [];
    let totalBytes = 0;

    // Ancestor directories between root (exclusive) and dirname(absPath) (inclusive),
    // outermost first so closer package rules appear after broader ones.
    const dirs: string[] = [];
    let current = dirname(absPath);
    while (current !== root && isInsideRoot(current, root)) {
      dirs.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    dirs.reverse();

    for (const dir of dirs) {
      if (checkedDirs.has(dir)) continue;
      checkedDirs.add(dir);
      const doc = await findDirGuidance(dir);
      if (!doc) continue;
      if (!seenFiles.has(doc.path)) {
        seenFiles.add(doc.path);
        const clipped = truncateGuidance(doc.content, MAX_GUIDANCE_FILE_BYTES);
        const bytes = Buffer.byteLength(clipped, "utf-8");
        if (totalBytes + bytes <= MAX_GUIDANCE_PER_CALL_BYTES) {
          totalBytes += bytes;
          discovered.push({
            path: doc.path,
            relativePath: toPosixPath(relative(root, doc.path)),
            content: clipped,
          });
        }
      }
      await indexMentionsFrom(doc.path, doc.content);
    }

    for (const rule of globRules.values()) {
      if (seenFiles.has(rule.path)) continue;
      if (
        !matchesGuidanceGlobs(
          absPath,
          rule.sourceDir,
          rule.globs,
          dirname(rule.path),
        )
      ) {
        continue;
      }
      const text = await opts.readText(rule.path).catch(() => null);
      if (text === null) continue;
      seenFiles.add(rule.path);
      const { body } = parseGuidanceFrontmatter(text);
      const clipped = truncateGuidance(
        body.trim() || text,
        MAX_GUIDANCE_FILE_BYTES,
      );
      const bytes = Buffer.byteLength(clipped, "utf-8");
      if (totalBytes + bytes <= MAX_GUIDANCE_PER_CALL_BYTES) {
        totalBytes += bytes;
        discovered.push({
          path: rule.path,
          relativePath: toPosixPath(relative(root, rule.path)),
          content: clipped,
        });
      }
    }

    return discovered;
  }

  async function discoverForPaths(
    accessedPaths: readonly string[],
  ): Promise<DiscoveredGuidance[]> {
    const out: DiscoveredGuidance[] = [];
    for (const p of accessedPaths) {
      const items = await discoverForPath(p);
      out.push(...items);
    }
    return out;
  }

  return { discoverForPath, discoverForPaths };
}

export function formatDiscoveredGuidance(
  items: readonly DiscoveredGuidance[],
): string {
  return items
    .map(
      (item) =>
        `<discovered_guidance path="${item.relativePath}">\n${item.content.trimEnd()}\n</discovered_guidance>`,
    )
    .join("\n\n");
}

function defaultExtractToolPaths(toolName: string, params: unknown): string[] {
  if (!params || typeof params !== "object") return [];
  if (toolName === "read" || toolName === "edit" || toolName === "write") {
    const path = (params as { path?: unknown }).path;
    return typeof path === "string" && path.trim() ? [path.trim()] : [];
  }
  return [];
}

/**
 * Wrap file tools so touching a path automatically appends any newly discovered
 * subtree AGENTS.md or glob-matched @-mentioned guidance to the tool result.
 */
export function piGuidanceDiscoveryTools(
  tools: readonly ToolDefinition<any, any, any>[],
  discovery: PiGuidanceDiscovery,
  extractPaths: (
    toolName: string,
    params: unknown,
  ) => string[] = defaultExtractToolPaths,
): ToolDefinition<any, any, any>[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await tool.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
      const paths = extractPaths(tool.name, params);
      if (!paths.length || !result || typeof result !== "object") return result;

      try {
        const discovered = await discovery.discoverForPaths(paths);
        if (!discovered.length) return result;
        const guidanceBlock = {
          type: "text" as const,
          text: formatDiscoveredGuidance(discovered),
        };
        const content = Array.isArray(result.content)
          ? [...result.content, guidanceBlock]
          : [guidanceBlock];
        return { ...result, content };
      } catch {
        return result;
      }
    },
  }));
}
