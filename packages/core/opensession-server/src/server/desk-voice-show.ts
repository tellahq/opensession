import { getSessionControl, type SessionControl } from "./session-control";
import { getWorkspace, listWorkspaces, type Workspace } from "./workspaces";
import {
  DESK_SHOW_TABS,
  deskShowTargetSchema,
  type DeskShowTab,
} from "../shared/desk-navigation";
import { fuzzyScore } from "../shared/fuzzy-match";
import type { DeskVoiceNavigation } from "./desk-voice-navigation";

export const SHOW_IN_APP_TOOL = {
  type: "function",
  name: "show_in_app",
  description:
    "Bring a session or a workspace up in the user's own Open Session window, next to the Desk. Use when they ask to see, open, show, or go to something. Give the session's id or its title (a distinctive part is enough), or the workspace's id or name. Add tab to land on a specific tab, such as review for the PR and CI status. Only changes the page shown in this voice call's browser.",
  parameters: {
    type: "object",
    properties: {
      session: {
        type: "string",
        description: "Session id, or its title or a distinctive part of it",
      },
      workspace: {
        type: "string",
        description: "Workspace id or name",
      },
      tab: {
        type: "string",
        enum: [...DESK_SHOW_TABS],
        description:
          "Tab to bring up: review (the PR, its checks and comments), chat (the session transcript), conversation (a support thread), or video. Omit to keep the current tab.",
      },
    },
    required: [],
    additionalProperties: false,
  },
} as const;

export type ShowTarget = (
  | { kind: "session"; id: string; title: string }
  | { kind: "workspace"; id: string; name: string }
) & { tab?: DeskShowTab };

export type ShowResolution =
  | { target: ShowTarget }
  | { error: string; candidates?: Array<{ id: string; title: string }> };

/** How many near-matches the backend gets to disambiguate with. */
const MAX_CANDIDATES = 5;
/** Below this fuzzy score a title is not a candidate at all (fuzzy-match.ts:
 * 60 per term found whole, 40/30 per term one or two edits away, 20 for an
 * abbreviation). */
const MIN_FUZZY_SCORE = 30;
/** A whole-query hit (exact, prefix, or substring of the title) outranks any
 * term-by-term match, so it is never disambiguated against one. */
const WHOLE_QUERY_SCORE = 70;
/** Two fuzzy candidates this close are a real toss-up; ask rather than guess. */
const CLEAR_LEAD = 15;

/** Words a spoken request carries that a title rarely does ("the profile
 * subtitles one", "my deploy session"). Dropped only when other terms remain. */
const FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "my",
  "our",
  "this",
  "that",
  "one",
  "please",
  "session",
  "sessions",
  "workspace",
  "workspaces",
  "of",
  "for",
  "to",
  "in",
  "on",
  "with",
  "about",
]);

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function stripFiller(query: string): string {
  const kept = query.split(" ").filter((term) => !FILLER_WORDS.has(term));
  return kept.length ? kept.join(" ") : query;
}

interface Pickable {
  id: string;
  title: string;
  recency?: string;
  parentSessionId?: string;
  spawnedBy?: string;
  agentStarted?: boolean;
  automation?: string;
  workspaceId?: string | null;
}

/** A session the app started on behalf of another: a spawned worker, the
 * auto-fix opened from a PR panel, or the headless review of a PR the primary
 * session owns. Their titles are near-copies of the primary's, so on a tie
 * the person almost always means the primary. Phrasing that singles the
 * derivative out ("the review of …") already outscores the primary above. */
function derivedFrom(child: Pickable, parent: Pickable): boolean {
  if (child.id === parent.id) return false;
  if (child.parentSessionId === parent.id || child.spawnedBy === parent.id)
    return true;
  const sharesWorkspace =
    !!child.workspaceId && child.workspaceId === parent.workspaceId;
  return (
    sharesWorkspace &&
    !parent.agentStarted &&
    !parent.automation &&
    (child.agentStarted === true || !!child.automation)
  );
}

function withoutDerivatives<T extends Pickable>(
  scored: Array<{ item: T; score: number }>,
): Array<{ item: T; score: number }> {
  return scored.filter(
    ({ item, score }) =>
      !scored.some(
        (other) => other.score >= score && derivedFrom(item, other.item),
      ),
  );
}

function byScoreThenRecency<T extends Pickable>(
  a: { item: T; score: number },
  b: { item: T; score: number },
): number {
  return (
    b.score - a.score ||
    (b.item.recency ?? "").localeCompare(a.item.recency ?? "")
  );
}

/** Exact names take precedence, but duplicate names always need clarification.
 * Otherwise titles are matched term by term with a small typo budget, so a
 * spoken "profile subtitle sidebar" still finds "Profile Subtitles sidebar
 * opening", and a derivative session never ties with its own primary. */
