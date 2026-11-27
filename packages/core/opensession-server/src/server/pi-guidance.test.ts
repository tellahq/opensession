import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createPiGuidanceDiscovery,
  extractGuidanceMentions,
  matchesGuidanceGlobs,
  parseGuidanceFrontmatter,
  piGuidanceDiscoveryTools,
} from "./pi-guidance";

async function withWorkspace(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "os-pi-guidance-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("parseGuidanceFrontmatter", () => {
  test("parses YAML block list, inline array, and scalar globs", () => {
    const block = `---\nglobs:\n  - "**/*.rs"\n  - 'Cargo.toml'\n---\n\nRust rules.`;
    expect(parseGuidanceFrontmatter(block)).toEqual({
      globs: ["**/*.rs", "Cargo.toml"],
      body: "\nRust rules.",
    });

    const inline = `---\nglobs: ["*.ts", "src/**/*.tsx"]\n---\nTS rules.`;
    expect(parseGuidanceFrontmatter(inline)).toEqual({
      globs: ["*.ts", "src/**/*.tsx"],
      body: "TS rules.",
    });

    const scalar = `---\nglobs: "**/*.sql"\n---\nSQL rules.`;
    expect(parseGuidanceFrontmatter(scalar)).toEqual({
      globs: ["**/*.sql"],
      body: "SQL rules.",
    });
  });

  test("returns empty globs when no frontmatter is present", () => {
    expect(parseGuidanceFrontmatter("# Plain markdown")).toEqual({
      globs: [],
      body: "# Plain markdown",
    });
  });
});

describe("extractGuidanceMentions", () => {
  test("extracts relative mentions while ignoring code blocks, emails, and decorators", () => {
    const doc = [
      "See @.agents/guidance/rust.md and @docs/*.md for rules.",
      "Contact dev@example.test or use @decorator in code.",
      "Ignore `@docs/inline.md` and absolute @/etc/passwd or @~/secret.md.",
      "```markdown",
      "See @docs/in-fence.md",
      "```",
    ].join("\n");

    expect(extractGuidanceMentions(doc)).toEqual([
      ".agents/guidance/rust.md",
      "docs/*.md",
    ]);
  });
});

describe("matchesGuidanceGlobs", () => {
  test("matches unanchored patterns anywhere under sourceDir and relative ./ patterns from guidance dir", () => {
    expect(
      matchesGuidanceGlobs("/repo/crates/app/src/lib.rs", "/repo", ["*.rs"]),
    ).toBe(true);
    expect(
      matchesGuidanceGlobs("/repo/crates/app/src/lib.ts", "/repo", ["*.rs"]),
    ).toBe(false);
    expect(
      matchesGuidanceGlobs(
        "/repo/packages/web/src/App.tsx",
        "/repo",
        ["./src/**/*.tsx"],
        "/repo/packages/web",
      ),
    ).toBe(true);
    expect(
      matchesGuidanceGlobs(
        "/repo/packages/api/src/App.tsx",
        "/repo",
        ["./src/**/*.tsx"],
        "/repo/packages/web",
      ),
    ).toBe(false);
  });
});

