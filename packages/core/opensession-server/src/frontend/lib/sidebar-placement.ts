import {
  AGENT_PERSON_KEY,
  AUTOMATION_MACHINE_IDENTITY,
} from "./automation-audience";
import {
  personKey,
  prReviewCompletion,
  reviewRequestTargetsPerson,
  reviewRowMatchesPersonFilter,
  rowIsOwnWork,
  wsPrRequestsReviewFrom,
} from "./review-queue";
import { wsPrApproved, wsPrMerged } from "./sidebar-lanes";
import type { WsRow } from "./sidebar-types";

export type SidebarPlacement =
  | "snoozed"
  | "needs-review"
  | "approved-review"
  | "awaiting-review"
  | "completed-review"
  | "status"
  | "outside";

export interface SidebarPlacementContext {
  currentUser: string;
  personFilter: string;
  snoozed: boolean;
  inStatusScope: boolean;
  /** A personal lane is an explicit request to keep this row in the ordinary
	    sidebar list, even when it would otherwise file into a review band. */
  claimed?: boolean;
}

export interface PlacedSidebarRow<T extends WsRow = WsRow> {
  row: T;
  placement: SidebarPlacement;
}

/**
 * One session minted through the browser automation identity rather than by a
 * person. An automation RUN is a different product concept: it keeps its own
 * `automation` field and its own band, so callers that mark ordinary work
 * exclude those themselves, the way `rowWasAutoCreated` does below.
 */
export function sessionWasAutoCreated(session: {
  createdBy?: string | null;
  startedBy?: string | null;
}): boolean {
  return [session.createdBy, session.startedBy].some(
    (person) => person?.trim().toLowerCase() === AUTOMATION_MACHINE_IDENTITY,
  );
}

/** A session whose opening turn came from an agent action, not a composer. */
export function sessionWasAgentStarted(session: {
  id: string;
  branch?: string | null;
  automation?: string;
  parentSessionId?: string;
  spawnedBy?: string;
  agentStarted?: boolean;
  createdBy?: string | null;
  startedBy?: string | null;
}): boolean {
  return Boolean(
    session.agentStarted ||
    session.automation ||
    session.parentSessionId ||
    session.spawnedBy ||
    session.id.startsWith("bks-ghpr-") ||
    // Report fan-out predates `agentStarted`; its durable branch prefix
    // keeps existing sessions identifiable after this field ships.
    session.branch?.startsWith("report-") ||
    sessionWasAutoCreated(session),
  );
}

/** A row where every represented session was opened by an agent action. */
export function rowWasAgentStarted(row: WsRow): boolean {
  if (row.sessions.length > 0)
    return row.sessions.every(sessionWasAgentStarted);
  return rowWasAutoCreated(row);
}

/**
 * A normal workspace or session created through the browser automation
 * identity. Automation runs are a different product concept and keep their
 * own `automation` field, so they never enter this section.
 */
export function rowWasAutoCreated(row: WsRow): boolean {
  const ordinarySessions = row.sessions.filter(
    (session) => !session.automation,
  );
  // Once a person joins the workspace it is shared work, not machine clutter:
  // hiding the whole row would also hide that person's sessions.
  if (ordinarySessions.length > 0)
    return ordinarySessions.every(sessionWasAutoCreated);
  // An automation-only row is still an automation run even if its container
  // happened to be minted by the machine identity.
  if (row.sessions.length > 0) return false;
  return (
    row.workspace?.createdBy.trim().toLowerCase() ===
    AUTOMATION_MACHINE_IDENTITY
  );
}

/**
 * The origin a whole row can claim, for the mark beside its name: the source
 * every session in it shares. A row is a workspace, and a workspace can hold
 * sessions from more than one place — one Slack thread that grew a session
 * you started here is no longer "a Slack workspace", so it gets no mark
 * rather than a misleading one. Empty for the default origin.
 */
export function rowOriginSource(row: WsRow): string {
  const sources = new Set(row.sessions.map((session) => session.source));
  if (sources.size !== 1) return "";
  // `backstage` is the pre-rename id older stored sessions still carry, so it
  // is a runtime value the union no longer names.
  const source: string = [...sources][0];
  return source === "opensession" || source === "backstage" ? "" : source;
}

