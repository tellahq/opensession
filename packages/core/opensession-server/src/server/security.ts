/**
 * Security scans: on-demand (and recurring, via automations) deepsec runs
 * across the registered repos, plus reusable "scan profiles" that tailor the
 * threat model. Devin-DeepSec-style, wrapped around vercel-labs/deepsec.
 *
 * Records live in ~/.opensession-security/{scans,profiles}/<id>.json. Each
 * headless scan creates one normal opensession session per target repo (so runs
 * show up in the sessions list with live transcripts); interactive scans are
 * a single collaborative session created through the SessionControl registry.
 *
 * The recurring daily/weekly deepsec scans that already exist are plain
 * automations — the Security page lists any automation whose name mentions
 * deepsec/security as the "recurring" group, and creates new recurring scans
 * as automations too (single source of scheduling truth).
 */
import { randomUUIDv7 } from "bun";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { runAgent } from "./agent-runner";
import { declaredRunFailure, hasRunStatusDeclaration } from "./runner-shared";
import {
  createWorktree,
  listWorktrees,
  REPOS,
  getRepo,
  type Repo,
} from "./worktree";
import { personaName, productName } from "./config";
import { newSessionId } from "./paths";
import { providerFor, modelLabel } from "./models";
import { engineSessionPatch } from "./sessions";
import type { NativeSessionFile } from "./types";
import { stateDir } from "./paths";
import { shouldPersistModelSwitch } from "./run-events";
import { updateSessionFile } from "./session-cache";
import { shellQuoteWord } from "./sandbox/adapters/bootstrap";

const SECURITY_DIR = stateDir("security");
const SCANS_DIR = `${SECURITY_DIR}/scans`;
const PROFILES_DIR = `${SECURITY_DIR}/profiles`;

mkdirSync(SCANS_DIR, { recursive: true });
mkdirSync(PROFILES_DIR, { recursive: true });

// ── Types ────────────────────────────────────────────────────

/** A reusable threat-model customization appended to scan prompts. */
export interface ScanProfile {
  id: string;
  name: string;
  /** Free-text threat-model guidance: what to focus on, known false positives,
   *  intended-public surfaces, severity preferences, … */
  prompt: string;
  createdBy: string;
  createdAt: string;
}

export interface ScanSessionRef {
  repo: string;
  sessionId: string;
  status: "running" | "ok" | "error";
  error?: string;
}

export interface SecurityScan {
  id: string;
  /** Target repo ids (already expanded — "all" is resolved at creation). */
  repos: string[];
  profileId?: string;
  profileName?: string;
  /** Extra instructions for this specific scan. */
  instructions?: string;
  /** Interactive scans are one collaborative session instead of headless runs. */
  interactive: boolean;
  status: "running" | "done" | "error" | "interactive";
  error?: string;
  createdBy: string;
  createdAt: string;
  finishedAt?: string;
  sessions: ScanSessionRef[];
}

// ── Stores ───────────────────────────────────────────────────

function listDir<T>(dir: string): T[] {
  const out: T[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(`${dir}/${file}`, "utf-8")) as T);
    } catch {}
  }
  return out;
}

