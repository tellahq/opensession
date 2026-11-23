import type { OsReviewSummary } from "./types";

/** What a PR host supports, so clients can hide unsupported surfaces. */
export interface PrHostCapabilities {
  checks: boolean;
  reviewers: boolean;
  viewedState: boolean;
  stacks: boolean;
  reviewComments: boolean;
  prCreate: boolean;
  images: boolean;
  /** Git notes on commits (surfaced in the commits tab). */
  commitNotes: boolean;
  /** Queue a merge that lands once requirements pass ("Merge when ready"). */
  autoMerge?: boolean;
  /** Merge past branch protection with the viewer's own admin rights. */
  forceMerge?: boolean;
}

/** One PR in a stack, ordered from the trunk upward. */
export interface PrStackLayer {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  /** Position within the stack; 1 is the layer closest to the trunk. */
  position: number;
  /** True for the PR this stack was fetched for. */
  current?: boolean;
}

export interface PrStack {
  /** The provider-visible stack number. */
  number: number;
  /** Branch the bottom layer targets (the trunk the stack sits on). */
  baseRefName: string;
  size: number;
  /** Position of the PR this stack was fetched for. */
  position: number;
  /** Every layer, bottom (trunk-most) first. */
  layers: PrStackLayer[];
}

export interface PrCheck {
  name: string;
  status: string;
  conclusion: string;
  url?: string;
  startedAt?: string;
  completedAt?: string;
  /** CheckRun workflow name; status contexts have none. */
  workflowName?: string;
}

export interface PrComment {
  author: string;
  body: string;
  url?: string;
  createdAt?: string;
}

export interface PrStaging {
  url: string;
  status: string;
  embeddable?: boolean;
  /** The URL already serves a deploy, e.g. the previous one during a rebuild. */
  live?: boolean;
  /** Route the link opens when the session has no recorded preview path. */
  defaultPath?: string;
  /** The PR is merged and in production: the link is the production site,
   *  not the PR's preview. See pr-production-deploy.ts. */
  production?: boolean;
  /** The PR is merged and production has not deployed it yet: the link is
   *  still the preview, and turns into the production site once it has. */
  awaitingProduction?: boolean;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrReviewer {
  login: string;
  state:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "COMMENTED"
    | "DISMISSED"
    | "PENDING";
  isTeam?: boolean;
}

/** A git note attached to a commit, labeled by its notes ref namespace. */
export interface PrCommitNote {
  ref: string;
  text: string;
}

export interface PrCommit {
  oid: string;
  messageHeadline: string;
  messageBody?: string;
  authoredDate?: string;
  author: string;
  notes?: PrCommitNote[];
}

export interface PrDetails {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string;
  /** The commit the merge landed as on the base branch. */
  mergeCommitOid?: string;
  /** Full owner/name of the head repository. Different from the base repository for fork PRs. */
  headRepo?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author: string;
  /** Label names on the PR. Only populated by the REST automation lookup. */
  labels?: string[];
  body: string;
  checks: PrCheck[];
  comments: PrComment[];
  commits: PrCommit[];
  files: PrFile[];
  reviewers: PrReviewer[];
  mergeable: string;
  mergeStateStatus: string;
  /** Set while the host will merge this PR on its own once it is ready. */
  autoMerge?: PrAutoMerge | null;
  staging: PrStaging | null;
  stack?: PrStack | null;
  osReview?: OsReviewSummary;
  reviewActive?: boolean;
  capabilities?: PrHostCapabilities;
}

export interface PrDiffData {
  number: number;
  baseRefOid?: string;
  headRefOid: string;
  patch: string;
  diffVersion?: string;
  skippedFiles?: number;
}

export interface MutationPrMeta {
  number: number;
  headRefOid: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  url: string;
}

export interface PrCommentInput {
  body: string;
  path?: string;
  line?: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
  startSide?: "RIGHT" | "LEFT";
}

export interface PrReviewComment {
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
  startLine?: number;
  startSide?: "RIGHT" | "LEFT";
  body: string;
}

export type PrReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface PrReviewInput {
  event: PrReviewEvent;
  body?: string;
  comments: PrReviewComment[];
}

export type MergeMethod = "squash" | "merge" | "rebase";

/**
 * How a merge request lands: `now` merges immediately, `auto` asks the host to
 * merge once checks and reviews pass, `admin` merges past branch protection
 * with the caller's own rights, `disable-auto` withdraws an `auto` request.
 */
export type MergeMode = "now" | "auto" | "admin" | "disable-auto";

export interface PrAutoMerge {
  method: MergeMethod;
  enabledBy: string;
  enabledAt?: string;
}

export interface MergePrOptions {
  method?: MergeMethod;
  deleteBranch?: boolean;
  /** Skip our own stack-order gate. The host still enforces its rules. */
  force?: boolean;
  mode?: MergeMode;
  /** Refuse the merge if the head moved past this commit. */
  headSha?: string;
}

export type MergePrResult =
  | { ok: true; url?: string; merged: boolean; autoMerge?: boolean }
  | { error: string };
