import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildChildSessionPrompt,
  cancelTaskImpl,
  createSessionsMcpServer,
  formatSessionLine,
  resolveSpawnDepth,
  sessionMatchesCreatedBy,
  sessionMessagePayload,
  spawnTaskImpl,
  taskStateOf,
  taskStatusImpl,
  workerReportPayload,
  MAX_SPAWN_DEPTH,
  type SpawnTaskDeps,
  type SessionsToolContext,
} from "./sessions-tools";
import {
  registerSessionControl,
  type SessionControl,
  type SessionSummary,
} from "../../server/session-control";

describe("buildChildSessionPrompt", () => {
  it("adds parent report-back instructions for visible worker sessions", () => {
    const prompt = buildChildSessionPrompt({
      prompt: "Inspect the failing tests and summarize the fix.",
      parentSessionId: "bks-parent",
      reportBack: true,
    });

    expect(prompt).toContain("Inspect the failing tests");
    expect(prompt).toContain("worker session delegated by another");
    expect(prompt).toContain(
      "report back to the parent/orchestrator session `bks-parent`",
    );
    expect(prompt).toContain("send_to_session");
  });

  it("asks for judgement and dead ends, not the file list the server computes", () => {
    const prompt = buildChildSessionPrompt({
      prompt: "Fix the flaky test.",
      parentSessionId: "bks-parent",
      reportBack: true,
    });

    expect(prompt).toContain("appended to your report automatically");
    expect(prompt).toContain("do not re-list");
    expect(prompt).toContain("did NOT work");
    // The old prompt asked the model to enumerate facts it would only be
    // paraphrasing — that job moved to handoff-evidence.ts.
    expect(prompt).not.toContain("produce a concise result with files changed");
  });

  it("omits report-back instructions for standalone sessions", () => {
    const prompt = buildChildSessionPrompt({
      prompt: "Run a standalone investigation.",
      parentSessionId: "bks-parent",
      reportBack: false,
    });

    expect(prompt).toContain("Run a standalone investigation.");
    expect(prompt).not.toContain("send_to_session");
  });
});

