import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  enablesPstackMode,
  isPstackCommand,
  pstackCommandInput,
  PSTACK_MODE_NOTE,
} from "./pstack-mode";
import { expandSkillCommand, SHIPPED_SKILLS_DIR } from "./skill-paths";
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

  test("lists and expands both bundled command names with their tasks", () => {
    for (const name of ["pstack", "poteto-mode"]) {
      const listed = searchSkills(process.cwd(), name);
      expect(listed.some((skill) => skill.name === name)).toBe(true);

      const dir = join(SHIPPED_SKILLS_DIR, name);
      const expanded = expandSkillCommand(`/${name} fix it`, [
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
