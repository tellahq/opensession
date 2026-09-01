/**
 * GitHub's per-viewer "Viewed" state on PR files, over the GraphQL API
 * (`viewerViewedState` + the markFileAsViewed/unmarkFileAsViewed mutations).
 *
 * Viewed state is per GitHub account, so calls prefer the requester's
 * connected App user token (github-auth.ts) and fall back to the workspace App.
 * With the fallback, teammates share the App's view state. GitHub also owns the staleness
 * semantics: a file changed after being viewed comes back DIRTY, which we
 * treat as not viewed (same as github.com's file list).
 */

import type { RouteContext } from "./routes/context";
import { githubCredentialForLogin, githubUserLoginForRun } from "./github-auth";
import {
  botGhToken,
  ghRateLimited,
  isGhRateLimitMsg,
  noteGhRateLimited,
} from "./github-limit";
import { noteGithubGraphqlCall } from "./github-budget";
import { githubMutationCredential } from "./routes/github-credential";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";

export interface PrViewedFiles {
  /** GraphQL node id for the PR — clients echo it back on toggles. */
  prId: string;
  /** Paths whose viewerViewedState is VIEWED (DIRTY/UNVIEWED excluded). */
  viewed: string[];
}

/** The requester's App user token, else the workspace installation token. */
async function viewerToken(
  ctx: RouteContext,
  claimedUser?: string | null,
): Promise<string | null> {
  // Use the same request-scoped resolver as the other human-triggered PR
  // actions. In simple mode this selects the sole connected account; with
  // sign-in enabled it selects only the verified requester's account.
  const requestCredential = githubMutationCredential(ctx);
  if (requestCredential?.env.GH_TOKEN) return requestCredential.env.GH_TOKEN;

  // Preserve the older identity-table lookup for deployments that still send
  // a claimed user without web sign-in, then use the workspace App fallback.
  const login = ctx.authUser?.login ?? githubUserLoginForRun(claimedUser);
  if (login) {
    const credential = githubCredentialForLogin(login);
    if (credential?.env.GH_TOKEN) return credential.env.GH_TOKEN;
  }
  return botGhToken({ write: true });
}

async function graphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<any> {
  if (ghRateLimited()) throw new Error("GitHub GraphQL is rate-limited");
  const started = Date.now();
  const res = await fetchWithTimeout(
    "https://api.github.com/graphql",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
    15_000,
  );
  const data = (await res.json().catch(() => null)) as any;
  const ok = res.ok && !!data && !data.errors?.length;
  noteGithubGraphqlCall("pr-viewed", Date.now() - started, ok);
  if (!ok) {
    const message =
      data?.errors?.[0]?.message ||
      data?.message ||
      `GitHub HTTP ${res.status}`;
    if (isGhRateLimitMsg(message)) noteGhRateLimited("pr-viewed");
    throw new Error(message);
  }
  return data.data;
}

const VIEWED_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      files(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`;

/** All VIEWED paths on a PR for the requesting viewer, plus the PR node id. */
export async function getPrViewedFiles(
  ctx: RouteContext,
  claimedUser: string | null,
  ghRepo: string,
  number: number,
): Promise<PrViewedFiles> {
  const token = await viewerToken(ctx, claimedUser);
  if (!token) throw new Error("No GitHub credential available");
  const [owner, name] = ghRepo.split("/");
  const viewed: string[] = [];
  let prId = "";
  let cursor: string | null = null;
  // 100 files/page; 30 pages ≈ GitHub's own 3000-file diff display cap.
  for (let page = 0; page < 30; page++) {
    const data = await graphql(token, VIEWED_QUERY, {
      owner,
      name,
      number,
      cursor,
    });
    const pull = data?.repository?.pullRequest;
    if (!pull) throw new Error("Pull request not found");
    prId = pull.id;
    for (const node of pull.files?.nodes || []) {
      if (node?.viewerViewedState === "VIEWED") viewed.push(node.path);
    }
    if (!pull.files?.pageInfo?.hasNextPage) break;
    cursor = pull.files.pageInfo.endCursor;
  }
  return { prId, viewed };
}

/** Mark or unmark one file as viewed for the requesting viewer. */
export async function setPrFileViewed(
  ctx: RouteContext,
  claimedUser: string | null,
  prId: string,
  filePath: string,
  viewed: boolean,
): Promise<void> {
  const token = await viewerToken(ctx, claimedUser);
  if (!token) throw new Error("No GitHub credential available");
  const mutation = viewed
    ? `mutation($id: ID!, $path: String!) { markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`
    : `mutation($id: ID!, $path: String!) { unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`;
  await graphql(token, mutation, { id: prId, path: filePath });
}
