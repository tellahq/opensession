// Entry point for the compiled-binary test in codemode-sidecars.test.ts: the
// same `opensession codemode-smoke` path the release workflow runs.
import { runCodemodeSmoke } from "../../packages/core/opensession-server/src/server/codemode-runtime";

try {
  await runCodemodeSmoke();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
