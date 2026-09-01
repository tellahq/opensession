---
name: reflect
description: Spawn three parallel review child sessions over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

## When to invoke

- The user said "reflect" or "/reflect".
- A complex task (5+ tool calls) just landed cleanly and the recipe is worth keeping.
- The agent hit dead ends, found the working path, and the path generalizes.
- The user corrected the agent's approach mid-task.
- A non-trivial workflow emerged that isn't captured anywhere.

Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Locate the active transcript

Use the current conversation context for the active session. For an earlier session, discover the policy-gated Open Session session and history tools, identify it by exact id and explicit creator, and read only the relevant transcript windows. Never scan transcript files, databases, or global session storage. If no gated transcript resolves, write a tight digest of the current session and pass that instead.

### 2. Spawn three reviewers in parallel

Spawn three ask-mode child sessions in parallel with self-contained `/pstack` briefs that forbid file writes. Reviewers may use MCPs available to their Open Session session for cited context lookups. The parent applies edits.

| Lens | Model | Prompt template |
|---|---|---|
| Judgment | configured supporting model when available, otherwise inherited | `references/judgment-reviewer.md` |
| Tooling | configured supporting model when available, otherwise inherited | `references/tooling-reviewer.md` |
| Divergent | a different configured family when available, otherwise inherited | `references/divergent-reviewer.md` |

Pass each template verbatim with a reduced transcript digest and, only when needed, an exact policy-gated session id. Reviewers return findings in their reports.

### 3. Synthesize

Spawn one ask-mode `/pstack` child as the synthesizer. It may use its policy-gated MCPs to spot-check citations. Use `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. The synthesizer returns a structured Accepted / Rejected / Backlog list.

### 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog. The synthesizer already applies this criterion; this is a final pass before edits land. See the **encode-lessons-in-structure** principle skill.

### 5. Apply

Present the synthesizer's full Accepted/Rejected/Backlog output. Apply edits only when the user's request and repository workflow authorize modifying skills; a read-only reflection stops at proposals. Skill changes can affect future agents, so keep them scoped and reviewable.

File backlog items only when the user explicitly asked for tracker updates and a policy-gated organization tool is available. Otherwise report them as proposals.

For each approved Accepted item, follow the Routing field exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the repository skill conventions and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to the repository skill conventions and run its description-optimization loop.
- `new skill via Open Session skill authoring: <kebab-name>`: hand creation to the repository skill conventions. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done. Skip this step if it doesn't.

### 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog proposals or authorized tracker items: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
