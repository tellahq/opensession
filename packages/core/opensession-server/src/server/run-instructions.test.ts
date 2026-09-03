import { describe, expect, test } from "bun:test";
import {
  assembleRunSystemPrompt,
  buildRunInstructions,
  buildSessionContext,
} from "./run-instructions";

describe("buildRunInstructions", () => {
  test("limits automatic reviewers to unattended automation pull requests", async () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      hasSession: true,
      prReviewer: "tellahq/super-developers",
    });

    expect(prompt).toContain(
      "For a PR this unattended automation creates, request `tellahq/super-developers` as reviewer.",
    );
    expect(prompt).toContain(
      "Never add this automatic reviewer to an existing PR or a human-steered PR.",
    );

    const automationSource = await Bun.file(
      new URL("./automations.ts", import.meta.url),
    ).text();
    const interactiveSource = await Bun.file(
      new URL("./run-session.ts", import.meta.url),
    ).text();
    expect(automationSource).toContain("prReviewer: automation.prReviewer");
    expect(interactiveSource).not.toContain("prReviewer:");
  });

  test("names the model worker sessions must use", () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      orchestrator: {
        presetLabel: "Orchestrator · Fable + Sol",
        mainLabel: "Fable 5.1",
        workers: [
          {
            role: "Implementation worker",
            model: "pi/openai/gpt-5.6-sol",
            modelLabel: "GPT-5.6 Sol",
          },
        ],
      },
    });

    expect(prompt).toContain(
      "Implementation worker: GPT-5.6 Sol via `pi/openai/gpt-5.6-sol`",
    );
    expect(prompt).toContain("opensession-sessions spawn_task");
  });

  test("keeps a standard interactive prompt minimal", () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      hasSession: true,
      inProcessMcp: {
        "opensession-sessions": {},
        "opensession-portals": {},
      },
    });

    expect(prompt.match(/^## .+$/gm)).toEqual([
      "## Data handling",
      "## Finish your turns",
      "## References",
      "## Working directory",
      "## PR attribution",
      "## New sessions",
      "## Preview links",
      "## Media",
    ]);
    expect(prompt).toContain(
      "For PRs outside the current primary repository, write `<repo>#<number>`, never bare `#<number>`.",
    );
    expect(prompt).toContain("`tella-stage` `lease_editor_fixture`");
    expect(prompt).toContain("this Open Session id as `leaseKey`");
    expect(prompt).toContain("Pass only its `leaseId`");
    expect(prompt).toContain("verifies the lease directly with Tella");
    expect(prompt.length).toBeLessThan(1_300);
  });

  test("carries no per-session facts", () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      hasSession: true,
      inProcessMcp: { "opensession-sessions": {} },
    });
    expect(prompt).not.toContain("/session/");
    expect(prompt).toContain("attribution footer from the session context");
  });
});

describe("buildSessionContext", () => {
  test("carries the link, cwd and PR footer the prompt omits", () => {
    const ctx = buildSessionContext({
      osSessionId: "os-test",
      cwd: "/home/u/worktrees/x",
      isAsk: false,
      user: "jaap",
      author: { name: "Jaap Frolich", email: "jaap@example.com" },
      githubUserLogin: "jfrolich",
    });
    expect(ctx).toContain("session: ");
    expect(ctx).toContain("/session/os-test");
    expect(ctx).toContain("Working directory: /home/u/worktrees/x");
    expect(ctx).toMatch(
      /PR attribution footer: Started by Jaap Frolich in \[this .* session\]\(.*\/session\/os-test\)/,
    );
    expect(ctx).toContain(
      "PRs use @jfrolich's account; do not add an assignee.",
    );
  });

  test("skips PR attribution for ask, scratch and code storage runs", () => {
    for (const input of [
      { isAsk: true },
      { isAsk: false, isScratch: true },
      { isAsk: false, repoHost: "codestorage" as const },
    ]) {
      const ctx = buildSessionContext({
        osSessionId: "os-test",
        cwd: "/w",
        author: { name: "Jaap Frolich", email: "jaap@example.com" },
        ...input,
      });
      expect(ctx).toContain("/session/os-test");
      expect(ctx).not.toContain("PR attribution");
    }
  });
});

describe("assembleRunSystemPrompt", () => {
  const piBase = (cwd: string) =>
    "You are an expert coding assistant.\n\n<project_context>\n\n" +
    `<project_instructions path="${cwd}/AGENTS.md">\nDefault to Bun.\n</project_instructions>\n\n` +
    "</project_context>\n\n<available_skills>\n  <skill>\n" +
    `    <location>${cwd}/.claude/skills/deslop/SKILL.md</location>\n  </skill>\n  <skill>\n` +
    "    <location>/srv/release/.agents/skills/shipped/SKILL.md</location>\n  </skill>\n" +
    `</available_skills>\nCurrent working directory: ${cwd}`;

  test("sends the same bytes from every worktree of a repo", () => {
    const a = assembleRunSystemPrompt({
      base: piBase("/home/u/worktrees/a"),
      cwd: "/home/u/worktrees/a",
      instructions: "## Media\nShow results.",
    });
    const b = assembleRunSystemPrompt({
      base: piBase("/home/u/projects/opensession"),
      cwd: "/home/u/projects/opensession",
      instructions: "## Media\nShow results.",
    });
    expect(a).toBe(b);
    expect(a).toContain('<project_instructions path="AGENTS.md">');
    expect(a).toContain("<location>.claude/skills/deslop/SKILL.md</location>");
    expect(a).toContain(
      "<location>/srv/release/.agents/skills/shipped/SKILL.md</location>",
    );
    expect(a).not.toContain("Current working directory");
    expect(a).not.toContain("/home/u/");
    expect(a.endsWith("</available_skills>\n\n## Media\nShow results.")).toBe(
      true,
    );
  });

  test("keeps an unrecognized base intact", () => {
    expect(
      assembleRunSystemPrompt({
        base: "custom prompt",
        cwd: "/w",
        instructions: "rules",
      }),
    ).toBe("custom prompt\n\nrules");
    expect(
      assembleRunSystemPrompt({
        base: undefined,
        cwd: "/w",
        instructions: "rules",
      }),
    ).toBe("rules");
  });
});
