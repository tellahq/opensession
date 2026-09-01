# Eval

Measure whether a skill, prompt, or workflow change improves agent behavior.

1. State the behavior under test, baseline, candidate, representative cases, success criteria, and failure criteria before running anything.
2. Keep cases identical across baseline and candidate. Isolate the changed instruction or structure.
3. Use ask-mode child sessions for read-only cases and isolated code worktrees for writing cases. Begin every brief with the exact baseline or candidate invocation and prevent cross-contamination.
4. Run enough independent cases to distinguish a pattern from one lucky output. Use different configured model families only when model sensitivity is part of the question.
5. Grade observable behavior and artifacts, not self-report. Check tool calls, files read, diffs, outputs, and verification evidence through policy-gated session history and repository state.
6. Never read transcript files or databases directly. Identify every evaluated session by exact id and creator.
7. Compare results against the declared rubric. Reject a candidate that adds ceremony without improving the target behavior.
8. Preserve a compact rerunnable recipe and raw evidence pointers in organization-controlled scratch space. Commit only the durable evaluator when repository policy calls for it.

Report the baseline, candidate, cases, measured result, regressions, confidence, and promotion decision.