export function listScans(): SecurityScan[] {
  return listDir<SecurityScan>(SCANS_DIR).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export function getScan(id: string): SecurityScan | null {
  const path = `${SCANS_DIR}/${id}.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function saveScan(s: SecurityScan): void {
  writeJsonAtomic(`${SCANS_DIR}/${s.id}.json`, s);
}

export function deleteScan(id: string): boolean {
  const path = `${SCANS_DIR}/${id}.json`;
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function listProfiles(): ScanProfile[] {
  return listDir<ScanProfile>(PROFILES_DIR).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function getProfile(id: string): ScanProfile | null {
  const path = `${PROFILES_DIR}/${id}.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function createProfile(input: {
  name: string;
  prompt: string;
  createdBy: string;
}): ScanProfile | { error: string } {
  if (!input.name?.trim()) return { error: "Name is required" };
  if (!input.prompt?.trim()) return { error: "Profile prompt is required" };
  const p: ScanProfile = {
    id: `secp-${randomUUIDv7()}`,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    createdBy: input.createdBy || "Anonymous",
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(`${PROFILES_DIR}/${p.id}.json`, p);
  return p;
}

export function updateProfile(
  id: string,
  patch: { name?: string; prompt?: string },
): ScanProfile | { error: string } {
  const p = getProfile(id);
  if (!p) return { error: "Profile not found" };
  const next = {
    ...p,
    ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
    ...(patch.prompt?.trim() ? { prompt: patch.prompt.trim() } : {}),
  };
  writeJsonAtomic(`${PROFILES_DIR}/${id}.json`, next);
  return next;
}

export function deleteProfile(id: string): boolean {
  const path = `${PROFILES_DIR}/${id}.json`;
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// ── Scan targets ─────────────────────────────────────────────

/** Repos a headless scan can target. Open Session is excluded: it's the shared
 *  self-hosting checkout, so a code-mode scan would write branches under the
 *  live server (see worktree.ts sharedCheckout). */
export function scannableRepos(): Repo[] {
  return Object.values(REPOS)
    .filter((r) => !r.sharedCheckout)
    .sort((a, b) => Number(!!b.default) - Number(!!a.default));
}

// ── Prompt builders ──────────────────────────────────────────

function scanExtras(
  profile?: ScanProfile | null,
  instructions?: string,
): string {
  let out = "";
  if (profile) {
    out += `\n\n## Scan profile: ${profile.name}\n\nThis scan runs under a saved profile that tailors the threat model. Follow it when triaging and verifying findings:\n\n${profile.prompt}`;
  }
  if (instructions?.trim()) {
    out += `\n\n## Extra instructions for this scan\n\n${instructions.trim()}`;
  }
  return out;
}

/** Full-scan prompt for one repo — operational knowledge mirrors the seeded
 *  daily/weekly deepsec automations (keep the deepsec mechanics in sync). */
export function buildScanPrompt(
  repo: Repo,
  profile?: ScanProfile | null,
  instructions?: string,
): string {
  // Code Storage repos have no gh CLI and no PRs — findings ship as pushed fix
  // branches instead (a pushed branch IS the change request). GitHub text is
  // untouched.
  const cs = repo.host === "codestorage";
  const repoLabel = cs ? repo.csRepo || repo.id : repo.ghRepo;
  const branchLabel = JSON.stringify(repo.defaultBranch);
  const branchArg = shellQuoteWord(repo.defaultBranch);
  const remoteRefArg = shellQuoteWord(`origin/${repo.defaultBranch}`);
  return `You are ${personaName()} running an on-demand deepsec security scan on ${repo.id} (${repoLabel}). Sweep the repo for vulnerabilities and ${cs ? "push one fix branch" : "open one PR"} per CONFIRMED finding of severity MEDIUM or higher. NEVER merge anything; never push to branch ${branchLabel}.

deepsec = vercel-labs/deepsec, an AI vuln scanner. Start with its \`claude\` agent. This run's env carries both CLAUDE_CODE_OAUTH_TOKEN from the ${productName()} Claude account pool and CODEX_HOME/OPENAI_API_KEY from the ChatGPT pool, so never run either CLI's login flow or rely on a host login. If Claude reports a usage limit, switch the DeepSec worker to \`--agent codex --model gpt-5.6-sol\`; do not abandon an otherwise runnable scan. Use \`corepack pnpm\` — there is no global pnpm on this host. Node 22 is present.

## Setup
1. You are in a mode:code worktree of ${repo.id}. Run \`git fetch origin ${branchArg}\`.
2. If \`.deepsec/deepsec.config.ts\` exists, \`cd .deepsec\`. Otherwise from the repo root run \`npx -y deepsec@latest init\`, then \`cd .deepsec\` (a SETUP.md will be generated; a minimal default INFO.md is fine).
3. Install deepsec: \`corepack pnpm install\` (expect an \`@anthropic-ai/sdk\` peer-dep warning — harmless). Set \`DEEPSEC_AGENT=claude\` and \`DEEPSEC_MODEL_FLAG=""\`, then preflight Claude with \`claude -p "reply with exactly: ok"\`. If it succeeds, keep those values. If it reports a usage limit, set \`DEEPSEC_AGENT=codex\` and \`DEEPSEC_MODEL_FLAG="--model gpt-5.6-sol"\` and continue; the first DeepSec batch is the Codex credential preflight. For any other preflight error, stop immediately and report it (see Finish), do NOT run a scan that will silently analyze zero batches.

## Scan
4. deepsec scopes by project (\`deepsec.config.ts\` → \`projects: [{ id, root }]\`); a scan only sees files under a project's \`root\`. Read \`.deepsec/deepsec.config.ts\` and run the scan for EVERY project listed, so coverage isn't silently limited to one root: with a single project \`corepack pnpm deepsec process --agent "$DEEPSEC_AGENT" $DEEPSEC_MODEL_FLAG\` auto-resolves; with more than one, run it once per project passing \`--project-id <id>\` (auto-resolution is disabled once a second project exists). Tee each to \`/tmp/deepsec-scan-${repo.id}-<id>.log\`. If a scoped focus is given below (profile / extra instructions), you may use \`--diff\` or path filters where deepsec supports them to match that scope.
5. Export each project's findings (\`corepack pnpm deepsec export --format md-dir --out ./findings\`, adding \`--project-id <id>\` per project when there are several), then read findings under findings/CRITICAL, findings/HIGH, findings/MEDIUM. Ignore BUG/low severity.

## Per finding (MEDIUM/HIGH/CRITICAL only; cap 8 ${cs ? "branches" : "PRs"} per run — if more, list the overflow in the summary)
6. VERIFY against the real code: open the cited file+lines and confirm the issue is genuinely real and reachable. deepsec has a real false-positive rate — DROP false positives.${repo.securityInstructions ? `\n\nRepository-specific guidance:\n${repo.securityInstructions}` : ""}
7. For a confirmed finding, branch off ${branchLabel}: \`git checkout -b deepsec-scan-<short-slug> ${remoteRefArg}\`. Write a MINIMAL fix targeting the root cause only.
   - Validate that anything you change parses/builds where cheaply possible.
   - If you are NOT confident in a safe fix (e.g. it touches core auth broadly), do NOT guess — ${cs ? 'push the branch with the finding writeup + recommended fix in the commit message and NO code change, and add "[needs-human-fix]" to the commit title' : 'open the PR with the finding writeup + recommended fix and NO code change, and add "[needs-human-fix]" to the title'}.
8. ${cs ? `Commit with message "[deepsec][scan] <concise title>" plus a body covering finding, impact, fix, severity (note: generated by an on-demand ${productName()} security scan via vercel-labs/deepsec), then push the branch with \`git push -u origin deepsec-scan-<short-slug>\`. This repo is hosted on Code Storage; there is no gh CLI and no pull requests; a pushed branch IS the change request. One branch per finding. NEVER merge.` : `Commit, push, then \`gh pr create --repo ${repo.ghRepo} --base ${branchArg} --title "[deepsec][scan] <concise title>" --body "<finding, impact, fix, severity; note: generated by an on-demand ${productName()} security scan via vercel-labs/deepsec>"\`. One PR per finding. NEVER run \`gh pr merge\`.`}

## Finish
9. End with a concise summary in your final message: # findings by severity, ${cs ? "pushed branch names" : "PR links"}, and any findings you dropped as false positives (one line each on why). If the scan errored (e.g. claude CLI auth failure, deepsec analyzing zero batches despite matching files), report the error clearly rather than half-finishing. The LAST line of your final message MUST be exactly \`SCAN STATUS: ok\` — or \`SCAN STATUS: failed — <reason>\` when the scan could not genuinely run. A missing status line is recorded as a failed scan.

## Guardrails
- Never push to branch ${branchLabel}, never merge, never force-push.
- Skip findings that are only in tests/fixtures/marketing content unless clearly exploitable in production.
- Keep each ${cs ? "fix branch" : "PR"} small and focused; deduplicate if two findings share one root cause.${scanExtras(profile, instructions)}`;
}

/** Prompt for an interactive scan session: tailor the threat model together
 *  first, then run the scan in the same session. */
export function buildInteractivePrompt(
  repo: Repo,
  profile?: ScanProfile | null,
  instructions?: string,
): string {
  return `We're running a deepsec security scan on ${repo.id} (${repo.host === "codestorage" ? repo.csRepo || repo.id : repo.ghRepo}) together — interactive mode. Instead of scanning end to end, collaborate with me to tailor the threat model before you run anything.

Start by interviewing me (use AskUserQuestion, a few focused rounds, not twenty questions):
- What areas/attack surfaces to prioritize (auth, payments, uploads, APIs, …) and any recent changes that worry me.
- What's intentionally public / known-accepted risk, so the scan doesn't waste time re-flagging it.
- Severity bar and what to do with findings (${repo.host === "codestorage" ? "fix branch" : "PR"} per finding vs. report only).

Then summarize the agreed threat model back to me for confirmation, and offer to save it as a reusable scan profile (if I say yes, print it clearly in a fenced block titled "SCAN PROFILE" so I can paste it into Security → Profiles).

Once confirmed, run the scan in this session, following the standard procedure below — but adjust it to whatever we agreed in the interview (the interview outcome overrides these defaults):

${buildScanPrompt(repo, profile, instructions).replace(/^You are [^\n]*\n\n/, "")}`;
}

// ── Headless scan execution ──────────────────────────────────

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

function updateScanSession(
  scanId: string,
  repoId: string,
  patch: Partial<ScanSessionRef>,
): void {
  const fresh = getScan(scanId);
  if (!fresh) return;
  saveScan({
    ...fresh,
    sessions: fresh.sessions.map((s) =>
      s.repo === repoId ? { ...s, ...patch } : s,
    ),
  });
}

/**
 * Run a headless scan: one code-mode session per target repo, sequential (scans
 * are long and heavy — don't stack worktree churn and model load). Settles the
 * scan record as each repo finishes; overall status lands when all are done.
 */
export async function executeScan(
  scan: SecurityScan,
  opts?: { onSessionCreated?: (sessionId: string) => void; model?: string },
): Promise<void> {
  const startedAt = new Date();
  const stamp = startedAt.toISOString().slice(0, 16).replace(/[-T:]/g, "");
  const profile = scan.profileId ? getProfile(scan.profileId) : null;

  for (const repoId of scan.repos) {
    const repo = getRepo(repoId);
    const bksId = newSessionId();
    let errorMsg = "";
    try {
      const branch = `deepsec-scan-${slug(repo.id)}-${stamp}`;
      const worktrees = await listWorktrees(repo.id);
      const cwd =
        worktrees.find((w) => w.branch === branch)?.path ||
        (await createWorktree(branch, repo.id));

      const prompt = buildScanPrompt(repo, profile, scan.instructions);

      let engineSessionId = "";
      let effectiveModel = opts?.model;
      let selectedModel = opts?.model;
      let effectiveProvider = providerFor(effectiveModel);
      const modelHistory: NonNullable<NativeSessionFile["modelHistory"]> = [];
      const persistSession = () => {
        const data: NativeSessionFile = {
          id: bksId,
          claudeSessionId: "",
          ...(engineSessionId
            ? engineSessionPatch(effectiveProvider, engineSessionId)
            : {}),
          ...(engineSessionId ? { lastEngineProvider: effectiveProvider } : {}),
          ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(modelHistory.length ? { modelHistory } : {}),
          branch,
          worktreeDir: cwd,
          createdBy: `${scan.createdBy} (security scan)`,
          createdAt: startedAt.toISOString(),
          lastActivity: new Date().toISOString(),
          title: `deepsec scan — ${repo.id} — ${startedAt.toISOString().slice(0, 16).replace("T", " ")}`,
          mode: "code",
          repo: repo.id,
        };
        void updateSessionFile(bksId, (current) => ({
          ...current,
          ...data,
        })).catch((error) =>
          console.error(
            `[security] Failed to persist session ${bksId}:`,
            error,
          ),
        );
      };
      persistSession();

      updateScanSession(scan.id, repo.id, {
        sessionId: bksId,
        status: "running",
      });
      opts?.onSessionCreated?.(bksId);
      console.log(`[security] Scan ${scan.id}: ${repo.id} → ${bksId}`);

      // Tail of the assistant's text, for the SCAN STATUS declaration — the
      // run must EARN its ok (a finished turn proves nothing about whether
      // deepsec actually analyzed anything; see the 2026-08-08..10 zero-batch
      // scans that recorded ok for days).
      let textTail = "";
      for await (const event of runAgent({
        prompt,
        cwd,
        mode: "code",
        model: opts?.model,
        mcpServers: [], // deepsec + gh CLI only; findings land as PRs + summary
        // deepsec's inner `claude`/`codex` agents run on the account pools,
        // not host logins.
        claudeCliEnv: true,
        codexCliEnv: true,
        journal: { osSessionId: bksId, kind: "security-scan" },
      })) {
        if (event.type === "init") {
          if (event.sessionId) {
            engineSessionId = event.sessionId;
          }
          if (event.provider) effectiveProvider = event.provider;
          if (event.model) {
            effectiveModel = event.model;
            if (!selectedModel) selectedModel = event.model;
          }
          persistSession();
        }
        if (event.type === "model_switch") {
          const to = event.toModel || "";
          if (to) {
            effectiveModel = to;
            effectiveProvider = providerFor(to);
            if (shouldPersistModelSwitch(event)) {
              selectedModel = to;
              modelHistory.push({
                model: to,
                at: new Date().toISOString(),
                by: `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`,
              });
            }
          }
        }
        if (event.type === "done") {
          if (event.sessionId) engineSessionId = event.sessionId;
          if (event.provider) effectiveProvider = event.provider;
          if (event.model) effectiveModel = event.model;
          persistSession();
        }
        if (event.type === "text_chunk" && event.text) {
          textTail = (textTail + event.text).slice(-16384);
        }
        if (event.type === "error") errorMsg = event.content || "Unknown error";
      }
      if (!errorMsg) {
        const declared = declaredRunFailure(textTail);
        if (declared) errorMsg = declared;
        else if (!hasRunStatusDeclaration(textTail))
          errorMsg =
            "scan finished without a SCAN STATUS declaration — recorded as failed (see the session transcript)";
      }
    } catch (e: any) {
      errorMsg = e?.message || String(e);
      console.error(`[security] Scan ${scan.id} failed on ${repo.id}:`, e);
    }
    updateScanSession(scan.id, repo.id, {
      status: errorMsg ? "error" : "ok",
      error: errorMsg || undefined,
    });
  }

  const fresh = getScan(scan.id);
  if (fresh) {
    const anyError = fresh.sessions.some((s) => s.status === "error");
    saveScan({
      ...fresh,
      status: anyError ? "error" : "done",
      error: anyError ? fresh.sessions.find((s) => s.error)?.error : undefined,
      finishedAt: new Date().toISOString(),
    });
  }
  console.log(`[security] Scan ${scan.id} finished`);
}

/** Create the scan record for a headless scan (caller fires executeScan). */
export function createScanRecord(input: {
  repos: string[];
  profileId?: string;
  instructions?: string;
  interactive?: boolean;
  createdBy: string;
  /** For interactive scans: the pre-created session id. */
  sessionId?: string;
}): SecurityScan {
  const profile = input.profileId ? getProfile(input.profileId) : null;
  const scan: SecurityScan = {
    id: `scan-${randomUUIDv7()}`,
    repos: input.repos,
    profileId: profile?.id,
    profileName: profile?.name,
    instructions: input.instructions?.trim() || undefined,
    interactive: !!input.interactive,
    status: input.interactive ? "interactive" : "running",
    createdBy: input.createdBy || "Anonymous",
    createdAt: new Date().toISOString(),
    sessions: input.interactive
      ? [
          {
            repo: input.repos[0],
            sessionId: input.sessionId || "",
            status: "running",
          },
        ]
      : input.repos.map((r) => ({
          repo: r,
          sessionId: "",
          status: "running" as const,
        })),
  };
  saveScan(scan);
  return scan;
}
