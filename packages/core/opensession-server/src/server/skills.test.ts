import { afterEach, describe, expect, test } from "bun:test";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  expandSkillCommand,
  skillSearchPaths,
  SHIPPED_SKILLS_DIR,
} from "./skill-paths";
import { searchSkills } from "./skills";

const dirs: string[] = [];

const PSTACK_UPSTREAM_SKILLS = [
  "architect",
  "arena",
  "automate-me",
  "blast-radius",
  "bro",
  "create-verification-skill",
  "figure-it-out",
  "how",
  "interrogate",
  "maintain-verification-skill",
  "no-comments",
  "poteto-mode",
  "principle-boundary-discipline",
  "principle-build-the-lever",
  "principle-encode-lessons-in-structure",
  "principle-exhaust-the-design-space",
  "principle-experience-first",
  "principle-fix-root-causes",
  "principle-foundational-thinking",
  "principle-guard-the-context-window",
  "principle-laziness-protocol",
  "principle-make-operations-idempotent",
  "principle-migrate-callers-then-delete-legacy-apis",
  "principle-minimize-reader-load",
  "principle-model-the-domain",
  "principle-never-block-on-the-human",
  "principle-outcome-oriented-execution",
  "principle-prove-it-works",
  "principle-redesign-from-first-principles",
  "principle-separate-before-serializing-shared-state",
  "principle-sequence-verifiable-units",
  "principle-subtract-before-you-add",
  "principle-type-system-discipline",
  "recall",
  "reflect",
  "setup-pstack",
  "show-me-your-work",
  "swarm",
  "tdd",
  "teach",
  "technical-writing",
  "typescript-best-practices",
  "unslop",
  "why",
] as const;

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

function loadShippedSkills() {
  return loadSkills({
    cwd: process.cwd(),
    agentDir: workspace(),
    skillPaths: [SHIPPED_SKILLS_DIR],
    includeDefaults: false,
  });
}

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

  test("expands a nested pstack skill with its references and arguments", () => {
    const loaded = loadShippedSkills().skills;
    const skill = loaded.find(
      (item) => item.name === "create-verification-skill",
    );
    expect(skill).toBeDefined();
    expect(skill!.filePath).toContain(
      "/pstack-suite/skills/create-verification-skill/SKILL.md",
    );

    for (const command of [
      "/create-verification-skill verify this repo",
      "/skill:create-verification-skill verify this repo",
    ]) {
      const expanded = expandSkillCommand(command, loaded);
      expect(expanded).toContain('<skill name="create-verification-skill"');
      expect(expanded).toContain(
        `References are relative to ${skill!.baseDir}.`,
      );
      expect(expanded).toEndWith("</skill>\n\nverify this repo");
    }
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

  test("ships the complete upstream pstack skill inventory", () => {
    const loaded = loadShippedSkills();
    expect(loaded.diagnostics).toEqual([]);

    for (const name of PSTACK_UPSTREAM_SKILLS) {
      expect(
        loaded.skills
          .filter((skill) => skill.name === name)
          .map((skill) => skill.name),
      ).toEqual([name]);
      expect(
        searchSkills(undefined, name).filter((skill) => skill.name === name),
      ).toHaveLength(1);
    }
  });

  test("keeps the pstack port free of Pi-only operational instructions", () => {
    const files = [
      ...filesUnder(join(SHIPPED_SKILLS_DIR, "pstack")),
      ...filesUnder(join(SHIPPED_SKILLS_DIR, "pstack-suite")),
      join(SHIPPED_SKILLS_DIR, "poteto-mode", "SKILL.md"),
    ].filter(
      (path) =>
        (path.endsWith(".md") || path.endsWith(".sh")) &&
        !path.endsWith("SOURCE.md"),
    );
    const forbidden = [
      ".pi/skills/",
      "$PI_SESSION_FILE",
      "pstack_sessions",
      "pstack_config",
      "~/.pi/agent/pstack",
      "poteto-agent",
      "cloud_base_branch",
    ];

    for (const file of files) {
      const body = readFileSync(file, "utf8");
      for (const token of forbidden) expect(body).not.toContain(token);
      expect(body).not.toMatch(/`subagent`|\bsubagent tool\b/i);
    }

    expect(files.some((file) => file.includes("/extensions/"))).toBe(false);
    const runner = readFileSync(join(import.meta.dir, "pi-runner.ts"), "utf8");
    expect(runner).toContain("noExtensions: true");
    expect(runner).toContain("noSkills: true");
  });

  test("resolves pstack references and preserves the safe helper", () => {
    const loaded = loadShippedSkills().skills.filter(
      (skill) =>
        skill.name === "pstack" ||
        skill.name === "poteto-mode" ||
        PSTACK_UPSTREAM_SKILLS.includes(
          skill.name as (typeof PSTACK_UPSTREAM_SKILLS)[number],
        ),
    );

    for (const skill of loaded) {
      const body = readFileSync(skill.filePath, "utf8");
      for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].split("#", 1)[0];
        if (!target || target === "url" || target.includes("://")) continue;
        expect(existsSync(join(skill.baseDir, target))).toBe(true);
      }
    }

    const helper = join(
      SHIPPED_SKILLS_DIR,
      "pstack-suite",
      "skills",
      "show-me-your-work",
      "scripts",
      "log.sh",
    );
    expect(statSync(helper).mode & 0o111).not.toBe(0);
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

    const runtime = loadSkills({
      cwd: ws,
      agentDir: workspace(),
      skillPaths: skillSearchPaths(ws),
      includeDefaults: false,
    });
    expect(
      runtime.skills
        .filter((skill) => skill.name === "simplify")
        .map((skill) => skill.description),
    ).toEqual(["The checkout's own take"]);
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