/**
 * Whether an auto-created row belongs in the list the person lens is showing.
 * The machine is the agent, not whichever teammate is looking, so anonymous
 * browser work stays out of every human's Me lens.
 *
 * Only the lens question lives here. Whether you want to see these rows at all
 * is the `autoCreated` filter, and it is the caller's to apply, because a row
 * you hid can still be one GitHub is asking you to review.
 */
export function rowAutoCreatedInLens(
  row: WsRow,
  personFilter: string,
): boolean {
  return personFilter === AGENT_PERSON_KEY && rowWasAutoCreated(row);
}

export function classifySidebarPlacement(
  row: WsRow,
  context: SidebarPlacementContext,
): SidebarPlacement {
  if (context.snoozed) return "snoozed";

  const me = context.currentUser.toLowerCase();
  const githubAsksMe =
    wsPrRequestsReviewFrom(row, personKey(context.currentUser)) &&
    !rowIsOwnWork(row, context.currentUser);
  const inReviewScope = reviewRowMatchesPersonFilter(
    row.owner,
    row.sessions.map((session) => session.reviewRequest),
    context.personFilter,
    context.currentUser,
    githubAsksMe,
  );

  if (inReviewScope && !wsPrMerged(row)) {
    // A request GitHub is still making of you outranks another reviewer's
    // approval. Your part is not complete until that request clears.
    if (githubAsksMe) return "needs-review";

    const approved = wsPrApproved(row);
    const needsReview = row.sessions.some(
      (session) =>
        reviewRequestTargetsPerson(session.reviewRequest, me) &&
        !session.reviewRequest?.accepted &&
        !prReviewCompletion(session.reviewRequest!, session),
    );
    if (!approved && needsReview) return "needs-review";

    const askedByMe = row.sessions.some(
      (session) => session.reviewRequest?.by.toLowerCase() === me,
    );
    if (approved && askedByMe) return "approved-review";

    const awaitingReview = row.sessions.some(
      (session) =>
        session.reviewRequest?.by.toLowerCase() === me &&
        !session.reviewRequest.accepted &&
        !prReviewCompletion(session.reviewRequest, session),
    );
    if (!approved && awaitingReview) return "awaiting-review";

    const mineRequest = row.sessions.some((session) => {
      const request = session.reviewRequest;
      return (
        request &&
        (request.by.toLowerCase() === me ||
          reviewRequestTargetsPerson(request, me))
      );
    });
    const reviewCompleted =
      row.sessions.some((session) => session.reviewRequest?.accepted) ||
      approved ||
      row.sessions.some(
        (session) =>
          session.reviewRequest &&
          prReviewCompletion(session.reviewRequest, session),
      );
    if (mineRequest && reviewCompleted) return "completed-review";
  }

  // A personal lane keeps ordinary work in Active, but a live review handoff
  // is more specific: the asker tracks it in Awaiting review and the reviewer
  // gets it in Needs review. Once that flow ends, the personal lane applies again.
  if (context.claimed) return context.inStatusScope ? "status" : "outside";

  // Auto-created work has no band of its own: it files into the ordinary
  // lanes with everything else and identifies itself with a robot beside the
  // name. Kent's call, 2026-08-17, replacing the separate "Auto created"
  // section: a row you have to go and find in an annex is not part of the
  // list, and the filter is what handles there being a lot of them.
  return context.inStatusScope ? "status" : "outside";
}

export function placeSidebarRows<T extends WsRow>(
  rows: readonly T[],
  contextFor: (row: T) => SidebarPlacementContext,
): Array<PlacedSidebarRow<T>> {
  return rows.map((row) => ({
    row,
    placement: classifySidebarPlacement(row, contextFor(row)),
  }));
}

export function rowsAtPlacement<T extends WsRow>(
  rows: readonly PlacedSidebarRow<T>[],
  placement: SidebarPlacement,
): T[] {
  return rows
    .filter((entry) => entry.placement === placement)
    .map((entry) => entry.row);
}
