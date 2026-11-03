import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  enablesPstackMode,
  isPstackCommand,
  pstackCommandInput,
  PSTACK_MODE_NOTE,
} from "./pstack-mode";
import {
  expandSkillCommand,
  gatePstackSkills,
  isPstackSkillPath,
  SHIPPED_SKILLS_DIR,
} from "./skill-paths";
import { searchSkills } from "./skills";

describe("pstack mode", () => {
  test("recognizes task-bearing opening prompts and explicit opt-outs", () => {
    expect(enablesPstackMode("/pstack fix the retry regression")).toBe(true);
    expect(enablesPstackMode("/skill:pstack review this diff")).toBe(true);
    expect(enablesPstackMode("/poteto-mode trace the flaky test")).toBe(true);
    expect(enablesPstackMode("/skill:poteto-mode review this diff")).toBe(true);
    expect(enablesPstackMode(" /PSTACK on ")).toBe(true);
    expect(enablesPstackMode("/pstack off")).toBe(false);
    expect(enablesPstackMode("/poteto-mode disable")).toBe(false);
    expect(enablesPstackMode("explain pstack")).toBe(false);
  });

  test("parses only exact slash commands", () => {
    expect(isPstackCommand("/pstack")).toBe(true);
    expect(isPstackCommand("/poteto-mode")).toBe(true);
    expect(isPstackCommand("/pstacking")).toBe(false);
    expect(isPstackCommand("/poteto-mode-extra")).toBe(false);
    expect(pstackCommandInput("/skill:pstack   inspect this")).toBe(
      "inspect this",
    );
    expect(pstackCommandInput("/poteto-mode   inspect this")).toBe(
      "inspect this",
    );
  });

  test("ships a self-contained standing reminder", () => {
    expect(PSTACK_MODE_NOTE).toContain("Pstack mode is enabled");
    expect(PSTACK_MODE_NOTE).toContain("spawn_task");
    expect(PSTACK_MODE_NOTE).toContain("never grants additional access");
  });

  test("hides the pstack family from the model until the session opts in", () => {
    const shipped = join(SHIPPED_SKILLS_DIR, "pstack-suite", "skills");
    // The checkout symlink path a session on this repository loads from.
    const linked = "/tmp/ws/.claude/skills/pstack-suite/skills/unslop/SKILL.md";
    const skills = [
      { filePath: join(SHIPPED_SKILLS_DIR, "pstack", "SKILL.md") },
      { filePath: join(SHIPPED_SKILLS_DIR, "poteto-mode", "SKILL.md") },
      { filePath: join(shipped, "unslop", "SKILL.md") },
      { filePath: linked },
      { filePath: join(SHIPPED_SKILLS_DIR, "simplify", "SKILL.md") },
      // A different skill whose name merely starts with "pstack".
      { filePath: join(SHIPPED_SKILLS_DIR, "pstack-notes", "SKILL.md") },
    ];

    expect(skills.map((s) => isPstackSkillPath(s.filePath))).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);

    const gated = gatePstackSkills(skills, undefined);
    expect(
      gated.map(
        (s) =>
          (s as { disableModelInvocation?: boolean }).disableModelInvocation,
      ),
    ).toEqual([true, true, true, true, undefined, undefined]);
    // Still loaded: an explicit /unslop or /pstack keeps expanding.
    expect(gated.map((s) => s.filePath)).toEqual(skills.map((s) => s.filePath));

    expect(gatePstackSkills(skills, true)).toBe(skills);
  });

  test("lists and expands both bundled command names with their tasks", async () => {
    for (const name of ["pstack", "poteto-mode"]) {
      const listed = await searchSkills(process.cwd(), name);
      expect(listed.some((skill) => skill.name === name)).toBe(true);

      const dir = join(SHIPPED_SKILLS_DIR, name);
      const expanded = await expandSkillCommand(`/${name} fix it`, [
        {
          name,
          filePath: join(dir, "SKILL.md"),
          baseDir: dir,
        },
      ]);
      expect(expanded).toContain(`<skill name="${name}"`);
      expect(expanded).toMatch(/# (Pstack|Poteto) mode/);
      if (name === "pstack") {
        expect(expanded).toContain("## Open Session delegation");
        expect(expanded).toContain("playbooks/orchestrate.md");
        expect(expanded).toContain("principle-model-the-domain");
      } else {
        expect(expanded).toContain(
          "canonical Open Session pstack implementation",
        );
      }
      expect(expanded).toEndWith("fix it");
    }
  });
});
