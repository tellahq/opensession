import { catalogSessionDocuments } from "./session-catalog-read";
import { isNativeSessionId } from "./paths";
import { githubLoginFor } from "./shared/user-mappings";
import { updateSessionFile } from "./session-cache";
import type { NativeSessionFile } from "./types";

/** Never infer a person's login for an automation or overwrite an existing link. */
export function missingCreatorLogin(
  data: NativeSessionFile,
  resolve = githubLoginFor,
): string | null {
  if (
    data.createdByLogin ||
    data.automationId ||
    typeof data.createdBy !== "string" ||
    !data.createdBy ||
    data.createdBy.endsWith(" (automation)")
  )
    return null;
  return resolve(data.createdBy) || null;
}

/** Explicit operator job. Bounded actor writes, resumable catalog cursor, dry-run by default. */
export async function migrateSessionGithubUsers(
  opts: { apply?: boolean; after?: string; limit?: number } = {},
) {
  if (process.env.OPENSESSION_OPERATOR_MIGRATION !== "1")
    throw new Error(
      "Identity backfill is an explicit operator migration, not gateway maintenance",
    );
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Migration limit must be 1..100");
  const candidates: Array<{ sessionId: string; login: string }> = [];
  let after = opts.after ?? "";
  let updated = 0;
  let complete = true;
  for await (const { sessionId, data } of catalogSessionDocuments(opts.after)) {
    if (sessionId <= after) continue;
    after = sessionId;
    if (!isNativeSessionId(sessionId)) continue;
    const login = missingCreatorLogin(data);
    if (!login) continue;
    candidates.push({ sessionId, login });
    if (opts.apply) {
      let changed = false;
      await updateSessionFile(sessionId, (current) => {
        // Re-evaluate against the current revision; a concurrent owner change
        // or a login already linked must never be overwritten by the preview.
        const currentLogin = missingCreatorLogin(current);
        changed = !!currentLogin;
        return currentLogin
          ? { ...current, createdByLogin: currentLogin }
          : current;
      });
      if (changed) updated++;
    }
    if (candidates.length >= limit) {
      complete = false;
      break;
    }
  }
  return { dryRun: !opts.apply, candidates, updated, after, complete };
}
