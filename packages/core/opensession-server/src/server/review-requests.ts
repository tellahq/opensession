/**
 * Review requests for sessions of ALL sources: "please look at this" pointed at
 * a specific teammate, set from the session info panel's Reviewer picker. The
 * flagged session surfaces in a "Needs review" band at the top of the chosen
 * reviewer's sidebar (plus a push/alert), until the request is cleared.
 *
 * Same shape as the archive / title / status-override registries: a
 * backstage-owned JSON store keyed by unified session id, applied over every
 * session in getAllSessions. Slack/Linear session files are read-only for
 * opensession, so the request can't live in the session file.
 */
import { readFile } from "fs/promises";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import { OPENSESSION_SESSIONS_DIR } from "./paths";

export interface ReviewRequest {
  /** Reviewer's display name (the `backstage-user` value, e.g. "Kent"). */
  to: string;
  /** Individual sidebar identities covered by a configured review team. */
  recipients?: string[];
  /** Who asked for the review. */
  by: string;
  /** ISO timestamp of the request. */
  at: string;
  /** Set once the reviewer signs off. The request stays in place (so the asker
   * still sees who reviewed it) but flips to an accepted/green state and moves
   * into the sidebar's "Reviewed" band. Cleared on reopen or a re-assign. */
  accepted?: { by: string; at: string };
}

const REGISTRY_PATH = `${OPENSESSION_SESSIONS_DIR}/review-requests.json`;

// This process is the registry's only writer, so once loaded the in-memory
// copy is authoritative and reads never touch the disk.
let cache: Record<string, ReviewRequest> | null = null;
let loading: Promise<Record<string, ReviewRequest>> | undefined;

/** Read the registry once, asynchronously. Boot awaits this before the
 *  session list is primed; setters await it before changing anything. */
export function loadReviewRequests(): Promise<Record<string, ReviewRequest>> {
  if (cache) return Promise.resolve(cache);
  loading ??= readFile(REGISTRY_PATH, "utf-8")
    .then((text) => JSON.parse(text) as Record<string, ReviewRequest>)
    .catch(() => ({}))
    .then((loaded) => (cache ??= loaded));
  return loading;
}

/** The loaded registry. Before the boot load lands, nothing is flagged. */
function load(): Record<string, ReviewRequest> {
  if (cache) return cache;
  void loadReviewRequests();
  return {};
}

/** Writes run one at a time in call order, so the file ends on the latest
 *  registry. */
let saving: Promise<void> = Promise.resolve();

function save(registry: Record<string, ReviewRequest>): Promise<void> {
  cache = registry;
  const write = saving.then(() =>
    writeJsonAtomicAsync(REGISTRY_PATH, registry),
  );
  saving = write.catch(() => {});
  return write;
}

function requestIds(id: string, aliasIds: readonly string[]): string[] {
  return [...new Set([id, ...aliasIds])];
}

export function getReviewRequest(
  id: string,
  aliasIds: readonly string[] = [],
): ReviewRequest | undefined {
  const registry = load();
  return requestIds(id, aliasIds)
    .map((candidate) => registry[candidate])
    .find((request) => request !== undefined);
}

/** Set (a reviewer) or clear (null) the review request for a session. Historical
 * aliases are removed at the same time so an old key cannot revive a cleared
 * request when the unified session list is rebuilt. */
export async function setReviewRequest(
  id: string,
  req: ReviewRequest | null,
  aliasIds: readonly string[] = [],
): Promise<void> {
  const registry = { ...(await loadReviewRequests()) };
  for (const candidate of requestIds(id, aliasIds)) delete registry[candidate];
  if (req) registry[id] = req;
  await save(registry);
}

/** Mark the current request accepted (reviewer signed off) or reopen it (null),
 * preserving the original `to`/`by`/`at`. No-op if the session and its aliases
 * have no request. The write also migrates an alias-keyed request to `id`. */
export async function setReviewAccepted(
  id: string,
  accepted: { by: string; at: string } | null,
  aliasIds: readonly string[] = [],
): Promise<void> {
  const registry = { ...(await loadReviewRequests()) };
  const ids = requestIds(id, aliasIds);
  const existing = ids
    .map((candidate) => registry[candidate])
    .find((request) => request !== undefined);
  if (!existing) return;
  const next: ReviewRequest = { ...existing };
  if (accepted) next.accepted = accepted;
  else delete next.accepted;
  for (const candidate of ids) delete registry[candidate];
  registry[id] = next;
  await save(registry);
}
