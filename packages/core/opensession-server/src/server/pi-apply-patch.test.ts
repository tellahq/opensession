import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  stat,
  unlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHunksToContent,
  makePiApplyPatchTool,
  modelPromptAdaptation,
  parseCodexPatch,
  usesApplyPatchTool,
} from "./pi-apply-patch";

describe("usesApplyPatchTool and modelPromptAdaptation", () => {
  test("selects apply_patch for OpenAI GPT-5+/Codex/o-series and edit/write for Claude/Gemini/other", () => {
    expect(usesApplyPatchTool("openai", "gpt-5.4")).toBe(true);
    expect(usesApplyPatchTool("openai-codex", "gpt-6.2-sol")).toBe(true);
    expect(usesApplyPatchTool("openai", "codex-mini")).toBe(true);
    expect(usesApplyPatchTool("openai", "o3-mini")).toBe(true);

    expect(usesApplyPatchTool("anthropic", "claude-opus-5-5")).toBe(false);
    expect(usesApplyPatchTool("google-vertex", "gemini-4-carbon")).toBe(false);
    expect(usesApplyPatchTool("xai", "grok-4.7")).toBe(false);
    expect(usesApplyPatchTool("openai", "gpt-4o")).toBe(false);

    expect(modelPromptAdaptation("openai", "gpt-6.2-sol")).toContain(
      "apply_patch",
    );
    expect(modelPromptAdaptation("anthropic", "claude-opus-5-5")).toContain(
      "`edit`",
    );
    expect(modelPromptAdaptation("xai", "grok-4.7")).toBeUndefined();
  });
});

describe("parseCodexPatch", () => {
  test("parses add, update with move and multiple hunks, and delete", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "+export const b = 2;",
      "*** Update File: src/old.ts",
      "*** Move to: src/renamed.ts",
      "@@ class Greeter",
      "@@ greet()",
      "   greet() {",
      "-    return 'hi';",
      "+    return 'hello';",
      "   }",
      "*** End of File",
      "*** Delete File: src/drop.ts",
      "*** End Patch",
    ].join("\n");

    const ops = parseCodexPatch(patch);
    expect(ops).toHaveLength(3);
    expect(ops[0]).toEqual({
      kind: "add",
      path: "src/new.ts",
      lines: ["export const a = 1;", "export const b = 2;"],
    });
    expect(ops[1]).toEqual({
      kind: "update",
      path: "src/old.ts",
      moveTo: "src/renamed.ts",
      hunks: [
        {
          headers: ["class Greeter", "greet()"],
          endOfFile: true,
          lines: [
            { kind: "context", text: "  greet() {" },
            { kind: "remove", text: "    return 'hi';" },
            { kind: "add", text: "    return 'hello';" },
            { kind: "context", text: "  }" },
          ],
        },
      ],
    });
    expect(ops[2]).toEqual({ kind: "delete", path: "src/drop.ts" });
  });

  test("rejects missing Begin/End markers or empty patches", () => {
    expect(() => parseCodexPatch("*** Update File: a.ts")).toThrow(
      "Begin Patch",
    );
    expect(() => parseCodexPatch("*** Begin Patch\n*** End Patch")).toThrow(
      "no file operations",
    );
  });
});

describe("applyHunksToContent", () => {
  test("uses @@ headers to disambiguate repeated blocks and preserves CRLF", () => {
    const original = [
      "function first() {",
      "  return 1;",
      "}",
      "",
      "function second() {",
      "  return 1;",
      "}",
      "",
    ].join("\r\n");

    const ops = parseCodexPatch(
      [
        "*** Begin Patch",
        "*** Update File: demo.ts",
        "@@ function second()",
        "-  return 1;",
        "+  return 2;",
        "*** End Patch",
      ].join("\n"),
    );

    const updateOp = ops[0]!;
    if (updateOp.kind !== "update") throw new Error("expected update");
    const res = applyHunksToContent(original, updateOp.hunks, "demo.ts");
    expect(res.content).toBe(
      [
        "function first() {",
        "  return 1;",
        "}",
        "",
        "function second() {",
        "  return 2;",
        "}",
        "",
      ].join("\r\n"),
    );
    expect(res.additions).toBe(1);
    expect(res.deletions).toBe(1);
  });

  test("rejects ambiguous hunks without a unique header", () => {
    const original = "const x = 1;\nfoo();\nconst y = 2;\nfoo();\n";
    const ops = parseCodexPatch(
      [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-foo();",
        "+bar();",
        "*** End Patch",
      ].join("\n"),
    );
    const updateOp = ops[0]!;
    if (updateOp.kind !== "update") throw new Error("expected update");
    expect(() => applyHunksToContent(original, updateOp.hunks, "a.ts")).toThrow(
      "matched 2 locations",
    );
  });
});

describe("makePiApplyPatchTool", () => {
  test("applies add, update+move, and delete end-to-end on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-apply-patch-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/old.ts"), "export const v = 1;\n");
    await writeFile(join(dir, "src/remove.ts"), "bye\n");

    const tool = makePiApplyPatchTool({
      cwd: dir,
      operations: {
        readFile: (p) => readFile(p),
        writeFile: (p, c) => writeFile(p, c, "utf-8"),
        mkdir: async (d) => {
          await mkdir(d, { recursive: true });
        },
        deleteFile: (p) => unlink(p),
      },
    });

    const patchText = [
      "*** Begin Patch",
      "*** Add File: nested/created.ts",
      "+export const created = true;",
      "*** Update File: src/old.ts",
      "*** Move to: src/moved.ts",
      "@@",
      "-export const v = 1;",
      "+export const v = 2;",
      "*** Delete File: src/remove.ts",
      "*** End Patch",
    ].join("\n");

    const result = await tool.execute(
      "c1",
      { patchText },
      undefined,
      undefined,
      {} as any,
    );
    expect((result.content[0] as { text: string }).text).toContain(
      "Applied patch (3 files",
    );
    expect(await readFile(join(dir, "nested/created.ts"), "utf-8")).toBe(
      "export const created = true;\n",
    );
    expect(await readFile(join(dir, "src/moved.ts"), "utf-8")).toBe(
      "export const v = 2;\n",
    );
    await expect(stat(join(dir, "src/old.ts"))).rejects.toThrow();
    await expect(stat(join(dir, "src/remove.ts"))).rejects.toThrow();
  });
});
