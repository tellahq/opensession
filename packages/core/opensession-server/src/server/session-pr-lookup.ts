/**
 * One session with its PR refs filled in. A targeted session read omits the
 * PR fields the list projection adds, so anything that asks "does this branch
 * already have a PR?" about one session reads it through here: the bulk PR
 * cache, attribution-footer matches, and the PRs its workspace siblings found.
 */

import { defaultRepo } from "./config";
import { footerPrsFor, getPrsByRepo, prsBySessionRef } from "./pr-cache";
import { findSessionAsync } from "./session-cache";
import { indexedWorkspaceMemberSessions } from "./session-list-store";
import {
  enrichSessionPrRefs,
  projectWorkspacePrRefs,
} from "./session-pr-target";

export async function findPrSessionAsync(sessionId: string) {
  const stored = await findSessionAsync(sessionId);
  if (!stored) return stored;
  const prsByRepo = getPrsByRepo();
  const prsBySession = prsBySessionRef(prsByRepo);
  const enrich = (session: NonNullable<typeof stored>) =>
    enrichSessionPrRefs(session, {
      defaultRepoId: defaultRepo().id,
      prsByRepo,
      footerMatches: footerPrsFor(prsBySession, session),
    });
  const session = enrich(stored);
  if (!session.workspaceId) return session;
  return projectWorkspacePrRefs(
    session,
    (await indexedWorkspaceMemberSessions(session.workspaceId)).map(enrich),
  );
}
