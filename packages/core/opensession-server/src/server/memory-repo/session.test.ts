/**
 * What a session is told about memory, and where: the system prompt gets a
 * section that cannot change between turns, and each turn's context gets the
 * list of entry points to read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { __setIdentitiesForTest } from "../shared/user-mappings";
import { __setMemoryRepoServiceForTest } from "./client";
import type { MemoryRepoService } from "./service";
import {
  renderMemoryEntryPoints,
  renderRepoMemoryNote,
  retrieveRepoMemoryForPrompt,
} from "./session";

const FILES: Record<string, string> = {
  "team:MEMORY.md": "# Memory: Workspace\n- Team fact.\n",
  "team:repos/acme/MEMORY.md": "# Memory: acme\n- Repo fact.\n",
  "user-UADA000001:MEMORY.md": "# Memory: Ada\n- Ada's preference.\n",
  "user-UGRACE0001:MEMORY.md": "# Memory: Grace\n- Grace's preference.\n",
  // Headings only: says nothing, so it is not worth a read.
  "user-UEMPTY0001:MEMORY.md": "# Memory: Empty\n\n## Index\n",
};

let restoreIdentities: () => void;

beforeAll(() => {
  restoreIdentities = __setIdentitiesForTest([
    { name: "Ada Lovelace", email: "ada@example.test", slackId: "UADA000001" },
    {
      name: "Grace Hopper",
      email: "grace@example.test",
      slackId: "UGRACE0001",
    },
  ]);
  __setMemoryRepoServiceForTest({
    opts: { base: "/nowhere" },
    async entryPoints(files: Array<{ repo: string; path: string }>) {
      return files.flatMap((file) => {
        const text = FILES[`${file.repo}:${file.path}`];
        return text ? [{ ...file, text }] : [];
      });
    },
  } as unknown as MemoryRepoService);
});

afterAll(() => {
  __setMemoryRepoServiceForTest(null);
  restoreIdentities();
});

describe("renderRepoMemoryNote", () => {
  // The section is system prompt text. Its inputs are the whole guard: it
  // is given no person, no list of repositories and no memory content, so
  // none of them can change it from one turn to the next.
  test("is the same for a session whoever prompts and whatever memory holds", () => {
    const note = renderRepoMemoryNote({
      root: "/scratch/os-1/memory",
      sessionLink: "https://example.test/session/os-1",
    });
    expect(note).toStartWith("## Memory\n");
    expect(note).toContain("under `/scratch/os-1/memory/`");
    expect(note).toContain("Read them all with one tool call");
    expect(note).toContain("source: https://example.test/session/os-1;");
    expect(note).toContain("Commit and push after every edit");
    for (const absent of [
      "person prompting",
      "Ada",
      "UADA000001",
      "Team fact",
      "as of this session's start",
    ])
      expect(note).not.toContain(absent);
  });

  test("a run without a checkout is pointed at the memory tools", () => {
    const note = renderRepoMemoryNote({ tools: true });
    expect(note).toContain("This run has no local checkout");
    expect(note).toContain("Read them with `read_memory_file`");
    expect(note).toContain("`write_memory_file`");
    expect(note).not.toContain("git -C");
  });
});

describe("renderMemoryEntryPoints", () => {
  const scopes = ["user-UADA000001", "repo-acme", "workspace"];

  test("lists what to read, most specific first, and whose memory is whose", async () => {
    expect(
      await renderMemoryEntryPoints({
        scopeKeys: scopes,
        root: "/scratch/os-1/memory",
        present: ["team", "user-UADA000001", "user-UGRACE0001"],
        user: "Ada Lovelace",
      }),
    ).toBe(
      [
        "Memory entry points, most specific first. They are not in your prompt: read them with a tool call unless their contents are already in this conversation.",
        "- `/scratch/os-1/memory/user-UADA000001/MEMORY.md`: Ada Lovelace's personal memory (the person prompting)",
        "- `/scratch/os-1/memory/user-UGRACE0001/MEMORY.md`: Grace Hopper's personal memory",
        "- `/scratch/os-1/memory/team/repos/acme/MEMORY.md`: team memory, repos/acme",
        "- `/scratch/os-1/memory/team/MEMORY.md`: team memory",
      ].join("\n"),
    );
  });

  test("the order does not follow the order checkouts were made in", async () => {
    const list = (present: string[]) =>
      renderMemoryEntryPoints({
        scopeKeys: scopes,
        root: "/m",
        present,
        user: "Ada Lovelace",
      });
    expect(await list(["user-UGRACE0001", "team", "user-UADA000001"])).toBe(
      await list(["user-UADA000001", "user-UGRACE0001", "team"]),
    );
  });

  test("follows the prompter, skips files that say nothing, and names files for the tools without a checkout", async () => {
    const text = await renderMemoryEntryPoints({
      scopeKeys: ["user-UGRACE0001", "workspace"],
      present: ["user-UADA000001", "user-UEMPTY0001"],
      user: "Grace Hopper",
    });
    expect(text).toContain(
      "- `user-UGRACE0001:MEMORY.md`: Grace Hopper's personal memory (the person prompting)",
    );
    expect(text).toContain(
      "- `user-UADA000001:MEMORY.md`: Ada Lovelace's personal memory\n",
    );
    expect(text).not.toContain("UEMPTY0001");
    expect(
      await renderMemoryEntryPoints({
        scopeKeys: ["user-UEMPTY0001"],
        present: [],
      }),
    ).toBe("");
  });
});

test("a turn with nothing to search for still gets its entry points, fenced", async () => {
  const { text, ids } = await retrieveRepoMemoryForPrompt(
    "  ",
    ["workspace"],
    undefined,
    "Memory entry points: one",
  );
  expect(ids).toEqual([]);
  expect(text).toContain("Memory entry points: one");
  expect(text).toMatch(/^<[^>]*memory[^>]*>/);
  expect((await retrieveRepoMemoryForPrompt("", ["workspace"])).text).toBe("");
});
