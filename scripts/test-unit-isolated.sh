#!/usr/bin/env bash
# Run every unit-test file in its own Bun process. The suite intentionally has
# tests that replace process.env, fetch, module-level path caches, and globalThis
# state; process boundaries keep those fixtures from changing later files.
set -euo pipefail

readonly jobs="${OPENSESSION_TEST_JOBS:-1}"
if ! [[ "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "OPENSESSION_TEST_JOBS must be a positive integer (got: $jobs)" >&2
  exit 2
fi

find_tests() {
  find packages/core/opensession-server/src scripts -type f \
    \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.test.jsx' \
       -o -name '*.spec.ts' -o -name '*.spec.tsx' -o -name '*.spec.js' -o -name '*.spec.jsx' \) \
    -print0
}

readonly test_count="$(find_tests | tr -cd '\000' | wc -c | tr -d '[:space:]')"
if [[ "$test_count" == "0" ]]; then
  echo "No unit-test files found" >&2
  exit 1
fi

printf 'Running %d unit-test files in isolated processes (%d at a time)\n' \
  "$test_count" "$jobs"
# A developer's service shell may carry runtime bypasses used by previews or
# snapshot fixtures. Unit files that test the default executor and run-host
# policy must not inherit those process-wide overrides.
find_tests | xargs -0 -n 1 -P "$jobs" env \
  -u OPENSESSION_EXECUTOR \
  -u OPENSESSION_TEST_IN_PROCESS_RUNS \
  bun test --no-orphans --reporter dots
