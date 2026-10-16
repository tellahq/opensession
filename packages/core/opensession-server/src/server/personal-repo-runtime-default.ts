import { join } from "node:path";
import { homedir } from "node:os";
import {
  createPersonalRepoRuntime,
  type PersonalRepoBinding,
} from "./personal-repo-runtime";
import type { PersonalCredentialKind } from "./personal-github/repository-coordinator";

let cached:
  | {
      root: string;
      runtime: Promise<ReturnType<typeof createPersonalRepoRuntime>>;
    }
  | undefined;
/** Trusted gateway composition; never call from a detached host that would open
 * a second broker without the authoritative coordinator. No import-time work. */
export function personalRepoRuntime() {
  const root = join(
    process.env.OPENSESSION_STATE_DIR ||
      join(process.env.HOME || homedir(), ".opensession"),
    "personal-repo-runtime",
  );
  if (cached?.root === root) return cached.runtime;
  const runtime = Promise.all([
    import("./personal-repository-coordinator"),
    import("./personal-github/worker-client"),
    import("./personal-repo-runtime-git"),
  ]).then(([catalog, broker, git]) =>
    createPersonalRepoRuntime({
      root,
      readPersonalRepository: catalog.readPersonalRepository,
      resolveCredential: (owner, descriptor, kind) =>
        broker
          .personalConnectionClient()
          .resolveCredential(owner, descriptor, kind),
      git: git.createPersonalRepoGit(),
    }),
  );
  cached = { root, runtime };
  return runtime;
}

/** Explicit existing run-policy inputs, not browser options. No shared identity
 * lookup is performed for personal runs. */
export function personalCredentialKind(
  isCode: boolean,
  _ownerTurn: boolean,
): PersonalCredentialKind {
  // An App-wide user grant is never a repository-scoped credential.
  return isCode ? "installation-write" : "installation-read";
}
export async function personalRepoRunEnv(
  binding: PersonalRepoBinding,
  isCode: boolean,
  ownerTurn: boolean,
) {
  const { personalHostProjection } =
    await import("./personal-repo-runtime-host");
  const hosted = personalHostProjection(binding);
  if (!hosted)
    throw new Error(
      "Personal model runs require the compatible detached runtime",
    );
  if (hosted.kind !== personalCredentialKind(isCode, ownerTurn))
    throw new Error("Personal host credential policy changed");
  return hosted.env;
}

export async function personalRepoRunConfig(binding: PersonalRepoBinding) {
  const { personalHostProjection } =
    await import("./personal-repo-runtime-host");
  const hosted = personalHostProjection(binding);
  if (!hosted)
    throw new Error(
      "Personal model runs require the compatible detached runtime",
    );
  return hosted.repo;
}
