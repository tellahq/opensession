import { describe, expect, test } from "bun:test";
import {
  assembleRunSystemPrompt,
  buildRunInstructions,
  buildSessionContext,
} from "./run-instructions";

describe("buildRunInstructions", () => {
  test("preserves attribution without imposing a blanket Git publishing restriction", () => {
    const prompt = buildRunInstructions({ isAsk: false, hasSession: true });

    expect(prompt).toContain(
      "End each PR body with the attribution footer from the session context and follow its assignee rule.",
    );
    expect(prompt).toContain(
      "Add the `Co-authored-by` trailer from the session context to every commit.",
    );
    expect(prompt).not.toContain(
      "Never merge, approve, or push the default branch.",
    );
  });

  // Runs answered a pasted screenshot with "upload it in the session's Assets
  // tab", a step no person can take. With the assets tools wired, the standing
  // instructions say where a chat attachment lands and that Assets is not an
  // inbox; without them there is no Assets tab to be misled by.
  test("explains chat attachments and that nobody can upload to Assets", () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      hasSession: true,
      inProcessMcp: { "opensession-assets": {} },
    });
    expect(prompt).toContain("## Attachments");
    expect(prompt).toContain(
      "every file saved to disk at the path a note on that turn lists",
    );
    expect(prompt).toContain("nobody can upload there, so never ask for that");
    expect(prompt).not.toContain("not reachable from the Sandbox");

    const sandboxed = buildRunInstructions({
      isAsk: true,
      sandboxed: true,
      inProcessMcp: { "opensession-assets": {} },
    });
    expect(sandboxed).toContain(
      "Open Session host paths are not reachable from the Sandbox; use the scratch copies the note lists.",
    );

    expect(
      buildRunInstructions({ isAsk: false, hasSession: true }),
    ).not.toContain("## Attachments");
  });

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

  test("names the read token and the sibling repositories it covers", async () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      hasSession: true,
      readRepos: ["tellahq/api", "tellahq/web"],
    });
    expect(prompt).toContain("## Cross-repository reads");
    expect(prompt).toContain(
      "`GH_READ_TOKEN` in the shell is a read-only GitHub token covering this repository and `tellahq/api`, `tellahq/web`.",
    );
    expect(prompt).toContain("GH_TOKEN=$GH_READ_TOKEN gh pr list --repo");
    expect(
      buildRunInstructions({ isAsk: false, hasSession: true }),
    ).not.toContain("GH_READ_TOKEN");

    // Only automations carry the list; an interactive turn never mints a
    // second token.
    const automationSource = await Bun.file(
      new URL("./automations.ts", import.meta.url),
    ).text();
    const interactiveSource = await Bun.file(
      new URL("./run-session.ts", import.meta.url),
    ).text();
    expect(automationSource).toContain("readRepos: automation.readRepos");
    expect(interactiveSource).not.toContain("readRepos:");
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
      "## Pull requests",
      "## Tools",
      "## Portals",
      "## Media",
    ]);
    expect(prompt).toContain(
      "For PRs outside the current primary repository, write `<repo>#<number>`, never bare `#<number>`. " +
        "A bare `#<number>` reads as a PR; write GitHub issues as `issue #<number>`.",
    );
    // Every MCP tool hides behind mcp_search; the Tools section is the only
    // way a run learns a tool exists before it knows to search for it, and it
    // names only the servers this run carries.
    expect(prompt).toContain(
      "- `opensession-sessions`: Create, inspect, steer, or cancel",
    );
    expect(prompt).toContain("`suggest_task` is only for a drive-by finding");
    expect(prompt).toContain("- `opensession-portals`: ");
    expect(prompt).not.toContain("`opensession-memory`");
    expect(prompt).toContain("`tella-stage` `lease_editor_fixture`");
    expect(prompt).toContain("this Open Session id as `leaseKey`");
    expect(prompt).toContain("pass only its `leaseId`");
    expect(prompt).not.toContain("## Sandbox");
    expect(prompt).toContain(
      "Follow repository branching and publication rules.",
    );
    expect(prompt).not.toContain(
      "Never merge, approve, or push the default branch",
    );
    expect(prompt).not.toContain("open_pull_request");
    // The Media section names every block form the transcript renders live,
    // and Tools names what each mounted server is for: the two things a run
    // cannot learn from a skill or from mcp_search without already knowing
    // they exist. Two servers mounted here; a full interactive mount adds
    // roughly 150 chars per server on top.
    expect(prompt.length).toBeLessThan(3_000);
  });

  test("tells a sandboxed run where it is, in one shared paragraph", () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      hasSession: true,
      sandboxed: true,
      inProcessMcp: { "opensession-portals": {} },
    });
    expect(prompt).toContain("## Sandbox");
    expect(prompt).toContain("Push your branch before ending");
    expect(prompt).not.toContain("## Desktop");
  });

  test("points a sandboxed run at its desktop only when the tools are there", () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      hasSession: true,
      sandboxed: true,
      inProcessMcp: {
        "opensession-portals": {},
        "opensession-desktop": {},
      },
    });
    expect(prompt).toContain("## Desktop");
    expect(prompt).toContain("`opensession-desktop`");
    expect(prompt).toContain("Desktop tab");
  });

  // A public repository's PRs and commits are readable by anyone, while the
  // run's inputs (memory, Slack, Linear, session context) are private. The
  // rule is per repo, never per session, and only code runs can publish.
  test("tells a public-repo code run what may never leave the session", () => {
    const prompt = buildRunInstructions({
      isAsk: false,
      hasSession: true,
      publicRepo: true,
    });
    expect(prompt).toContain("## Public repository");
    expect(prompt).toContain(
      "Treat the primary repository as public: its PRs, commits, branch names, comments, and files are readable by anyone.",
    );
    expect(prompt).toContain(
      "anything from memory, Slack, Linear, local instructions, or the session context",
    );
    expect(prompt).toContain(
      "The attribution footer and commit trailer from the session context are the only exception.",
    );
    expect(prompt.indexOf("## Public repository")).toBeGreaterThan(
      prompt.indexOf("## Pull requests"),
    );

    for (const input of [
      { isAsk: false, hasSession: true },
      { isAsk: false, hasSession: true, publicRepo: false },
      { isAsk: true, publicRepo: true },
      { isAsk: false, isScratch: true, publicRepo: true },
    ]) {
      expect(buildRunInstructions(input)).not.toContain("## Public repository");
    }
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
      coAuthor: "Jaap Frolich <jaap@example.com>",
    });
    expect(ctx).toContain("session: ");
    expect(ctx).toContain("/session/os-test");
    expect(ctx).toContain("Working directory: /home/u/worktrees/x");
    expect(ctx).toMatch(
      /PR attribution footer: Started by Jaap Frolich in \[this .* session\]\(.*\/session\/os-test\)/,
    );
    expect(ctx).toContain(
      "PRs use @jfrolich's account through gh; do not add an assignee.",
    );
    expect(ctx).toContain(
      "Commit trailer: Co-authored-by: Jaap Frolich <jaap@example.com>",
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
      expect(ctx).not.toContain("Co-authored-by");
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
