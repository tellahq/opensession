/**
 * Posts the "OS approval gate" check run (policy in approval-gate-policy.ts).
 * Its settings and CODEOWNERS are read from the default branch through the
 * API, never from the PR head or a local checkout.
 *
 * The App posts it, not a workflow: a ruleset that requires the check with
 * this App as its source accepts it from nowhere else, while a status from
 * GitHub Actions could come from any workflow a PR adds. The check uses its
 * own checks-only token, so an installation that has not accepted
 * `checks: write` loses only this check, which then never appears and keeps
 * blocking where it is required.
 *
 * Refreshed on every event that can change the answer: a PR opened, pushed
 * or retargeted, a formal review submitted or dismissed, a finished OS
 * review, and the check's own Re-run button. Each refresh reads the current
 * state from GitHub, so a late or duplicate delivery cannot post an answer
 * for an old head. Refreshes of one PR run one at a time.
 */
import { audit } from "../../server/audit";
import { isGithubBotLogin } from "../../server/config";
import { githubRequest } from "./github-rest";
import { readPrState } from "./state";
import {
  CODEOWNERS_LOCATIONS,
  evaluateApprovalGate,
  normalizeApprovalGateConfig,
  ownedFiles,
  parseCodeowners,
  type ApprovalGateConfig,
  type CodeownersRule,
  type GateResult,
  type GateReview,
} from "./approval-gate-policy";

const OPTIONS_FILE = ".os-review.json";
const CONFIG_TTL_MS = 60_000;
const PERMISSION_TTL_MS = 10 * 60_000;
/** GitHub's pulls/files endpoint stops at 3000 files. */
const MAX_FILE_PAGES = 30;
const MAX_REVIEW_PAGES = 5;

const configCache = new Map<
  string,
  { at: number; config: ApprovalGateConfig | null }
>();
const permissionCache = new Map<string, { at: number; canApprove: boolean }>();
const codeownersCache = new Map<
  string,
  { at: number; rules: CodeownersRule[] }
>();
const teamCache = new Map<string, { at: number; member: boolean }>();
/** Last posted answer per PR, so a repeat refresh does not add a check run. */
const lastPosted = new Map<string, string>();
const chains = new Map<string, Promise<void>>();

/** The gate config from `.os-review.json` on the DEFAULT branch, never the PR
 *  head or a shared checkout: the policy a PR is judged by is not the PR's to
 *  edit. Null when the file, the key, or GitHub is unavailable (gate off). */
export async function loadApprovalGateConfig(
  ghRepo: string,
): Promise<ApprovalGateConfig | null> {
  const key = ghRepo.toLowerCase();
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;
  const text = await defaultBranchFile(ghRepo, OPTIONS_FILE);
  // Keep the last known answer through a GitHub hiccup.
  if (text === undefined) return cached?.config ?? null;
  let config: ApprovalGateConfig | null = null;
  if (text !== null) {
    try {
      config = normalizeApprovalGateConfig(JSON.parse(text)?.approvalGate);
    } catch {
      console.warn(`[github] ${ghRepo} ${OPTIONS_FILE} is not valid JSON`);
    }
  }
  configCache.set(key, { at: Date.now(), config });
  return config;
}

/** A file's text on the default branch: null when it does not exist,
 *  undefined when GitHub could not say. */
async function defaultBranchFile(
  ghRepo: string,
  path: string,
): Promise<string | null | undefined> {
  const r = await githubRequest<{ content?: string; encoding?: string }>(
    "GET",
    `/repos/${ghRepo}/contents/${path}`,
  );
  if (r.status === 404) return null;
  if (!r.ok || typeof r.data?.content !== "string") return undefined;
  if (r.data.encoding !== "base64") return undefined;
  return Buffer.from(r.data.content, "base64").toString("utf-8");
}

/** The CODEOWNERS rules GitHub enforces on the default branch: the first of
 *  its three locations that exists. Null when GitHub could not say, since
 *  owners then cannot be ruled out and the gate posts nothing. */
