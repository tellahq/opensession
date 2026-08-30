import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  expandSkillCommand,
  skillSearchPaths,
  SHIPPED_SKILLS_DIR,
} from "./skill-paths";
import { searchSkills } from "./skills";

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "opensession-skills-"));
  dirs.push(dir);
  return dir;
}

function writeSkill(
  root: string,
  name: string,
  description: string,
  body = "Body.",
) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
  return join(dir, "SKILL.md");
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("skillSearchPaths", () => {
  test("ships a set every session gets, checkout first", () => {
    const ws = workspace();
    mkdirSync(join(ws, ".agents", "skills"), { recursive: true });
    mkdirSync(join(ws, ".claude", "skills"), { recursive: true });

    expect(skillSearchPaths(ws)).toEqual([
      join(ws, ".claude", "skills"),
      join(ws, ".agents", "skills"),
      SHIPPED_SKILLS_DIR,
    ]);
    // A session with no skills of its own still gets the shipped ones, and a
    // directory that does not exist is dropped rather than handed to pi.
    expect(skillSearchPaths(workspace())).toEqual([SHIPPED_SKILLS_DIR]);
    expect(skillSearchPaths()).toEqual([SHIPPED_SKILLS_DIR]);
  });

  test("the shipped directory is listed once, even for a session on this repo", () => {
    const paths = skillSearchPaths(join(SHIPPED_SKILLS_DIR, "..", ".."));
    expect(paths.length).toBe(new Set(paths).size);
  });
});

describe("expandSkillCommand", () => {
  const ws = () => {
    const root = workspace();
    const filePath = writeSkill(
      root,
      "bro",
      "Restate plainly",
      "Say it again, plainly.",
    );
    return { filePath, baseDir: join(root, "bro") };
  };

  test("a bare /name expands to the same block pi builds for /skill:name", () => {
    const { filePath, baseDir } = ws();
    const skills = [{ name: "bro", filePath, baseDir }];
    const expected =
      `<skill name="bro" location="${filePath}">\n` +
      `References are relative to ${baseDir}.\n\n# nothing`.replace(
        "# nothing",
        "Say it again, plainly.\n</skill>",
      );

    expect(expandSkillCommand("/bro", skills)).toBe(expected);
    expect(expandSkillCommand("/skill:bro", skills)).toBe(expected);
  });

  test("arguments ride along after the block", () => {
    const { filePath, baseDir } = ws();
    expect(
      expandSkillCommand("/bro the deploy bit", [
        { name: "bro", filePath, baseDir },
      ]),
    ).toEndWith("</skill>\n\nthe deploy bit");
  });

  test("anything that is not a loaded skill is left alone", () => {
    const { filePath, baseDir } = ws();
    const skills = [{ name: "bro", filePath, baseDir }];
    expect(expandSkillCommand("/model opus", skills)).toBe("/model opus");
    expect(expandSkillCommand("/brother", skills)).toBe("/brother");
    expect(expandSkillCommand("look at /bro in the docs", skills)).toBe(
      "look at /bro in the docs",
    );
  });
});

describe("searchSkills", () => {
  test("lists the skills opensession ships for every repo", () => {
    // Every session gets these whatever it is working on, so the menu must
    // offer them with no worktree at all.
    for (const name of [
      "simplify",
      "deslop",
      "control-ui",
      "workflow-authoring",
      "poteto-mode",
      "vercel-react-best-practices",
      "vercel-composition-patterns",
    ]) {
      const shipped = searchSkills(undefined, name).filter(
        (s) => s.name === name,
      );
      expect(shipped.map((s) => s.source)).toEqual(["user"]);
    }
  });

  test("a checkout's own skill shadows the shipped one of the same name", () => {
    const ws = workspace();
    writeSkill(
      join(ws, ".agents", "skills"),
      "simplify",
      "The checkout's own take",
    );

    expect(
      searchSkills(ws, "simplify").filter((s) => s.name === "simplify"),
    ).toEqual([
      {
        name: "simplify",
        description: "The checkout's own take",
        source: "project",
      },
    ]);
  });

  test("builtin commands only join the menu for an existing session", () => {
    const ws = workspace();
    const named = (name: string, includeBuiltins: boolean) =>
      searchSkills(ws, name, 24, includeBuiltins).filter(
        (s) => s.name === name,
      );

    expect(named("model", false)).toEqual([]);
    expect(named("model", true).map((s) => s.source)).toEqual(["builtin"]);
    expect(named("poteto-mode", false).map((s) => s.source)).toEqual(["user"]);
    expect(named("poteto-mode", true).map((s) => s.source)).toEqual([
      "builtin",
    ]);
  });
});
