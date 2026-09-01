/**
 * GitHub stacked pull requests (public preview, 2026-07-30).
 *
 * A stack is an ordered chain of PRs where each layer targets the one below it
 * and the bottom targets the trunk. GitHub models it as a first-class object
 * (`PullRequest.stackEntry.stack`), so membership is authoritative — it is NOT
 * inferred from `baseRefName` chains, and two PRs that happen to target each
 * other are not a stack until they are linked.
 *
 * Read path: GraphQL only. `gh pr view --json` has no `stack` field (gh 2.83),
 * so this module shells `gh api graphql`. Every read is best-effort: a repo or
 * GHES that predates the preview answers with an "unknown field" error, which
 * disables the query process-wide (see `stackApiUnavailable`) rather than
 * failing PR fetches that would otherwise succeed.
 *
 * Enumerating the layers takes two paths, because on preview day one
 * `PullRequestStack.entries` answers INTERNAL for EVERY selection on a real
 * stack — even `totalCount` — and being non-null it nulls the whole `stack`
 * object with it (verified against a real stack). So the scalars are fetched WITHOUT `entries` and always resolve;
 * `entries` is attempted separately and, when it fails, `walkStackChain`
 * enumerates the layers by following base/head branch links — `stackEntry`
 * resolves fine per PR inside a list query, so each hop can prove its stack
 * membership. One `entries` failure disables that attempt process-wide, so the
 * steady state is one query plus one per layer. When GitHub fixes the
 * connection, a restart drops back to the single-query path.
 *
 * Write path: the `github/gh-stack` CLI extension. `gh stack link` is the one
 * command that needs no local stack-tracking state, which suits us — sessions
 * already own their branches and worktrees. There are no stack mutations in
 * the GraphQL schema, so the extension is the only write surface.
 */
import {
  resolveGithubCredential,
  serviceGithubCredential,
  type GithubCredential,
} from "./github-auth";
import {
  ghRateLimited,
  noteGhRateLimited,
  isGhRateLimitMsg,
} from "./github-limit";
import { audited } from "./audit";
import { noteGithubGraphqlCall } from "./github-budget";
import type { PrStack, PrStackLayer } from "./pr-contract";
export type { PrStack, PrStackLayer } from "./pr-contract";

/** The per-PR fields every layer is built from. */
const LAYER_FIELDS = "number title url state isDraft headRefName baseRefName";

/** Scalars only — no `entries`, whose failure would null the stack with it. */
const STACK_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      ${LAYER_FIELDS}
      stackEntry { position stack { number size baseRefName } }
    }
  }
}`;

/** The intended one-shot enumeration. Broken upstream as of 2026-07-30. */
const ENTRIES_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      stackEntry {
        stack {
          entries(first:50){
            nodes { position pullRequest { ${LAYER_FIELDS} } }
          }
        }
      }
    }
  }
}`;

/** One hop of the chain walk: the PR on a given head or base branch. */
const BY_REF_QUERY = (arg: "headRefName" | "baseRefName") => `
query($owner:String!,$name:String!,$ref:String!){
  repository(owner:$owner,name:$name){
    pullRequests(${arg}:$ref, states:[OPEN,MERGED], first:10, orderBy:{field:CREATED_AT,direction:DESC}){
      nodes { ${LAYER_FIELDS} stackEntry { position stack { number } } }
    }
  }
}`;

// Set once the API answers "field doesn't exist" — a deployment without the
// preview must not pay a doomed GraphQL call on every PR fetch. Resets on
// restart, which is the same escape hatch pr-info uses for statusCheckRollup.
let stackApiUnavailable = false;
// Set once `entries` answers INTERNAL, so we stop paying for a query we know
// fails and go straight to the chain walk. Also resets on restart, which is
// how a GitHub-side fix gets picked back up.
let entriesBroken = false;

/** True when a stack read was refused as an unknown field rather than failing. */
export function stackApiDisabled(): boolean {
  return stackApiUnavailable;
}

function isUnknownFieldMsg(msg: string): boolean {
  return /doesn't exist on type|Field '(stack|stackEntry)'|Unknown field/i.test(
    msg,
  );
}

function splitRepo(ghRepo: string): { owner: string; name: string } | null {
  const [owner, name] = ghRepo.split("/");
  return owner && name ? { owner, name } : null;
}

