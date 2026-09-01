# Review

Own findings, not volume.

1. Establish the intended behavior from the request, issue, tests, and surrounding code.
2. Read the complete diff and the owning call paths. Check changed types, state transitions, persistence, errors, concurrency, security boundaries, and affected clients.
3. Run focused tests or probes for suspicious behavior. A plausible concern without a failing mechanism is not yet a finding.
4. Prioritize correctness, data loss, security, and user-visible regressions. Ignore style preferences already enforced by tooling.
5. For each finding, name the file and line, the concrete trigger, the resulting impact, and the smallest credible fix.
6. Re-read the diff after findings to catch interactions and verify that each claim still applies to the current head.

Return findings first, highest severity first. If none survive verification, say so and name any residual test gap.