describe("sessionMessagePayload", () => {
  it("marks every agent-authored delivery for notice rendering", () => {
    for (const message of [
      "Heads-up from another session: a commit landed.",
      "Please continue with the implementation.",
    ]) {
      expect(sessionMessagePayload(message)).toBe(
        `<!--os:session-notice-->\n${message}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// spawn_task / task_status / cancel_task
// ---------------------------------------------------------------------------

interface Harness {
  deps: SpawnTaskDeps;
  created: Parameters<SessionControl["createSession"]>[0][];
  files: Map<string, Record<string, unknown>>;
  sessions: Map<string, Partial<SessionSummary>>;
  stamped: Array<{ id: string; depth: number }>;
  cancelled: string[];
  deliveries: Array<{
    id: string;
    content: string;
    user?: string;
    opts?: Parameters<SessionControl["deliverToSession"]>[3];
  }>;
}

let uniq = 0;

/** Fully stubbed deps: no live server, no real session files, no real runs.
 *  createSession resolves instantly with a fresh id and NEVER signals run
 *  completion — spawnTaskImpl resolving at all proves it doesn't wait. */
function makeHarness(childId?: string): Harness {
  const created: Harness["created"] = [];
  const files = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Partial<SessionSummary>>();
  const stamped: Harness["stamped"] = [];
  const cancelled: string[] = [];
  const deliveries: Harness["deliveries"] = [];
  const id = childId ?? `bks-test-child-${++uniq}`;
  const control = {
    listSessions: () => [...sessions.values()] as SessionSummary[],
    getSession: (sid: string) =>
      sessions.get(sid) as SessionSummary | undefined,
    transcriptTail: async () => [],
    answerQuestion: () => false,
    deliverToSession: async (sid, content, user, opts) => {
      deliveries.push({ id: sid, content, user, opts });
      return {
        status: "started" as const,
        message: "Started.",
        deliveryId: opts?.deliveryId,
      };
    },
    cancelSession: (sid: string) => {
      cancelled.push(sid);
      return true;
    },
    createSession: async (opts: Harness["created"][0]) => {
      created.push(opts);
      return {
        id,
        createdBy: opts.user || "Open Session",
        createdAt: "2026-08-06T10:00:00.000Z",
      };
    },
  } satisfies SessionControl;
  return {
    deps: {
      control,
      readSessionFile: (sid) => files.get(sid) ?? null,
      stampSpawnDepth: (sid, depth) => {
        stamped.push({ id: sid, depth });
      },
    },
    created,
    files,
    sessions,
    stamped,
    cancelled,
    deliveries,
  };
}

const ctx = (currentSessionId?: string): SessionsToolContext => ({
  createdBy: "Alex",
  isAdmin: true,
  currentSessionId,
});

async function settle() {
  // stampSpawnDepth is fired without being awaited; let microtasks drain.
  await new Promise((r) => setTimeout(r, 0));
}

describe("spawnTaskImpl", () => {
  it("returns {taskId, url} immediately via the createSession code path, without waiting for the run", async () => {
    const h = makeHarness();
    const parent = `bks-test-parent-${++uniq}`;
    h.files.set(parent, { id: parent });
    const started = Date.now();
    const res = await spawnTaskImpl(
      { prompt: "Investigate the flaky test.", mode: "ask" },
      ctx(parent),
      h.deps,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Date.now() - started).toBeLessThan(500);
    expect(res.taskId).toStartWith("bks-test-child-");
    expect(res.url).toContain(`/session/${res.taskId}`);
    // Same code path as create_session: worker preamble + report-back, child
    // linked to the parent, user inherited.
    expect(h.created).toHaveLength(1);
    expect(h.created[0].prompt).toContain("Investigate the flaky test.");
    expect(h.created[0].prompt).toContain(
      "worker session delegated by another",
    );
    expect(h.created[0].prompt).toContain(
      `report back to the parent/orchestrator session \`${parent}\``,
    );
    expect(h.created[0].parentSessionId).toBe(parent);
    expect(h.created[0].user).toBe("Alex");
    expect(h.created[0].mode).toBe("ask");
    expect(res.createdBy).toBe("Alex");
    expect(res.createdAt).toBe("2026-08-06T10:00:00.000Z");
  });

  it("tags the child with spawnDepth = parent depth + 1", async () => {
    const h = makeHarness();
    const parent = `bks-test-parent-${++uniq}`;
    h.files.set(parent, { id: parent, spawnDepth: 1 });
    const res = await spawnTaskImpl(
      { prompt: "Do a thing.", mode: "ask" },
      ctx(parent),
      h.deps,
    );
    expect(res.ok).toBe(true);
    await settle();
    expect(h.stamped).toEqual([
      { id: (res as { taskId: string }).taskId, depth: 2 },
    ]);
  });

  it(`refuses at depth ≥ ${MAX_SPAWN_DEPTH} (loop guard)`, async () => {
    const h = makeHarness();
    const grandchild = `bks-test-grandchild-${++uniq}`;
    h.files.set(grandchild, { id: grandchild, spawnDepth: MAX_SPAWN_DEPTH });
    const res = await spawnTaskImpl(
      { prompt: "Delegate further.", mode: "ask" },
      ctx(grandchild),
      h.deps,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("spawn_task refused");
    expect(res.error).toContain("spawn hops");
    expect(h.created).toHaveLength(0);
  });

  it("bounds depth through the in-memory map before the child's file exists", async () => {
    // parent (depth 0) → child (1) → grandchild (2) → refused, with NO child
    // session files at all: the in-process map alone must carry the guard.
    const h1 = makeHarness(`bks-test-c1-${++uniq}`);
    const parent = `bks-test-root-${++uniq}`;
    const r1 = await spawnTaskImpl(
      { prompt: "level 1", mode: "ask" },
      ctx(parent),
      h1.deps,
    );
    expect(r1.ok).toBe(true);
    const child = (r1 as { taskId: string }).taskId;
    expect(resolveSpawnDepth(child, h1.deps)).toBe(1);

    const h2 = makeHarness(`bks-test-c2-${++uniq}`);
    const r2 = await spawnTaskImpl(
      { prompt: "level 2", mode: "ask" },
      ctx(child),
      h2.deps,
    );
    expect(r2.ok).toBe(true);
    const grandchild = (r2 as { taskId: string }).taskId;
    expect(resolveSpawnDepth(grandchild, h2.deps)).toBe(2);

    const h3 = makeHarness();
    const r3 = await spawnTaskImpl(
      { prompt: "level 3", mode: "ask" },
      ctx(grandchild),
      h3.deps,
    );
    expect(r3.ok).toBe(false);
    expect(h3.created).toHaveLength(0);
  });

  it("refuses when the calling session is automation-owned (all three detection paths)", async () => {
    // automation field on the session file
    const h1 = makeHarness();
    const a1 = `bks-test-auto-${++uniq}`;
    h1.files.set(a1, { id: a1, automation: "plain-triage" });
    const r1 = await spawnTaskImpl(
      { prompt: "x", mode: "ask" },
      ctx(a1),
      h1.deps,
    );
    expect(r1.ok).toBe(false);
    expect((r1 as { error: string }).error).toContain("automation");

    // legacy createdBy "(automation)" suffix
    const h2 = makeHarness();
    const a2 = `bks-test-auto-${++uniq}`;
    h2.files.set(a2, { id: a2, createdBy: "triage (automation)" });
    const r2 = await spawnTaskImpl(
      { prompt: "x", mode: "ask" },
      ctx(a2),
      h2.deps,
    );
    expect(r2.ok).toBe(false);

    // automation on the registry summary (non-file sources)
    const h3 = makeHarness();
    const a3 = `bks-test-auto-${++uniq}`;
    h3.sessions.set(a3, { id: a3, automation: "sweeper" });
    const r3 = await spawnTaskImpl(
      { prompt: "x", mode: "ask" },
      ctx(a3),
      h3.deps,
    );
    expect(r3.ok).toBe(false);
    expect(h1.created.length + h2.created.length + h3.created.length).toBe(0);
  });

  it("requires a branch for code mode unless the parent's code worktree is sharable", async () => {
    const h = makeHarness();
    const parent = `bks-test-parent-${++uniq}`;
    h.files.set(parent, { id: parent });
    // ask-mode parent → no worktree to share → refuse without a branch
    h.sessions.set(parent, { id: parent, mode: "ask" });
    const r1 = await spawnTaskImpl({ prompt: "x" }, ctx(parent), h.deps);
    expect(r1.ok).toBe(false);
    expect((r1 as { error: string }).error).toContain("branch");
    // code-mode parent in the same repo → sharable → allowed without a branch
    h.sessions.set(parent, {
      id: parent,
      mode: "code",
      worktreeDir: "/home/ubuntu/worktrees/x",
      repo: "tella-fusion",
    });
    const r2 = await spawnTaskImpl({ prompt: "x" }, ctx(parent), h.deps);
    expect(r2.ok).toBe(true);
    expect(h.created[0].mode).toBe("code");
    // explicit branch always works
    const r3 = await spawnTaskImpl(
      { prompt: "x", branch: "task/foo" },
      ctx(parent),
      h.deps,
    );
    expect(r3.ok).toBe(true);
  });

  it("allows a branchless code task to share an attached parent repo", async () => {
    const h = makeHarness();
    const parent = `bks-test-parent-${++uniq}`;
    h.sessions.set(parent, {
      id: parent,
      mode: "code",
      worktreeDir: "/home/ubuntu/projects/opensession",
      repo: "opensession",
      attachedRepos: [
        {
          repo: "tella-fusion",
          dir: "/home/ubuntu/worktrees/tella-fusion-task",
          branch: "task",
        },
      ],
    });

    const explicit = await spawnTaskImpl(
      { prompt: "Review the implementation.", repo: "tella-fusion" },
      ctx(parent),
      h.deps,
    );
    expect(explicit.ok).toBe(true);

    const inferred = await spawnTaskImpl(
      { prompt: "Review /home/ubuntu/worktrees/tella-fusion-task." },
      ctx(parent),
      h.deps,
    );
    expect(inferred.ok).toBe(true);
  });

  it("accepts isolatedWorktree: a branchless code task gets its own worktree instead of sharing the parent's", async () => {
    const h = makeHarness();
    const parent = `bks-test-parent-${++uniq}`;
    h.files.set(parent, { id: parent });
    h.sessions.set(parent, {
      id: parent,
      mode: "code",
      worktreeDir: "/home/ubuntu/projects/opensession",
      repo: "opensession",
    });

    const res = await spawnTaskImpl(
      { prompt: "Fan out: fix module B.", isolatedWorktree: true },
      ctx(parent),
      h.deps,
    );
    expect(res.ok).toBe(true);
    // Forwarded so the wiring mints a per-branch worktree (branch generated
    // from the prompt by the durable create plan) while keeping child linkage.
    expect(h.created[0].isolatedWorktree).toBe(true);
    expect(h.created[0].branch).toBeUndefined();
    expect(h.created[0].parentSessionId).toBe(parent);
  });
});

describe("session creator metadata", () => {
  const session = {
    id: "bks-test-session",
    title: "Creator metadata",
    state: "idle",
    queuedCount: 0,
    controllable: true,
    createdBy: "Alex Rivera",
    createdByLogin: "arivera",
    startedBy: "legacy-alias",
    createdAt: "2026-08-06T09:30:00.000Z",
    lastActivity: new Date().toISOString(),
  } as SessionSummary;

  it("renders explicit persisted identity and creation timestamp fields", () => {
    const line = formatSessionLine(session);
    expect(line).toContain('createdBy="Alex Rivera"');
    expect(line).toContain('createdByLogin="arivera"');
    expect(line).toContain("createdAt=2026-08-06T09:30:00.000Z");
    expect(line).not.toContain("legacy-alias");
  });

  it("matches display identity or verified login exactly and case-insensitively", () => {
    expect(sessionMatchesCreatedBy(session, "alex rivera")).toBe(true);
    expect(sessionMatchesCreatedBy(session, "ARIVERA")).toBe(true);
    expect(sessionMatchesCreatedBy(session, "Alex")).toBe(false);
  });

  it("falls back to the legacy alias but never guesses from title", () => {
    const legacy = {
      ...session,
      createdBy: null,
      createdByLogin: undefined,
      startedBy: "Kent",
      title: "Michiel's session",
    } as SessionSummary;
    expect(sessionMatchesCreatedBy(legacy, "Kent")).toBe(true);
    expect(sessionMatchesCreatedBy(legacy, "Michiel")).toBe(false);
    expect(
      formatSessionLine({ ...legacy, startedBy: null } as SessionSummary),
    ).toContain("createdBy=null");
  });

  it("exposes and applies createdBy on the shared interactive MCP surface", async () => {
    const h = makeHarness();
    h.sessions.set(session.id, session);
    h.sessions.set("bks-other", {
      ...session,
      id: "bks-other",
      createdBy: "Other Person",
      createdByLogin: "other",
    });
    registerSessionControl(h.deps.control);
    const server = createSessionsMcpServer(ctx());
    const client = new Client({
      name: "sessions-tools-test",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listedTools = await client.listTools();
      const listTool = listedTools.tools.find(
        (tool) => tool.name === "list_sessions",
      );
      expect(listTool?.inputSchema.properties).toHaveProperty("createdBy");
      expect(listedTools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["wait_for", "wait_status", "cancel_wait"]),
      );

      const result = await client.callTool({
        name: "list_sessions",
        arguments: { createdBy: "ARIVERA" },
      });
      const output = (
        result as { content: Array<{ type: string; text: string }> }
      ).content[0].text;
      expect(output).toContain("bks-test-session");
      expect(output).toContain('createdBy="Alex Rivera"');
      expect(output).toContain('createdByLogin="arivera"');
      expect(output).toContain("createdAt=2026-08-06T09:30:00.000Z");
      expect(output).not.toContain("bks-other");
    } finally {
      await client.close();
      await server.instance.close();
    }
  });

  it("delegates omitted branch generation to the durable create plan", async () => {
    const h = makeHarness();
    registerSessionControl(h.deps.control);
    const server = createSessionsMcpServer(ctx("bks-parent"), {
      branchNameFromPrompt: async () => "fix-session-branch-ux",
    });
    const client = new Client({
      name: "sessions-tools-test",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listedTools = await client.listTools();
      const createTool = listedTools.tools.find(
        (tool) => tool.name === "create_session",
      );
      const branchSchema = createTool?.inputSchema.properties?.branch as
        | { description?: string }
        | undefined;
      expect(branchSchema?.description).toContain("generated from the prompt");

      const result = await client.callTool({
        name: "create_session",
        arguments: {
          prompt: "Fix branch generation for Desk child sessions",
          mode: "code",
          repo: "tella-fusion",
        },
      });
      const output = (
        result as { content: Array<{ type: string; text: string }> }
      ).content[0].text;
      expect(h.created[0].branch).toBeUndefined();
      expect(output).toContain("code session");
    } finally {
      await client.close();
      await server.instance.close();
    }
  });

  it("exposes isolatedWorktree on create_session and forwards it to createSession", async () => {
    const h = makeHarness();
    registerSessionControl(h.deps.control);
    const server = createSessionsMcpServer(ctx("bks-parent"));
    const client = new Client({
      name: "sessions-tools-test",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listedTools = await client.listTools();
      const createTool = listedTools.tools.find(
        (tool) => tool.name === "create_session",
      );
      // The server capability exists (SessionControlCreateInput); the MCP
      // adapter must expose it or matching-repo children always share the
      // parent worktree from the agent's perspective.
      expect(createTool?.inputSchema.properties).toHaveProperty(
        "isolatedWorktree",
      );

      await client.callTool({
        name: "create_session",
        arguments: {
          prompt: "Fan out: fix the lint errors in module A.",
          mode: "code",
          isolatedWorktree: true,
        },
      });
      // Forwarded to SessionControl.createSession, with child linkage intact.
      expect(h.created[0].isolatedWorktree).toBe(true);
      expect(h.created[0].parentSessionId).toBe("bks-parent");
      expect(h.created[0].reportBack).toBe(true);
    } finally {
      await client.close();
      await server.instance.close();
    }
  });

  it("keeps create_session results in the user's workspaces", async () => {
    const h = makeHarness();
    registerSessionControl(h.deps.control);
    const server = createSessionsMcpServer(ctx("bks-parent"));
    const client = new Client({
      name: "sessions-tools-test",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({
        name: "create_session",
        arguments: { prompt: "Write a throwaway fixture.", standalone: true },
      });
      // Standalone controls workspace linkage, not sidebar ownership: a
      // visible create_session result is still work created for the user.
      expect(h.created[0].parentSessionId).toBeUndefined();
      expect(h.created[0].spawnedBy).toBeUndefined();

      await client.callTool({
        name: "create_session",
        arguments: { prompt: "Delegate the migration." },
      });
      expect(h.created[1].parentSessionId).toBe("bks-parent");
      expect(h.created[1].spawnedBy).toBeUndefined();
    } finally {
      await client.close();
      await server.instance.close();
    }
  });

  it("gives cross-session messages agent provenance and a stable receipt", async () => {
    const h = makeHarness();
    registerSessionControl(h.deps.control);
    const server = createSessionsMcpServer(ctx("bks-sender"));
    const client = new Client({
      name: "sessions-tools-test",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "send_to_session",
        arguments: {
          id: "bks-target",
          message: "Please inspect the failing test.",
          delivery_id: "delivery-test-1",
        },
      });
      const output = (
        result as { content: Array<{ type: string; text: string }> }
      ).content[0].text;
      expect(output).toContain("delivery-test-1");
      expect(output).toContain("status=started");
      expect(h.deliveries).toHaveLength(1);
      expect(h.deliveries[0]).toMatchObject({
        id: "bks-target",
        content: "<!--os:session-notice-->\nPlease inspect the failing test.",
        user: "agent bks-sender",
        opts: { deliveryId: "delivery-test-1" },
      });
    } finally {
      await client.close();
      await server.instance.close();
    }
  });
});

describe("task_status / cancel_task", () => {
  const summary = (over: Partial<SessionSummary>): Partial<SessionSummary> => ({
    id: "bks-test-task",
    title: "Test task",
    state: "idle",
    queuedCount: 0,
    controllable: true,
    lastActivity: new Date().toISOString(),
    ...over,
  });

  it("maps session states onto task states", () => {
    expect(taskStateOf(summary({ state: "running" }) as SessionSummary)).toBe(
      "running",
    );
    expect(taskStateOf(summary({ state: "queued" }) as SessionSummary)).toBe(
      "running",
    );
    expect(
      taskStateOf(summary({ state: "waiting_question" }) as SessionSummary),
    ).toBe("waiting");
    expect(taskStateOf(summary({ state: "idle" }) as SessionSummary)).toBe(
      "done",
    );
    expect(
      taskStateOf(
        summary({
          state: "idle",
          lastRunError: { message: "boom", at: "" },
        }) as SessionSummary,
      ),
    ).toBe("error");
  });

  it("reports state, PR and transcript tail; unknown ids are a clear miss", async () => {
    const h = makeHarness();
    h.sessions.set(
      "bks-test-task",
      summary({
        state: "running",
        prUrl: "https://github.com/x/y/pull/1",
        prState: "OPEN",
      }),
    );
    const out = await taskStatusImpl({ taskId: "bks-test-task" }, h.deps);
    expect(out).toContain("*running*");
    expect(out).toContain("https://github.com/x/y/pull/1");
    expect(out).toContain("Recent transcript");
    expect(await taskStatusImpl({ taskId: "bks-nope" }, h.deps)).toContain(
      "No task/session",
    );
  });

  it("cancel_task cancels through the registry", async () => {
    const h = makeHarness();
    expect(await cancelTaskImpl({ taskId: "bks-test-task" }, h.deps)).toContain(
      "Cancelled",
    );
    expect(h.cancelled).toEqual(["bks-test-task"]);
  });
});

// ---------------------------------------------------------------------------
// Worker → parent handoff
// ---------------------------------------------------------------------------

describe("workerReportPayload", () => {
  const ctx = { createdBy: "Alex", currentSessionId: "bks-child" };
  const deps = {
    parentOf: (id: string) => (id === "bks-child" ? "bks-parent" : undefined),
    evidence: async () => "— evidence —\nfiles changed: 1 file(s)",
    stampReported: () => {},
  };

  it("staples the server's evidence onto a report to the parent", async () => {
    const out = await workerReportPayload(
      "bks-parent",
      "Done; the fix holds.",
      ctx,
      deps,
    );
    expect(out.content).toContain("Done; the fix holds.");
    expect(out.content).toContain("files changed: 1 file(s)");
  });

  it("attributes the report to the worker, not to the human it inherited", async () => {
    // "[Alex] ..." reads to the parent model like a human instruction.
    const out = await workerReportPayload("bks-parent", "Done.", ctx, deps);
    expect(out.user).toBe("worker bks-child");
  });

  it("records the report so the failure beacon stays quiet", async () => {
    const stamped: string[] = [];
    await workerReportPayload("bks-parent", "Done.", ctx, {
      ...deps,
      stampReported: (id) => stamped.push(id),
    });
    expect(stamped).toEqual(["bks-child"]);
  });

  it("leaves messages to any other session untouched", async () => {
    const out = await workerReportPayload(
      "bks-someone-else",
      "ping",
      ctx,
      deps,
    );
    expect(out).toEqual({ content: "ping", user: "agent bks-child" });
  });

  it("preserves provenance for a non-worker agent's messages", async () => {
    const out = await workerReportPayload(
      "bks-parent",
      "ping",
      { createdBy: "Alex", currentSessionId: "bks-root" },
      deps,
    );
    expect(out).toEqual({ content: "ping", user: "agent bks-root" });
  });

  it("still delivers the prose when evidence can't be computed", async () => {
    const out = await workerReportPayload("bks-parent", "Done.", ctx, {
      ...deps,
      evidence: async () => {
        throw new Error("git blew up");
      },
    });
    expect(out.content).toBe("Done.");
    expect(out.user).toBe("agent bks-child");
  });

  it("caps the appended block so a handoff can't refill the parent's context", async () => {
    const out = await workerReportPayload("bks-parent", "Done.", ctx, {
      ...deps,
      evidence: async () => "x".repeat(20_000),
    });
    expect(out.content.length).toBeLessThan(4200);
  });
});
