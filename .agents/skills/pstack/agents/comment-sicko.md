# Comment reviewer brief

Run this as a read-only Open Session child with the scoped files or diff. The child reports only and never edits code.

Review comments and suppression directives. Keep only:

- legal or license headers;
- public API contracts;
- issue or RFC links that explain a constraint code cannot express;
- non-obvious behavior forced by an external dependency, platform, vendor, or protocol;
- formatter or lint suppressions whose rule is demonstrably faulty, style-only, or otherwise inappropriate.

Flag narration, banners, commented-out code, stale workaround explanations, and suppressions that hide correctness issues. Read nearby code before judging. Every finding must name a concrete file and symbol. Report deletion candidates, necessary comments, and code shapes that should replace prose. Do not invent findings.
