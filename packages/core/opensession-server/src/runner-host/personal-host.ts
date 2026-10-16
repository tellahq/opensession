/** Mandatory personal entrypoint. No inference or host import before the
 * fixed gateway projection is consumed and validated against exact spec bytes. */
import { adoptPersonalHostProjection } from "../server/personal-repo-runtime-host";

export async function runPersonalHost() {
  const specPath = process.argv[2];
  if (!specPath || process.argv.length !== 3)
    throw new Error("Personal host preflight failed");
  await adoptPersonalHostProjection(
    specPath,
    process.env.OPENSESSION_RUN_SPEC_HASH,
  );
  await import("./host");
}
if (import.meta.main) {
  runPersonalHost().catch(() => {
    console.error("Personal host preflight failed");
    process.exit(1);
  });
}