export function pick<T extends Pickable>(
  query: string,
  items: T[],
  what: string,
):
  | { item: T }
  | { error: string; candidates?: Array<{ id: string; title: string }> } {
  const q = normalize(query);
  if (!q) return { error: `Name the ${what} to show.` };
  const exact = withoutDerivatives(
    items
      .filter((item) => normalize(item.title) === q)
      .map((item) => ({ item, score: 100 })),
  );
  let ranked = exact;
  if (!exact.length) {
    const stripped = stripFiller(q);
    const scored = items
      .map((item) => ({
        item,
        score: Math.max(
          fuzzyScore(q, item.title),
          stripped === q ? 0 : fuzzyScore(stripped, item.title),
        ),
      }))
      .filter(({ score }) => score >= MIN_FUZZY_SCORE)
      .sort(byScoreThenRecency);
    if (!scored.length) return { error: `No ${what} matches "${query}".` };
    // A title that contains the whole query beats any term-wise match.
    const whole = scored.filter(({ score }) => score >= WHOLE_QUERY_SCORE);
    ranked = withoutDerivatives(whole.length ? whole : scored);
    if (
      ranked.length > 1 &&
      !whole.length &&
      ranked[0]!.score - ranked[1]!.score >= CLEAR_LEAD
    )
      ranked = [ranked[0]!];
  }
  if (ranked.length === 1) return { item: ranked[0]!.item };
  ranked.sort(byScoreThenRecency);
  return {
    error: `Several ${what}s match "${query}"; ask which one.`,
    candidates: ranked
      .slice(0, MAX_CANDIDATES)
      .map(({ item: { id, title } }) => ({ id, title })),
  };
}

function isShowTab(value: unknown): value is DeskShowTab {
  return (
    typeof value === "string" &&
    (DESK_SHOW_TABS as readonly string[]).includes(value)
  );
}

export async function resolveShowTarget(
  args: Record<string, unknown>,
  deps: {
    control: Pick<SessionControl, "listSessions" | "getSession">;
    listWorkspaces: () => Promise<Workspace[]>;
    getWorkspace: (id: string) => Promise<Workspace | null>;
  },
): Promise<ShowResolution> {
  const session = typeof args.session === "string" ? args.session.trim() : "";
  const workspace =
    typeof args.workspace === "string" ? args.workspace.trim() : "";

  if (
    Object.keys(args).some(
      (key) => key !== "session" && key !== "workspace" && key !== "tab",
    ) ||
    Boolean(session) === Boolean(workspace) ||
    (args.session !== undefined && typeof args.session !== "string") ||
    (args.workspace !== undefined && typeof args.workspace !== "string") ||
    session.length > 256 ||
    workspace.length > 256
  ) {
    return { error: "Name exactly one session or workspace to show." };
  }
  if (args.tab !== undefined && args.tab !== "" && !isShowTab(args.tab)) {
    return {
      error: `Unknown tab; use one of ${DESK_SHOW_TABS.join(", ")}.`,
    };
  }
  const tab = isShowTab(args.tab) ? { tab: args.tab } : {};

  if (session) {
    // The Desk itself is hidden from every list; a call never lands on it.
    const byId = deps.control.getSession(session);
    if (byId && !byId.desk)
      return {
        target: {
          kind: "session",
          id: byId.id,
          title: byId.title || "",
          ...tab,
        },
      };
    const visible = deps.control
      .listSessions()
      .filter((s) => !s.desk && s.state !== "archived")
      .map((s) => ({
        id: s.id,
        title: s.title || "",
        recency: s.lastActivity ?? s.createdAt,
        parentSessionId: s.parentSessionId,
        spawnedBy: s.spawnedBy,
        agentStarted: s.agentStarted,
        automation: s.automation,
        workspaceId: s.workspaceId,
      }));
    const found = pick(session, visible, "session");
    if ("error" in found) return found;
    return {
      target: {
        kind: "session",
        id: found.item.id,
        title: found.item.title,
        ...tab,
      },
    };
  }

  if (workspace) {
    const byId = await deps.getWorkspace(workspace);
    if (byId)
      return {
        target: { kind: "workspace", id: byId.id, name: byId.name, ...tab },
      };
    const all = (await deps.listWorkspaces()).map((w) => ({
      id: w.id,
      title: w.name,
      recency: w.createdAt,
    }));
    const found = pick(workspace, all, "workspace");
    if ("error" in found) return found;
    return {
      target: {
        kind: "workspace",
        id: found.item.id,
        name: found.item.title,
        ...tab,
      },
    };
  }

  return { error: "Say which session or workspace to show." };
}

/** Team members can view the shared session/workspace catalog, as in the UI.
 * The call-bound capability is the authorization to navigate one browser. It
 * exists only for verified web callers, never for native or generic MCP calls.
 */
export async function showInApp(
  navigation: Pick<DeskVoiceNavigation, "show"> | undefined,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!navigation)
    return {
      shown: false,
      error: "Navigation requires a signed-in browser connection.",
    };
  const resolved = await resolveShowTarget(args, {
    control: getSessionControl(),
    listWorkspaces,
    getWorkspace,
  });
  if ("error" in resolved) return resolved;
  const { target } = resolved;
  const safe = deskShowTargetSchema.safeParse({
    kind: target.kind,
    id: target.id,
    ...(target.tab ? { tab: target.tab } : {}),
  });
  if (!safe.success)
    return { shown: false, error: "That page cannot be opened by voice." };
  const result = await navigation.show(safe.data);
  return { ...target, ...result };
}