async function runGh(
  args: string[],
  credential: GithubCredential,
  cwd?: string,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["gh", ...args], {
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...credential.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/**
 * The stack a PR belongs to, or null when it belongs to none (the common case
 * — most PRs are standalone). Never throws: a stack is decoration on top of
 * the PR, and losing it must not take the PR panel down with it.
 */
export async function getPrStack(
  ghRepo: string,
  prNumber: number,
  credential: GithubCredential = serviceGithubCredential,
): Promise<PrStack | null> {
  if (stackApiUnavailable) return null;
  // A known rate-limit window: skip the call entirely rather than spend the
  // retry budget of a request we already expect to be refused.
  if (ghRateLimited()) return null;
  const repo = splitRepo(ghRepo);
  if (!repo) return null;
  try {
    credential = await resolveGithubCredential(credential, { repo: ghRepo });
  } catch {
    return null;
  }

  const head = await graphql(
    STACK_QUERY,
    { owner: repo.owner, name: repo.name },
    { number: prNumber },
    credential,
    `stack scalars for ${ghRepo}#${prNumber}`,
  );
  const pr = head?.data?.repository?.pullRequest;
  const entry = pr?.stackEntry;
  const stack = entry?.stack;
  if (!pr || !stack || typeof stack.number !== "number") return null;

  const self = toLayer(pr, entry.position, prNumber);
  const shell = {
    number: stack.number,
    baseRefName: stack.baseRefName || "",
    size: typeof stack.size === "number" ? stack.size : 1,
    position:
      typeof entry.position === "number" ? entry.position : self.position,
  };

  // The intended one-query enumeration, skipped once it has failed here.
  if (!entriesBroken) {
    const listed = await graphql(
      ENTRIES_QUERY,
      { owner: repo.owner, name: repo.name },
      { number: prNumber },
      credential,
      `stack entries for ${ghRepo}#${prNumber}`,
    );
    const parsed = listed ? parseStackResponse(listed, prNumber, shell) : null;
    if (parsed) return parsed;
    if (!entriesBroken) {
      entriesBroken = true;
      console.warn(
        "[pr-stack] PullRequestStack.entries is unusable — enumerating layers by walking the branch chain until restart",
      );
    }
  }

  const layers = await walkStackChain(repo, shell, self, credential);
  return { ...shell, layers };
}

function toLayer(pr: any, position: unknown, prNumber: number): PrStackLayer {
  return {
    number: pr.number,
    title: pr.title || `PR #${pr.number}`,
    url: pr.url || "",
    state: pr.state || "OPEN",
    isDraft: !!pr.isDraft,
    headRefName: pr.headRefName || "",
    baseRefName: pr.baseRefName || "",
    position: typeof position === "number" ? position : 0,
    current: pr.number === prNumber || undefined,
  };
}

/** Run a GraphQL document, returning the parsed body or null on any failure. */
async function graphql(
  query: string,
  strings: Record<string, string>,
  numbers: Record<string, number>,
  credential: GithubCredential,
  label: string,
): Promise<any | null> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(strings)) args.push("-f", `${k}=${v}`);
  for (const [k, v] of Object.entries(numbers)) args.push("-F", `${k}=${v}`);
  const started = Date.now();
  const { code, out, err } = await runGh(args, credential);
  noteGithubGraphqlCall("pr-stack", Date.now() - started, code === 0);
  if (code !== 0) {
    const msg = String(err || "gh api graphql failed").slice(0, 300);
    if (isUnknownFieldMsg(msg)) {
      stackApiUnavailable = true;
      console.warn(
        `[pr-stack] stack API unavailable — skipping stack reads until restart: ${msg.slice(0, 120)}`,
      );
      return null;
    }
    if (isGhRateLimitMsg(msg)) noteGhRateLimited("pr-stack");
    // A partial response still carries usable `data`, and gh prints it on
    // stdout even when it exits non-zero — so fall through and parse rather
    // than discarding a body that may hold everything we asked for.
    if (!out.trim()) {
      console.warn(`[pr-stack] ${label} failed: ${msg}`);
      return null;
    }
  }
  try {
    return JSON.parse(out);
  } catch {
    console.warn(`[pr-stack] ${label} returned an unparseable body`);
    return null;
  }
}

