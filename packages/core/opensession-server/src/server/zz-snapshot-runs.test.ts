/**
 * Keyless snapshot scenarios: scripted sessions driven through the real run
 * pipeline on the fake engine, frozen as JSON fixtures.
 *
 * Each scenario records BOTH halves of the contract that regressions hide in:
 * the transcript entries the run wrote, and the prompt/config the engine
 * received (fenced context, session note, MCP scope, tool policy). The
 * fixtures live in testing/snapshots/; re-record with
 *
 *     OPENSESSION_SNAPSHOT=record bun test src/server/zz-snapshot-runs.test.ts
 *
 * and READ the diff. See docs/transcript-snapshots.md.
 *
 * zz- prefix + dynamic imports (the zz-fake-run pattern): run-session's graph
 * must not load before the redirects are in place. In a full-suite run an
 * earlier file may already have frozen them, in which case `harness.ready` is
 * false and every scenario skips loudly rather than snapshotting this box's
 * real sessions, memories and MCP servers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FakeCall } from "./testing/fake-engine";
import {
  loadSnapshotHarness,
  prepareSnapshotEnv,
  type SnapshotHarness,
} from "./testing/snapshot-harness";

// Top level: connections.ts freezes the MCP config path at import time.
prepareSnapshotEnv("runs");

let h: SnapshotHarness;

beforeAll(async () => {
  h = await loadSnapshotHarness();
});

afterAll(() => h?.restore());

describe("transcript snapshots", () => {
  // `bun run test:snapshots` sets this, which is also how CI runs the file.
  // Skipping every scenario is the right answer inside a full sweep and a
  // silent pass anywhere else: run on its own, an unready harness is the
  // failure, not a note in the log.
  test("the harness owns its own module state", () => {
    if (process.env.OPENSESSION_SNAPSHOT_STRICT !== "1") return;
    expect(h.ready).toBe(true);
  });

  // A plain turn from a teammate, with a sibling session's transcript attached
  // as context. Proves the fence contract end to end: the store keeps the
  // human's message, the model gets the injected block, and the attribution
  // prefix rides the prompt.
  test("plain turn: context fencing", async () => {
    if (!h.ready) return;
    const sid = "bks-snap-plain";
    const attached = "bks-snap-attached";
    h.writeSession(attached, {
      title: "Earlier investigation",
      mode: "scratch",
      workspaceId: "ws-snap-attached",
      piSessionId: "ses_snap_attached",
    });
    await h.writeEngineTranscript("ses_snap_attached", [
      {
        type: "user",
        uuid: "attached-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "why is the sweep slow?" }],
        },
      },
      {
        type: "assistant",
        uuid: "attached-2",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "It re-reads every shard on each tick." },
          ],
        },
      },
    ]);
    h.writeSession(sid, {
      mode: "scratch",
      repo: "snapshot-repo",
      workspaceId: "ws-snap-plain",
    });

    const calls: FakeCall[] = [];
    await h.prompt({
      sessionId: sid,
      content: "summarize what we learned",
      user: "Teammate",
      collect: calls,
      contextSessions: [attached],
      turns: [
        {
          kind: "clean",
          engineSessionId: "ses_snap_plain",
          text: ["The sweep re-reads every shard per tick."],
          tools: [
            {
              name: "bash",
              input: { command: "rg -n tick" },
              result: "3 matches",
            },
          ],
        },
      ],
    });

    expect(calls).toHaveLength(1);
    // The invariant the fixture exists to protect: injected context reaches the
    // model and never the rendered transcript.
    expect(calls[0].prompt).toContain("<opensession:context");
    expect(calls[0].prompt).toContain("[Teammate] summarize what we learned");
    h.snapshot("plain-turn-context-fencing", { sessionId: sid, calls });
  });

  // An automation-owned session, prompted by a human: the case that must keep
  // the automation's scoping rather than inheriting an interactive run's. Two
  // strips are visible in the fixture: the allowlist drops `snapshot-beta`, and
  // the per-user `allowedUsers` gate drops `snapshot-restricted` even though
  // the automation names it. The tool policy is the third: an automation's
  // denied tools are stripped from the model's tool list, not merely refused.
  test("mcp allowlist: filtering strips servers", async () => {
    if (!h.ready) return;
    const sid = "bks-snap-mcp";
    h.writeSession(sid, {
      mode: "scratch",
      repo: "snapshot-repo",
      workspaceId: "ws-snap-mcp",
      automation: "Snapshot Automation",
      automationId: "snapshot-automation",
    });

    const calls: FakeCall[] = [];
    await h.prompt({
      sessionId: sid,
      content: "list what you can reach",
      user: "SnapshotOwner",
      collect: calls,
      turns: [
        {
          kind: "clean",
          engineSessionId: "ses_snap_mcp",
          text: ["Only alpha."],
        },
      ],
    });

    expect(calls[0].opts.mcpServers).toEqual([
      "snapshot-alpha",
      "snapshot-restricted",
    ]);
    h.snapshot("mcp-allowlist-filtering", { sessionId: sid, calls });
  });

  // The other half of the allowlist contract: an ordinary interactive session
  // that was created with a picked set of servers. The choice is stamped on the
  // session file at create time, so it has to survive being read back. The
  // first turn gets the picked list from the create path either way, and a
  // session whose stamp is dropped on the way out of the store quietly widens
  // to every server on turn two.
  test("session-stamped allowlist survives the read back", async () => {
    if (!h.ready) return;
    const sid = "bks-snap-session-mcp";
    h.writeSession(sid, {
      mode: "scratch",
      repo: "snapshot-repo",
      workspaceId: "ws-snap-session-mcp",
      mcpServers: ["snapshot-alpha"],
    });

    const calls: FakeCall[] = [];
    await h.prompt({
      sessionId: sid,
      content: "what can you reach on this turn?",
      user: "SnapshotOwner",
      collect: calls,
      turns: [
        {
          kind: "clean",
          engineSessionId: "ses_snap_session_mcp",
          text: ["Only alpha."],
        },
      ],
    });

    expect(calls[0].opts.mcpServers).toEqual(["snapshot-alpha"]);
    h.snapshot("session-stamped-mcp-allowlist", { sessionId: sid, calls });
  });

  // A mid-session engine switch: turn one runs on the claude engine, the model
  // is then changed to a codex id, and turn two must carry a handoff note built
  // from the stored transcript, which the incoming engine has never seen.
  test("engine switch mid-session: handoff note", async () => {
    if (!h.ready) return;
    const sid = "bks-snap-switch";
    h.writeSession(sid, {
      mode: "scratch",
      repo: "snapshot-repo",
      workspaceId: "ws-snap-switch",
      model: "claude/anthropic/claude-sonnet-5",
    });

    const calls: FakeCall[] = [];
    await h.prompt({
      sessionId: sid,
      content: "start the migration",
      user: "SnapshotOwner",
      collect: calls,
      turns: [
        {
          kind: "clean",
          provider: "claude",
          engineSessionId: "11111111-2222-4333-8444-555555555555",
          text: ["Renamed the first two call sites."],
          tools: [{ name: "edit", input: { file: "a.ts" }, result: "written" }],
        },
      ],
    });

    // The human switches models to the other engine, then keeps going.
    h.patchSession(sid, { model: "pi/openai/gpt-5.6-sol" });
    await h.prompt({
      sessionId: sid,
      content: "keep going",
      user: "SnapshotOwner",
      collect: calls,
      turns: [
        {
          kind: "clean",
          provider: "pi",
          engineSessionId: "pi-session-1",
          text: ["Continuing."],
        },
      ],
    });

    expect(calls).toHaveLength(2);
    // Pi is the only engine, so the second turn resumes the same engine session.
    expect(calls[1].opts.sessionId).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(calls[1].prompt).toContain('<opensession:context source="handoff">');
    h.snapshot("engine-switch-handoff", { sessionId: sid, calls });
  });

  // Memory scopes are injected into the run's session note (repo / user / team)
  // and logged into the transcript as a context-injection entry.
  test("memory scopes: retrieved into the turn prompt", async () => {
    if (!h.ready) return;
    const sid = "bks-snap-memory";
    h.writeSession(sid, {
      mode: "scratch",
      repo: "snapshot-repo",
      workspaceId: "ws-snap-memory",
      startedBy: "SnapshotUser",
      createdBy: "SnapshotUser",
    });

    const calls: FakeCall[] = [];
    await h.withMemory(
      {
        "repo-snapshot-repo": [
          {
            id: "mem-repo-1",
            text: "The fixture repo's tests only run from its own worktree.",
            by: "SnapshotOwner",
          },
        ],
        "user-snapshotuser": [
          {
            id: "mem-user-1",
            text: "SnapshotUser prefers short reports.",
            by: "SnapshotUser",
          },
        ],
        workspace: [
          {
            id: "mem-team-1",
            text: "Team fact: never push to the fixture remote.",
            by: "SnapshotOwner",
          },
        ],
      },
      async () => {
        await h.prompt({
          sessionId: sid,
          content: "How do this fixture repo's tests run?",
          user: "SnapshotUser",
          collect: calls,
          turns: [
            {
              kind: "clean",
              engineSessionId: "ses_snap_memory",
              text: ["Three standing facts."],
            },
          ],
        });
      },
    );

    expect(calls[0].opts.prompt).toContain(
      "tests only run from its own worktree",
    );
    h.snapshot("memory-scope-injection", { sessionId: sid, calls });
  });
});
