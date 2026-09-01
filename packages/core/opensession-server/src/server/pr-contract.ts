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
  /** Full owner/name of the head repository. Different from the base repository for fork PRs. */
  headRepo?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author: string;
  body: string;
  checks: PrCheck[];
  comments: PrComment[];
  commits: PrCommit[];
  files: PrFile[];
  reviewers: PrReviewer[];
  mergeable: string;
  mergeStateStatus: string;
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