/**
 * Enumerate a stack's layers by following branch links: each layer targets the
 * branch of the one below it. Walks down from `self` to the trunk, then up to
 * the top, keeping only PRs that report the SAME stack number — a PR that
 * merely targets the same branch is not a layer.
 *
 * Bounded by the stack's own `size` so a base-branch cycle can't spin, and
 * every hop is optional: a walk that stops early yields a shorter map, which
 * is still better than none.
 */
async function walkStackChain(
  repo: { owner: string; name: string },
  stack: { number: number; size: number; baseRefName: string },
  self: PrStackLayer,
  credential: GithubCredential,
): Promise<PrStackLayer[]> {
  const found = new Map<number, PrStackLayer>([[self.number, self]]);

  const hop = async (
    arg: "headRefName" | "baseRefName",
    ref: string,
  ): Promise<PrStackLayer | null> => {
    const body = await graphql(
      BY_REF_QUERY(arg),
      { owner: repo.owner, name: repo.name, ref },
      {},
      credential,
      `stack chain hop ${arg}=${ref}`,
    );
    const nodes: any[] = body?.data?.repository?.pullRequests?.nodes || [];
    for (const node of nodes) {
      if (!node?.number || found.has(node.number)) continue;
      if (node.stackEntry?.stack?.number !== stack.number) continue;
      return toLayer(node, node.stackEntry.position, self.number);
    }
    return null;
  };

  // Down toward the trunk: the layer below is the PR whose head IS our base.
  let cursor = self;
  for (
    let i = 0;
    i < stack.size && cursor.baseRefName !== stack.baseRefName;
    i++
  ) {
    const below = await hop("headRefName", cursor.baseRefName);
    if (!below) break;
    found.set(below.number, below);
    cursor = below;
  }
  // Up toward the top: the layer above is the PR whose base IS our head.
  cursor = self;
  for (let i = 0; i < stack.size && found.size < stack.size; i++) {
    const above = await hop("baseRefName", cursor.headRefName);
    if (!above) break;
    found.set(above.number, above);
    cursor = above;
  }

  return [...found.values()].sort((a, b) => a.position - b.position);
}

/** The stack scalars, already read; `entries` only supplies the layer list. */
interface StackShell {
  number: number;
  baseRefName: string;
  size: number;
  position: number;
}

/**
 * Shape an `entries` response into a PrStack, using scalars already read by
 * the caller. Exported for tests — the live query needs a repo with an actual
 * stack on it, which no test can conjure. Returns null for every "no layers
 * here" case, including the partial response GitHub currently returns, so the
 * caller falls back to the chain walk.
 */
export function parseStackResponse(
  parsed: any,
  prNumber: number,
  shell?: StackShell,
): PrStack | null {
  // A partial GraphQL response still carries `data`; on some gh versions an
  // unknown field surfaces here rather than as a non-zero exit.
  const errors = parsed?.errors;
  if (Array.isArray(errors) && errors.length) {
    const msg = String(errors[0]?.message || "").slice(0, 300);
    if (isUnknownFieldMsg(msg)) {
      stackApiUnavailable = true;
      console.warn(
        `[pr-stack] stack API unavailable — skipping stack reads until restart: ${msg.slice(0, 120)}`,
      );
    }
    return null;
  }
  const entry = parsed?.data?.repository?.pullRequest?.stackEntry;
  const stack = entry?.stack;
  if (!stack && !shell) return null;

  const layers: PrStackLayer[] = (stack?.entries?.nodes || [])
    .filter((node: any) => node?.pullRequest?.number != null)
    .map((node: any) => toLayer(node.pullRequest, node.position, prNumber))
    .sort((a: PrStackLayer, b: PrStackLayer) => a.position - b.position);
  if (!layers.length) return null;

  const number = shell?.number ?? stack?.number;
  if (typeof number !== "number") return null;
  // A stack we can see but whose entry position is missing would read as
  // position 0 — below every layer — which silently disables the merge guard.
  // Fall back to where this PR actually sits.
  const position =
    shell?.position ??
    (typeof entry?.position === "number"
      ? entry.position
      : layers.find((l) => l.number === prNumber)?.position || 0);

  return {
    number,
    baseRefName: shell?.baseRefName ?? stack?.baseRefName ?? "",
    size:
      shell?.size ??
      (typeof stack?.size === "number" ? stack.size : layers.length),
    position,
    layers,
  };
}

