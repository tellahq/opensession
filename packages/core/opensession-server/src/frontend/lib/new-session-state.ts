import { z } from "zod";
import type { OpenPr } from "./api";
import { getDefaultRepoPref, setDefaultRepoPref } from "./default-repo-pref";
import type { FileAttachment } from "./images";
import { NO_REPO } from "./session-repo";
import type {
  UnifiedSession,
  Workspace,
  WSClientMessage,
  WSServerMessage,
} from "./types";

export interface NewSessionProps {
  /** Close the palette (Esc, backdrop click, or after a create without "Create more"). */
  onBack: () => void;
  /**
   * Render the same card on the page instead of over a backdrop: the empty
   * state's session input. There is no view behind it to dismiss back to, so
   * the create options collapse to the one that means anything (open what you
   * just made) and `onBack` is only the reset after a create.
   */
  inline?: boolean;
  /** Inline only: bumping this puts the caret back in the prompt. The sidebar's
      draft row points at this field. */
  focusSeq?: number;
  send: (msg: WSClientMessage) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  connected: boolean;
  /** Prefill the prompt (e.g. from the Home "New session" box). */
  prefillPrompt?: string;
  /** Services selected before the palette opens, such as from a command-menu
   *  shortcut. They use the same chips and create payload as manual picks. */
  initialMcpServers?: string[];
  forceMode?: "ask" | "code" | "scratch";
  /** When starting a session inside a workspace, the session joins that workspace… */
  workspaceId?: string;
  /** Workspace whose model combinations this new, independent session can use. */
  modelWorkspaceId?: string;
  /** …and defaults to the workspace's shared repo + worktree (a sibling's branch). */
  forceRepo?: string;
  forceBranch?: string;
  /** Known workspaces and sessions let a PR create adopt the PR's existing
      workspace instead of opening a duplicate lane for the same branch. */
  workspaces: Workspace[];
  sessions: UnifiedSession[];
  /** Lets App render the pending session shell before the created session appears
      in the polled session list. */
  onCreateStarted?: (draft: NewSessionCreateDraft) => void;
}

export interface NewSessionCreateDraft {
  /** The client-minted id the server persists for this session. */
  id: string;
  prompt: string;
  mode: "ask" | "code" | "scratch";
  repo: string;
  branch: string | null;
  workspaceId?: string;
  model?: string;
  images?: string[];
  files?: FileAttachment[];
  /** Large pastes sent beside the prompt; the optimistic bubble shows them as cards. */
  pastedTexts?: string[];
  /** Open the optimistic session as soon as the create message is sent. */
  openImmediately?: boolean;
  /** Start the session without following it. */
  background?: boolean;
}

export interface Worktree {
  branch: string;
  path: string;
}

export type SessionStartPoint =
  | { kind: "new" }
  | { kind: "worktree"; branch: string }
  | { kind: "pull-request"; pullRequest: OpenPr };

export interface RepoOption {
  id: string;
  label: string;
  default?: boolean;
  /** A repo whose sessions share one live checkout can be the session's own
   *  repo, but never a second one: there is no isolated worktree to attach. */
  sharedCheckout?: boolean;
}

const LAST_REPO_KEY = "opensession-new-session-repo";
const SIDEBAR_FILTER_SCHEMA = z.object({ repo: z.string().optional() });

/**
 * The repo a fresh palette starts on, for someone who hasn't set a preference.
 *
 * This used to be stickiness: whatever you picked last was silently pinned as
 * your default. Carry that value into the real preference once, then retire the
 * old key.
 */
export function migratedRepoPref(): string {
  const preferred = getDefaultRepoPref();
  if (preferred) return preferred;
  try {
    const sticky = localStorage.getItem(LAST_REPO_KEY);
    if (!sticky) return "";
    localStorage.removeItem(LAST_REPO_KEY);
    if (sticky === "auto") return "";
    setDefaultRepoPref(sticky);
    return sticky;
  } catch {
    return "";
  }
}

// The repo the sidebar is currently filtered to (persisted by Sidebar.tsx under
// this key). When set to a real repo, a new session should default to it so
// creating from a repo-filtered view lands on that repo.
function filteredRepo(): string | null {
  try {
    const parsed = SIDEBAR_FILTER_SCHEMA.safeParse(
      JSON.parse(localStorage.getItem("opensession-sidebar-filter") || "{}"),
    );
    return parsed.success ? (parsed.data.repo ?? null) : null;
  } catch {
    return null;
  }
}

/** Deep-link prefill: <base>/new?mode=ask|code&prompt=…&branch=…&repo= */
export function readPrefill() {
  const params = new URLSearchParams(location.search);
  // An explicit ?repo= wins (legacy ?project= still honored); otherwise keep
  // the user's last picker choice across closes/reloads, then use the sidebar
  // filter. The configured default is applied once `/repos` resolves.
  const rawRepoParam = params.get("repo") ?? params.get("project");
  // "auto" was a short-lived picker sentinel, never a repository id.
  const repoParam = rawRepoParam === "auto" ? "" : rawRepoParam;
  const mode =
    params.get("mode") === "ask" ? ("ask" as const) : ("code" as const);
  // `?repo=none` is honored in either mode: Ask with no repo reads nothing,
  // Code with no repo is a scratch session. Ask defaults to no repo, matching
  // the toggle — otherwise an Ask deep link would silently inherit whichever
  // repo the last code session used.
  const repo =
    repoParam ||
    (mode === "ask" ? NO_REPO : migratedRepoPref() || filteredRepo() || "");
  return {
    mode,
    prompt: params.get("prompt") || "",
    branch: params.get("branch") || "",
    repo,
  };
}

/** The workspace name a draft auto-follows: the prompt's first non-empty
 *  line, trimmed and capped. Mirrors the server's own follow in
 *  updateWorkspace (workspaces.ts). */
export function firstNonEmptyLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? ""
  );
}

export type PendingDraftPark = {
  text: string;
  workspaceId?: string;
  consumed: boolean;
  /** The existing workspace the create adopted. When absent, the create made
   *  another workspace and a late unscoped park can be deleted outright. */
  consumedIntoWorkspaceId?: string;
};

// A dismissed palette can be reopened while its workspace request is still in
// flight. If that prompt starts a session first, the late response must not
// leave a second, stale draft workspace behind.
export const pendingDraftParks = new Set<PendingDraftPark>();

export function consumePendingDraftParks(
  text: string,
  workspaceId: string | undefined,
  consumedIntoWorkspaceId?: string,
) {
  for (const operation of pendingDraftParks) {
    if (operation.text === text && operation.workspaceId === workspaceId) {
      operation.consumed = true;
      operation.consumedIntoWorkspaceId = consumedIntoWorkspaceId;
    }
  }
}

export function draftParkInFlight(text: string, workspaceId?: string): boolean {
  return [...pendingDraftParks].some(
    (operation) =>
      !operation.consumed &&
      operation.text === text &&
      operation.workspaceId === workspaceId,
  );
}