describe("createPiGuidanceDiscovery", () => {
  test("discovers subtree AGENTS.md (with AGENT/CLAUDE fallback) outermost-first and deduplicates", async () => {
    await withWorkspace(async (root) => {
      await mkdir(join(root, "packages", "api", "routes"), { recursive: true });
      await writeFile(join(root, "AGENTS.md"), "# Root guidance");
      await writeFile(
        join(root, "packages", "AGENTS.md"),
        "# Packages guidance",
      );
      await writeFile(
        join(root, "packages", "api", "CLAUDE.md"),
        "# API guidance",
      );
      const target = join(root, "packages", "api", "routes", "health.ts");
      await writeFile(target, "export const ok = true;\n");

      const discovery = createPiGuidanceDiscovery({
        workspaceRoot: root,
        readText: (p) => readFile(p, "utf-8").catch(() => null),
      });

      const first = await discovery.discoverForPath(target);
      expect(first.map((d) => d.relativePath)).toEqual([
        "packages/AGENTS.md",
        "packages/api/CLAUDE.md",
      ]);

      // Second access to the same subtree returns nothing new.
      const second = await discovery.discoverForPath(target);
      expect(second).toEqual([]);
    });
  });

  test("injects @-mentioned glob-gated guidance only when a matching file is accessed", async () => {
    await withWorkspace(async (root) => {
      await mkdir(join(root, ".agents", "guidance"), { recursive: true });
      await mkdir(join(root, "crates", "core"), { recursive: true });
      await writeFile(
        join(root, "AGENTS.md"),
        "Root rules.\n- Rust: @.agents/guidance/*.md\n",
      );
      await writeFile(
        join(root, ".agents", "guidance", "rust.md"),
        "---\nglobs:\n  - '**/*.rs'\n  - 'Cargo.toml'\n---\nAlways run cargo check.\n",
      );
      await writeFile(
        join(root, ".agents", "guidance", "sql.md"),
        "---\nglobs: ['*.sql']\n---\nAlways index foreign keys.\n",
      );
      const tsFile = join(root, "index.ts");
      const rsFile = join(root, "crates", "core", "lib.rs");
      await writeFile(tsFile, "export {};\n");
      await writeFile(rsFile, "pub fn hi() {}\n");

      const discovery = createPiGuidanceDiscovery({
        workspaceRoot: root,
        readText: (p) => readFile(p, "utf-8").catch(() => null),
        listGlob: async (pattern, baseDir) => {
          const out: string[] = [];
          for await (const rel of new Bun.Glob(pattern).scan({
            cwd: baseDir,
            dot: true,
            onlyFiles: true,
            followSymlinks: false,
          })) {
            out.push(join(baseDir, rel));
          }
          return out.sort();
        },
      });

      expect(await discovery.discoverForPath(tsFile)).toEqual([]);

      const rsDiscovered = await discovery.discoverForPath(rsFile);
      expect(rsDiscovered).toEqual([
        {
          path: join(root, ".agents", "guidance", "rust.md"),
          relativePath: ".agents/guidance/rust.md",
          content: "Always run cargo check.",
        },
      ]);

      // Already injected once — accessing Cargo.toml won't duplicate it.
      expect(await discovery.discoverForPath(join(root, "Cargo.toml"))).toEqual(
        [],
      );
    });
  });

  test("piGuidanceDiscoveryTools appends discovered guidance block to read/edit/write results", async () => {
    await withWorkspace(async (root) => {
      await mkdir(join(root, "pkg"), { recursive: true });
      await writeFile(join(root, "pkg", "AGENTS.md"), "Use strict types.");
      const target = join(root, "pkg", "mod.ts");
      await writeFile(target, "export const x = 1;\n");

      const discovery = createPiGuidanceDiscovery({
        workspaceRoot: root,
        readText: (p) => readFile(p, "utf-8").catch(() => null),
      });

      const fakeRead: ToolDefinition<any, any, any> = {
        name: "read",
        label: "read",
        description: "read",
        parameters: {} as any,
        async execute() {
          return {
            content: [{ type: "text", text: "export const x = 1;\n" }],
            details: {},
          };
        },
      };

      const [wrapped] = piGuidanceDiscoveryTools([fakeRead], discovery);
      const res1 = await wrapped!.execute(
        "call-1",
        { path: target },
        undefined,
        undefined,
        {} as any,
      );
      expect(res1.content).toHaveLength(2);
      expect((res1.content[1] as { text: string }).text).toContain(
        '<discovered_guidance path="pkg/AGENTS.md">',
      );
      expect((res1.content[1] as { text: string }).text).toContain(
        "Use strict types.",
      );

      const res2 = await wrapped!.execute(
        "call-2",
        { path: target },
        undefined,
        undefined,
        {} as any,
      );
      expect(res2.content).toHaveLength(1);
    });
  });
});