async function loadCodeowners(
  ghRepo: string,
): Promise<CodeownersRule[] | null> {
  const key = ghRepo.toLowerCase();
  const cached = codeownersCache.get(key);
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.rules;
  let rules: CodeownersRule[] = [];
  for (const path of CODEOWNERS_LOCATIONS) {
    const text = await defaultBranchFile(ghRepo, path);
    if (text === undefined) return cached?.rules ?? null;
    if (text !== null) {
      rules = parseCodeowners(text);
      break;
    }
  }
  codeownersCache.set(key, { at: Date.now(), rules });
  return rules;
}

/** Whether `login` is an active member of `@org/team`. Unknown counts as no. */
async function inTeam(owner: string, login: string): Promise<boolean> {
  const [org, team] = owner.replace(/^@/, "").split("/");
  if (!org || !team) return false;
  const key = `${owner}:${login.toLowerCase()}`;
  const cached = teamCache.get(key);
  if (cached && Date.now() - cached.at < PERMISSION_TTL_MS)
    return cached.member;
  const r = await githubRequest<{ state?: string }>(
    "GET",
    `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`,
    undefined,
    { mint: "read", owner: org },
  );
  const member = r.ok && r.data?.state === "active";
  if (r.ok || r.status === 404) teamCache.set(key, { at: Date.now(), member });
  return member;
}

async function pagedList<T>(
  path: string,
  maxPages: number,
): Promise<T[] | null> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await githubRequest<T[]>(
      "GET",
      `${path}${sep}per_page=100&page=${page}`,
    );
    if (!r.ok || !Array.isArray(r.data)) return null;
    out.push(...r.data);
    if (r.data.length < 100) break;
  }
  return out;
}

async function canApprove(ghRepo: string, login: string): Promise<boolean> {
  const key = `${ghRepo.toLowerCase()}:${login.toLowerCase()}`;
  const cached = permissionCache.get(key);
  if (cached && Date.now() - cached.at < PERMISSION_TTL_MS)
    return cached.canApprove;
  const r = await githubRequest<{ permission?: string }>(
    "GET",
    `/repos/${ghRepo}/collaborators/${encodeURIComponent(login)}/permission`,
  );
  // Unknown counts as no: an approval that cannot be verified does not pass.
  const ok =
    r.ok &&
    ["admin", "maintain", "write"].includes(String(r.data?.permission || ""));
  if (r.ok) permissionCache.set(key, { at: Date.now(), canApprove: ok });
  return ok;
}

function matchGlob(glob: string, path: string): boolean {
  try {
    return new Bun.Glob(glob).match(path);
  } catch {
    return false;
  }
}

async function postCheck(
  ghRepo: string,
  prNumber: number,
  headSha: string,
  htmlUrl: string,
  config: ApprovalGateConfig,
  result: GateResult,
): Promise<void> {
  const key = `${ghRepo.toLowerCase()}#${prNumber}`;
  const fingerprint = `${headSha}|${result.status}|${"conclusion" in result ? result.conclusion : ""}|${result.title}`;
  if (lastPosted.get(key) === fingerprint) return;
  const body = {
    name: config.checkName,
    head_sha: headSha,
    ...(htmlUrl ? { details_url: htmlUrl } : {}),
    ...(result.status === "completed"
      ? {
          status: "completed",
          conclusion: result.conclusion,
          completed_at: new Date().toISOString(),
        }
      : { status: "in_progress" }),
    output: { title: result.title.slice(0, 255), summary: result.summary },
  };
  const r = await githubRequest("POST", `/repos/${ghRepo}/check-runs`, body, {
    mint: "checks",
  });
  if (!r.ok) {
    console.warn(
      `[github] approval gate check for ${ghRepo}#${prNumber} not posted (${r.status}): ${r.error || "unknown"}${r.status === 403 || r.status === 0 ? " — the App needs the Checks: read and write permission" : ""}`,
    );
    return;
  }
  lastPosted.set(key, fingerprint);
  audit({
    msg: "approval_gate_posted",
    repo: ghRepo,
    pr_number: prNumber,
    head_sha: headSha,
    status: result.status,
    conclusion: "conclusion" in result ? result.conclusion : undefined,
    title: result.title,
  });
}