/**
 * Layers below `stack.position` that are still open. Merging a layer while one
 * of these is unmerged would land its commits into the trunk out of order, so
 * the merge routes refuse it (GitHub's own stack merge is the way to take
 * several layers at once).
 */
export function unmergedLayersBelow(stack: PrStack): PrStackLayer[] {
  return stack.layers.filter(
    (layer) => layer.position < stack.position && layer.state === "OPEN",
  );
}

/** The registered GitHub repository a stack command's `cwd` belongs to, so
 * its service token comes from that owner's installation. */
async function repoForCwd(cwd: string): Promise<{ repo?: string }> {
  const { repoForPathOrNull } = await import("./worktree");
  const repo = repoForPathOrNull(cwd);
  return repo?.host !== "codestorage" && repo?.ghRepo
    ? { repo: repo.ghRepo }
    : {};
}

/**
 * Link PRs into a stack on GitHub, bottom first. Takes PR *URLs* rather than
 * branch names on purpose: `gh stack link` pushes branch arguments and opens
 * PRs for any that lack one, which is far too much to do behind a UI button —
 * URLs only ever link PRs that already exist, and they name the repo
 * unambiguously (the command has no `--repo` flag and reads its remote from
 * `cwd`).
 */
export async function linkPrStack(
  prUrls: string[],
  cwd: string,
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true } | { error: string }> {
  credential = await resolveGithubCredential(credential, {
    write: true,
    ...(await repoForCwd(cwd)),
  });
  if (prUrls.length < 2)
    return { error: "A stack needs at least two pull requests" };

  return audited(
    {
      context: "reviews",
      action: "pr_stack_link",
      args: { prUrls, cwd, credential: credential.principal },
    },
    async () => {
      const { code, err } = await runGh(
        ["stack", "link", ...prUrls],
        credential,
        cwd,
      );
      if (code !== 0) {
        const msg = String(err || "gh stack link failed").slice(0, 300);
        if (/unknown command|extension|not installed/i.test(msg))
          return {
            error:
              "The gh-stack extension isn't installed on this server (`gh extension install github/gh-stack`).",
          } as const;
        return { error: msg } as const;
      }
      return { ok: true } as const;
    },
  );
}

/**
 * Merge a stack up to and including `prNumber` through GitHub's atomic stack
 * merge — every layer from the trunk up to that PR lands in one all-or-nothing
 * operation, so the trunk never sees a half-merged stack.
 *
 * This is the answer to the gate in mergePr(): a single layer can't merge while
 * the layers below it are open, and merging them one `gh pr merge` at a time
 * would rewrite each remaining layer's base between calls. `--yes` is what
 * makes the command non-interactive (it otherwise opens a wizard); the merge
 * method is always passed explicitly rather than inheriting gh's "last used"
 * default, which is per-machine state we don't control.
 *
 * Like `gh stack link` the command has no `--repo` flag and reads its remote
 * from `cwd`, so it must run inside a checkout of the repo. GitHub evaluates
 * branch protection and repo rules when the merge runs, and reports a refusal
 * back through the exit code — nothing here bypasses them.
 */
export async function mergePrStack(
  prNumber: number,
  cwd: string,
  opts: { method?: "merge" | "squash" | "rebase" } = {},
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true } | { error: string }> {
  credential = await resolveGithubCredential(credential, {
    write: true,
    ...(await repoForCwd(cwd)),
  });
  const method = opts.method || "squash";
  return audited(
    {
      context: "reviews",
      action: "pr_stack_merge",
      args: { number: prNumber, method, cwd, credential: credential.principal },
    },
    async () => {
      const { code, err } = await runGh(
        ["stack", "merge", String(prNumber), "--yes", `--${method}`],
        credential,
        cwd,
      );
      if (code !== 0) {
        const msg = String(err || "gh stack merge failed").slice(0, 300);
        if (/unknown command|extension|not installed/i.test(msg))
          return {
            error:
              "The gh-stack extension isn't installed on this server (`gh extension install github/gh-stack`).",
          } as const;
        return { error: msg } as const;
      }
      return { ok: true } as const;
    },
  );
}
