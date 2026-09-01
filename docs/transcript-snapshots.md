# Transcript snapshots

Keyless regression fixtures for the run pipeline. A scenario drives a scripted
session through the real pipeline (`run-session` → `agent-runner` → the event
loop → the transcript store) with a fake engine at the seam, then freezes these
normalized JSON views:

- **what the run wrote**: selected fields from the last 200 unified transcript
  entries in the owned store;
- **what the run sent**: selected engine-call options, including the prompt,
  session note, MCP scope and tool-policy inputs;
- **what policy resolves**: the filtered MCP configuration and stripped tool
  ids produced from those options by production policy helpers.

No API key, no network, no engine subprocess. The point is that the highest
risk plumbing (context fencing, MCP filtering, engine handoff notes, memory
injection) changes visibly, as a fixture diff in a pull request, instead of
silently.

Contributor doc. Nothing here is operator configuration.

## Running

From the repository root:

```sh
bun run test:snapshots                              # compare
OPENSESSION_SNAPSHOT=record bun run test:snapshots # re-record
```

Run the file **directly**, through the command above. Like
`zz-fake-run.test.ts`, it redirects instance state, the sessions directory,
transcript store, run journal, engine-session map, MCP config and memory store.
An earlier file in a full `bun test` may already have frozen shared module
state; when the harness detects that, every scenario skips rather than touching
this machine's real data.

That skip is why the suite has its own command and its own CI step: inside the
sweep these scenarios protect nothing. The script sets
`OPENSESSION_SNAPSHOT_STRICT=1`, which turns an unready harness into a failure
rather than a silent pass. Use the same script when recording so an unready
harness cannot leave the fixtures unchanged and report success.

Fixtures live in `packages/core/opensession-server/src/server/testing/snapshots/`.

## The scenarios

| Fixture                         | What it pins                                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plain-turn-context-fencing`    | A teammate's prompt with a sibling session attached as context. The visible prompt and transcript keep the human's message; the model gets an `<opensession:context>` attachment block and the `[Name]` attribution. |
| `mcp-allowlist-filtering`       | An automation-owned session prompted by a human. The allowlist drops one server, the `allowedUsers` gate drops another, and the automation's denied tools are stripped from the projected tool list.                 |
| `session-stamped-mcp-allowlist` | An ordinary session whose file contains a picked server set. Reading the session back preserves that scope for the turn.                                                                                             |
| `engine-switch-handoff`         | Two turns with a model/provider change between them. Turn two carries the handoff note built from stored history and supplies prior entries for transcript seeding.                                                  |
| `memory-scope-injection`        | Query-matched repo and team/workspace memories injected as fenced turn context and logged as a context-injection entry. The seeded but unrelated user preference is intentionally not retrieved.                     |

## When a change requires re-recording

A snapshot failure is a report, not a verdict. Read the diff and decide which
of these it is:

**Re-record.** The change intends to alter what the model sees or what the
transcript holds, and the diff shows exactly that intent and nothing else:

- new or reworded injected context (a note's copy, a new fenced block);
- a deliberate change to what the session note carries;
- a new transcript entry kind, or a changed entry shape;
- a tool added to (or removed from) a deny/confirm list;
- a field deliberately added to or changed in `engineCallView` or
  `enginePolicyView`.

**Do not re-record; you found a bug.** The diff shows something the change was
not about:

- injected context appearing in `prompt.visible` or a visible user entry, or
  disappearing from `prompt.injectedContext` or its tagged
  `context-injection` transcript entry;
- projected `mountedMcpServers` gaining a server (a filter stopped filtering)
  or the `unattended` flag flipping to false on an automation-owned run;
- `strippedTools` losing an entry, especially a money-moving one;
- an engine-switch handoff going missing or its prior-entry seed unexpectedly
  becoming empty;
- entries changing `seq` order, or one entry's content replacing another's
  (an id collision upserting the wrong row).

Re-recording is one command, so the safeguard is entirely in reading the diff
before you commit it. A fixture whose diff nobody read is worth nothing.

## Adding a scenario

1. Add a `test(...)` to
   `packages/core/opensession-server/src/server/zz-snapshot-runs.test.ts`. Start
   it with `if (!h.ready) return;` so it skips with the rest when module state
   is warm.
2. Build the session with `h.writeSession(id, {...})`. Prefer `mode: "scratch"`
   plus an explicit `repo` id: the scratch working directory is created under
   the harness's temporary state directory, and the repo id keeps memory scope
   selection independent of the machine's default repo. An explicit
   `worktreeDir` is normally unnecessary; repo-aware notes can reject a path
   that no registered repo owns.
3. Drive turns with `h.prompt({ sessionId, content, user, turns, collect })`.
   `turns` is the fake engine's script (see `testing/fake-engine.ts`): text,
   tool calls, errors, usage exhaustion, and the `provider` a turn claims.
   Every engine invocation lands in `collect`.
4. Assert the one or two invariants the scenario exists for, so a reader of the
   test knows what it is about without opening the fixture.
5. Freeze it with `h.snapshot("<fixture-name>", { sessionId, calls })`, then
   record and **read the fixture** before committing.

Useful helpers on the harness:

- `h.patchSession(id, {...})` merges fields into an existing session file,
  which is how a scenario models a mid-session model or engine change.
- `h.writeEngineTranscript(engineSessionId, lines)` requires an existing
  session that owns that engine id. It parses legacy JSONL-shaped lines,
  imports them into the owned transcript store and records the engine-to-session
  mapping. It does not create an engine-native transcript file or populate
  `session.transcriptPath`; code paths that read such a file will still see no
  native history.
- `h.withMemory({ scope: entries }, fn)` runs `fn` against its own memory
  store, so a memory scenario cannot leak into another one.

## What is real and what is projected

Everything up to the engine seam is production code: prompt assembly, context
fences, the session note, queue and run-state machinery, and pipeline transcript
writes.

Two deliberate exceptions, both because the Pi adapter loads the model runtime
and cannot run hermetically:

1. **MCP filtering and tool stripping are projected, not observed.**
   `enginePolicyView` (`testing/snapshot-views.ts`) calls `runGateReason` and
   `runToolPolicy` from `run-policy.ts` and `filterMcpServers` from
   `runner-shared.ts` using the recorded options. This exercises production
   policy functions, but it does not start `pi-mcp-bridge`, connect to servers,
   discover their tool catalogs or prove that a server mounted successfully.
   Keep the projection aligned with the adapter's call sites when those change.

2. **The fake engine persists its own turn.** Writing assistant text and tool
   calls into the store is the engine adapter's job, not `run-session`'s, which
   only broadcasts those events. The fake engine therefore uses
   `appendTranscriptEntries` and the same `transcriptLine*` builders as the Pi
   adapter. Adapter-specific SDK events, streaming behavior, compaction and MCP
   bridge behavior remain outside the harness.

`Normalizer` in `testing/snapshot.ts` removes volatile timestamp/identity fields
and scrubs timestamps, selected session ids, loopback ports, and registered
checkout, home and harness paths. If a fixture ever shows a value from the
machine that recorded it, add the pattern there rather than editing the
fixture.
