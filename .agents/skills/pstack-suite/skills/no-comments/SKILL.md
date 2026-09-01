---
name: no-comments
description: Review a diff for narration, stale comments, and suppressions that clearer code should replace. Use for /skill:no-comments or before committing comment-heavy changes.
disable-model-invocation: true
---

# No comments

Use this on a scoped diff or named files. It is a review pass, not a blanket ban on comments.

1. Read `../../../pstack/agents/comment-sicko.md`.
2. Discover the policy-gated Open Session child-session tools and spawn one ask-mode child with that brief plus the exact scope. If child sessions are unavailable, perform the same read-only review directly and say delegation was unavailable.
3. Check every reported candidate against the surrounding code. Accept only findings supported by the file.
4. Delete narration and stale explanations. Replace comments about surprising internal structure with clearer names, types, functions, or ownership where that reshape stays in scope.
5. Keep legal headers, public contracts, proven external constraints, useful issue links, and justified formatter or lint suppressions.
6. Run the relevant formatter, lint, type, or test check after edits.

Report deleted comments, retained comments with reasons, structural replacements, and verification.
