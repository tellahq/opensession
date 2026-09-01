import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { githubAppRepositoryToken } from "./github-app";
import { stateDir } from "./paths";
import { requestRunnerBranchBundle } from "./runner-ws";
import { isRemoteSandboxProvider } from "./sandbox/config";
import { findSessionAsync } from "./session-cache";
import type { UnifiedSession } from "./types";
import { writeJsonAtomic } from "./shared/atomic-write";

export interface SessionPublicationResult {
  repo: string;
  branch: string;
  baseBranch: string;
  prUrl: string;
}

type GitResult = { exitCode: number; stdout: string; stderr: string };
interface PublicationDeps {
  findSession(id: string): Promise<UnifiedSession | undefined>;
  repositoryToken(repo: string): Promise<string | null>;
  baseCommit(repo: string, branch: string, token: string): Promise<string>;
  exportBundle(session: UnifiedSession, branch: string): Promise<Buffer>;
  runGit(
    cwd: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<GitResult>;
  request(url: string, init: RequestInit): Promise<Response>;
  receiptPath(sessionId: string, requestId: string): string;
}

function isolatedGitEnv(home: string): Record<string, string> {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };
}

async function runGit(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function localBranchBundle(
  session: UnifiedSession,
  branch: string,
): Promise<Buffer> {
  if (!session.worktreeDir || !existsSync(session.worktreeDir))
    throw new Error("Publication provider cannot export this workspace");
  const dir = mkdtempSync(join(tmpdir(), "opensession-bundle-export-"));
  const bundlePath = join(dir, "branch.bundle");
  try {
    const env = isolatedGitEnv(dir);
    const [head, status] = await Promise.all([
      runGit(session.worktreeDir, ["branch", "--show-current"], env),
      runGit(session.worktreeDir, ["status", "--porcelain"], env),
    ]);
    if (head.exitCode !== 0 || head.stdout.trim() !== branch)
      throw new Error("Publication workspace is not on its owned branch");
    if (status.exitCode !== 0 || status.stdout.trim())
      throw new Error("Publication workspace has uncommitted changes");
    const result = await runGit(
      session.worktreeDir,
      ["bundle", "create", bundlePath, `refs/heads/${branch}`],
      env,
    );
    if (result.exitCode !== 0)
      throw new Error(
        `Branch bundle export failed: ${result.stderr.slice(0, 300)}`,
      );
    return readFileSync(bundlePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function publicationBundleProvider(
  session: UnifiedSession,
): "runner" | "local" | "unavailable" {
  if (session.runner?.id) return "runner";
  if (
    session.sandbox?.provider &&
    isRemoteSandboxProvider(session.sandbox.provider)
  )
    return "unavailable";
  if (session.worktreeDir && existsSync(session.worktreeDir)) return "local";
  return "unavailable";
}

const defaultDeps: PublicationDeps = {
  findSession: findSessionAsync,
  repositoryToken: githubAppRepositoryToken,
  async baseCommit(repo, branch, token) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/git/ref/heads/${branch
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!response.ok)
      throw new Error(
        `Could not resolve protected base branch (${response.status})`,
      );
    const body = (await response.json()) as { object?: { sha?: string } };
    const oid = body.object?.sha;
    if (!oid || !/^[0-9a-f]{40,64}$/i.test(oid))
      throw new Error("Protected base branch returned an invalid commit");
    return oid;
  },
  exportBundle(session, branch) {
    const provider = publicationBundleProvider(session);
    if (provider === "runner") {
      const runner = session.runner!;
      return requestRunnerBranchBundle(runner.id, {
        sessionId: session.id,
        repo: session.automationDescendantPolicy?.repo || "",
        workspacePath: runner.workspacePath,
        branch,
      });
    }
    if (provider === "local") return localBranchBundle(session, branch);
    throw new Error("Publication provider cannot export this workspace");
  },
  runGit,
  request: (url, init) => fetch(url, init),
  receiptPath: (sessionId, requestId) =>
    stateDir(`publication-receipts/${sessionId}/${requestId}.json`),
};

function readReceipt(path: string): SessionPublicationResult | undefined {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8"),
    ) as SessionPublicationResult;
    if (value.repo && value.branch && value.baseBranch && value.prUrl)
      return value;
  } catch {}
  return undefined;
}

async function exactExistingPullRequest(
  deps: PublicationDeps,
  token: string,
  repo: string,
  branch: string,
  baseBranch: string,
): Promise<string | undefined> {
  const [owner, name] = repo.split("/");
  const query = new URLSearchParams({
    state: "open",
    head: `${owner}:${branch}`,
    base: baseBranch,
  });
  const response = await deps.request(
    `https://api.github.com/repos/${owner}/${name}/pulls?${query}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok) return undefined;
  const rows = (await response.json()) as Array<{
    html_url?: string;
    head?: { ref?: string; repo?: { full_name?: string } };
    base?: { ref?: string };
  }>;
  const exact = rows.find(
    (row) =>
      row.html_url &&
      row.head?.ref === branch &&
      row.head.repo?.full_name?.toLowerCase() === repo.toLowerCase() &&
      row.base?.ref === baseBranch,
  );
  return exact?.html_url;
}

/** Publish a credential-free branch bundle through a clean server-owned repo.
 * The child checkout is never run with publication credentials and callers can
 * select neither repository nor branch. */
export async function publishSessionBranch(
  sessionId: string,
  requestId: string,
  overrides: Partial<PublicationDeps> = {},
): Promise<SessionPublicationResult> {
  if (!requestId) throw new Error("Scoped publication requires a request id");
  const deps = { ...defaultDeps, ...overrides };
  const receiptPath = deps.receiptPath(sessionId, requestId);
  const receipt = readReceipt(receiptPath);
  if (receipt) return receipt;

  const session = await deps.findSession(sessionId);
  const policy = session?.automationDescendantPolicy;
  if (!session || !policy)
    throw new Error("Scoped publication requires an automation descendant");
  if (!session.branch)
    throw new Error("Scoped publication requires an isolated branch workspace");
  if (session.branch === policy.baseBranch)
    throw new Error("Scoped publication refuses the protected base branch");

  // Export before minting a token. Child-controlled hooks/config therefore
  // never coexist with a credential, even if bundle export is compromised.
  const bundle = await deps.exportBundle(session, session.branch);
  const publishDir = mkdtempSync(join(tmpdir(), "opensession-publisher-"));
  const bundlePath = join(publishDir, "branch.bundle");
  writeFileSync(bundlePath, bundle, { mode: 0o600 });
  try {
    const env = isolatedGitEnv(join(publishDir, "home"));
    let result = await deps.runGit(
      publishDir,
      ["init", "--bare", "repo.git"],
      env,
    );
    if (result.exitCode !== 0)
      throw new Error("Clean publication repo initialization failed");
    const repoDir = join(publishDir, "repo.git");
    result = await deps.runGit(repoDir, ["bundle", "verify", bundlePath], env);
    if (result.exitCode !== 0)
      throw new Error("Branch bundle validation failed");
    result = await deps.runGit(
      repoDir,
      ["bundle", "list-heads", bundlePath],
      env,
    );
    const expectedRef = `refs/heads/${session.branch}`;
    const heads = result.stdout.trim().split("\n").filter(Boolean);
    if (
      result.exitCode !== 0 ||
      heads.length !== 1 ||
      !heads[0].endsWith(` ${expectedRef}`)
    )
      throw new Error(
        "Branch bundle does not contain exactly the owned branch",
      );
    result = await deps.runGit(
      repoDir,
      ["bundle", "unbundle", bundlePath],
      env,
    );
    if (result.exitCode !== 0) throw new Error("Branch bundle import failed");
    const oid = heads[0].split(/\s+/, 1)[0];
    result = await deps.runGit(repoDir, ["update-ref", expectedRef, oid], env);
    if (result.exitCode !== 0)
      throw new Error("Imported branch validation failed");

    const token = await deps.repositoryToken(policy.publicationRepo);
    if (!token)
      throw new Error("Repository-scoped GitHub App token unavailable");
    const baseOid = await deps.baseCommit(
      policy.publicationRepo,
      policy.baseBranch,
      token,
    );
    result = await deps.runGit(
      repoDir,
      ["merge-base", "--is-ancestor", baseOid, oid],
      env,
    );
    if (result.exitCode !== 0)
      throw new Error(
        "Scoped publication refuses a branch that is not descended from the protected base",
      );

    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    const credentialEnv = {
      ...env,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_2: `Authorization: Basic ${basic}`,
    };
    result = await deps.runGit(
      repoDir,
      [
        "push",
        `https://github.com/${policy.publicationRepo}.git`,
        `${expectedRef}:${expectedRef}`,
      ],
      credentialEnv,
    );
    if (result.exitCode !== 0)
      throw new Error(
        `Scoped branch publication failed: ${result.stderr.slice(0, 300)}`,
      );

    const [owner, repo] = policy.publicationRepo.split("/");
    const response = await deps.request(
      `https://api.github.com/repos/${owner}/${repo}/pulls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: session.title || session.branch,
          head: session.branch,
          base: policy.baseBranch,
        }),
      },
    );
    let prUrl: string | undefined;
    if (response.ok) {
      const body = (await response.json()) as { html_url?: string };
      prUrl = body.html_url;
    } else if (response.status === 422) {
      prUrl = await exactExistingPullRequest(
        deps,
        token,
        policy.publicationRepo,
        session.branch,
        policy.baseBranch,
      );
    }
    if (!prUrl)
      throw new Error(
        `Scoped pull request publication failed (${response.status})`,
      );
    const published: SessionPublicationResult = {
      repo: policy.publicationRepo,
      branch: session.branch,
      baseBranch: policy.baseBranch,
      prUrl,
    };
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeJsonAtomic(receiptPath, published);
    return published;
  } finally {
    rmSync(publishDir, { recursive: true, force: true });
  }
}
