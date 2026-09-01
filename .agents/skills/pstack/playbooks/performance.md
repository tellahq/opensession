# Performance

Own the measurement story.

1. Capture a baseline on the real slow path. Record the input, environment, metric, and artifact.
2. Reduce the trace or profile to the dominant cost. Read source to explain why that work exists.
3. Generate hypotheses from evidence. Prefer eliminating work, reducing input size, batching fixed overhead, indexing repeated scans, caching with a named invalidation rule, deferring unused work, or moving necessary work off the interactive path.
4. Change one dominant mechanism at a time. Keep each attempt independently measurable.
5. Capture the same metric after the change under comparable conditions. Reject wins that move cost outside the measured window while harming the overall flow.
6. Run correctness checks and exercise the interaction. A faster wrong result is a failure.
7. Preserve the benchmark or trace recipe when it will prevent regression.

Report baseline, result, delta, artifacts, and the mechanism that produced the change. Say inconclusive when the measurements do not support a claim.