async function refreshOnce(prNumber: number, ghRepo: string): Promise<void> {
  const config = await loadApprovalGateConfig(ghRepo);
  if (!config) return;
  const pr = await githubRequest<any>(
    "GET",
    `/repos/${ghRepo}/pulls/${prNumber}`,
  );
  if (!pr.ok || !pr.data) return;
  const p = pr.data;
  if (p.state !== "open" || !p.head?.sha) return;
  const headSha: string = p.head.sha;
  const author: string = p.user?.login || "";
  const headRepo = String(p.head?.repo?.full_name || "").toLowerCase();
  // A deleted head repository reads as null: treat it as outside too.
  const fromFork = headRepo !== ghRepo.toLowerCase();

  const [files, reviews, codeowners] = await Promise.all([
    pagedList<any>(`/repos/${ghRepo}/pulls/${prNumber}/files`, MAX_FILE_PAGES),
    pagedList<any>(
      `/repos/${ghRepo}/pulls/${prNumber}/reviews`,
      MAX_REVIEW_PAGES,
    ),
    loadCodeowners(ghRepo),
  ]);
  // A partial read could miss an owner or a change request: post nothing and
  // let the next event (or Re-run) try again.
  if (!files || !reviews || !codeowners) return;
  const paths = files.flatMap((f) =>
    [f.filename, f.previous_filename].filter(
      (x): x is string => typeof x === "string" && !!x,
    ),
  );
  const changedFiles = Number(p.changed_files);
  const filesComplete =
    Number.isFinite(changedFiles) && files.length >= changedFiles;

  const gateReviews: GateReview[] = reviews.map((r) => ({
    login: r.user?.login || "",
    userType: r.user?.type || "",
    state: r.state || "",
    commitId: r.commit_id || "",
  }));
  const candidates = [
    ...new Set(
      gateReviews
        .filter(
          (r) =>
            r.login &&
            r.userType === "User" &&
            r.login.toLowerCase() !== author.toLowerCase() &&
            !isGithubBotLogin(r.login),
        )
        .map((r) => r.login),
    ),
  ];
  const approvers = new Set<string>();
  for (const login of candidates) {
    if (await canApprove(ghRepo, login)) approvers.add(login.toLowerCase());
  }

  // Which owner tokens each approver of the head satisfies: their own
  // `@login`, plus every owning team of a changed file they belong to.
  const owned = ownedFiles({ files: paths, codeowners, matchGlob });
  const teams = [
    ...new Set(owned.flatMap((f) => f.owners).filter((o) => o.includes("/"))),
  ];
  const ownerTokens = new Map<string, Set<string>>();
  for (const r of gateReviews) {
    const login = r.login.toLowerCase();
    if (r.state !== "APPROVED") continue;
    if (config.requireApprovalOnHead && r.commitId !== headSha) continue;
    if (!approvers.has(login) || ownerTokens.has(login)) continue;
    const tokens = new Set([`@${login}`]);
    for (const team of teams) if (await inTeam(team, r.login)) tokens.add(team);
    ownerTokens.set(login, tokens);
  }

  const result = evaluateApprovalGate({
    headSha,
    author,
    fromFork,
    files: paths,
    filesComplete,
    lastReview: (await readPrState(prNumber, ghRepo))?.lastReview ?? null,
    reviews: gateReviews,
    approvers,
    codeowners,
    ownerTokens,
    ...(config.maxRisk ? { maxRisk: config.maxRisk } : {}),
    ...(config.requireApprovalOnHead ? { requireApprovalOnHead: true } : {}),
    matchGlob,
  });
  await postCheck(ghRepo, prNumber, headSha, p.html_url || "", config, result);
}

/** Re-evaluate and post the gate for one PR. Never throws; a no-op for
 *  repositories without `approvalGate` in their default-branch config. */
export function refreshApprovalGate(
  prNumber: number,
  ghRepo: string | undefined,
): Promise<void> {
  if (!ghRepo || !Number.isInteger(prNumber)) return Promise.resolve();
  const key = `${ghRepo.toLowerCase()}#${prNumber}`;
  const next = (chains.get(key) || Promise.resolve())
    .then(() => refreshOnce(prNumber, ghRepo))
    .catch((e) =>
      console.warn(
        `[github] approval gate refresh failed for ${ghRepo}#${prNumber}:`,
        e,
      ),
    )
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  chains.set(key, next);
  return next;
}
