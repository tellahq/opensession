/**
 * What the Slack task router is told about registered repositories when an
 * incoming message does not name one directly (suggest-repos.ts).
 *
 * The hand-written `description` in config.json is the only thing we had, and
 * it is thin exactly where the choice is hard: it says what a repo IS, never
 * what lives INSIDE it. "The product monorepo" does not tell anyone that
 * the render engine is in there rather than in a sibling fork, and three
 * infrastructure repos described as "Kubernetes manifests", "cloud resources"
 * and "shared organization infrastructure" are indistinguishable to a reader
 * who only has those words.
 *
 * So each repo also gets its top two directory levels and the opening of its
 * agent/readme doc, read straight off the checkout. Nothing is generated and
 * nothing is written down: a repo that reorganises its packages describes
 * itself differently on the next cache expiry, with no refresh job to run and
 * no stored card to go stale.
 *
 * AGENTS.md wins over README.md because it is already addressed to this
 * audience — it opens with the stack and the layout, where a README opens with
 * badges and install steps.
 *
 * Budget: across nine repos this is ~5 KB of directories and ~11 KB of prose,
 * which is why it can ride along on every classification instead of being
 * distilled first.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { configuredRepos } from "./config";

/** Directory depth shown per repo. One level is too coarse to separate
 *  `packages/core` from `packages/libs`; three is mostly test fixtures. */
const MAX_DEPTH = 2;
/** Directories listed per repo, longest-path-last so the shallow, orienting
 *  ones survive the cut in a repo with hundreds. */
const MAX_DIRS = 60;
/** Characters of the doc opening. Enough for a stack list and a layout tree;
 *  past this a README is into contribution guidelines, which route nothing. */
const MAX_DOC = 1200;
/**
 * Docs read per repo, in order, each capped at a share of MAX_DOC.
 *
 * README leads because of who each file is written for. A README opens by
 * telling a newcomer what the project IS, which is the routing question. An
 * AGENTS.md is written for an agent already in the checkout and opens with how
 * to work there — for opensession that is Bun, operator secrets and publishing
 * policy, 1200 characters that describe no repository in particular. Reading
 * only that (first-hit-wins, AGENTS first) is why "the repository picker
 * should remember what I picked" used to route anywhere but here.
 *
 * Both are still read: a repo's AGENTS.md often names its stack outright
 * where its README says only "a Rust monorepo", and between them they
 * identify it better than either alone. Most repos have no AGENTS.md at all,
 * so most are unaffected either
 * way, and prompt size is very nearly free here — 24x the tokens measured
 * about 1s.
 */
const DOC_FILES = ["README.md", "AGENTS.md", "CLAUDE.md"];
/** The checkout is on disk and cheap to re-read, but this runs on every
 *  keystroke pause in the palette, so hold it briefly. */
const CACHE_TTL_MS = 10 * 60_000;

export interface RepoCard {
  id: string;
  label: string;
  ghRepo: string;
  /** The registered description — an admin's override, so it leads. */
  description: string;
  /** Top-level and second-level directories, POSIX-separated. */
  layout: string[];
  /** Opening of AGENTS.md / README.md / CLAUDE.md, trimmed. */
  doc: string;
  /** Repos that share one checkout cannot be attached BESIDE another. */
  sharedCheckout: boolean;
}

const cache: { at: number; key: string; cards: RepoCard[] } = {
  at: 0,
  key: "",
  cards: [],
};

/** Strip what carries no routing signal: badge rows, bare image/link lines,
 *  HTML comments and heading hashes all cost characters and say nothing about
 *  what the repo contains. Fenced blocks are KEPT — a structure tree inside a
 *  fence is often the single most useful thing in the file. */
function cleanDoc(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t.startsWith("[![") || t.startsWith("![")) return false;
      if (/^\[[^\]]+\]:\s*http/.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

/** Cut to the budget on a line boundary, so the tail is never half a path. */
function clampDoc(text: string, budget: number = MAX_DOC): string {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > budget / 2 ? cut.slice(0, lastBreak) : cut).trim();
}

function readDoc(repoPath: string): string {
  const found: { name: string; text: string }[] = [];
  for (const name of DOC_FILES) {
    const path = join(repoPath, name);
    if (!existsSync(path)) continue;
    try {
      // Read a bounded prefix: AGENTS.md runs to 32 KB in this very repo,
      // and everything that names the stack is at the top.
      const cleaned = cleanDoc(
        readFileSync(path, "utf-8").slice(0, MAX_DOC * 6),
      );
      // A CLAUDE.md that only points at AGENTS.md (the convention in
      // several of these repos) describes nothing.
      if (cleaned && cleaned.length > 40) found.push({ name, text: cleaned });
    } catch {
      // Unreadable doc is not a reason to drop the repo from the catalog.
    }
  }
  // CLAUDE.md is the last resort, not a third helping: it is nearly always a
  // pointer to, or a copy of, one of the other two.
  const docs = found.filter((d) => d.name !== "CLAUDE.md").length
    ? found.filter((d) => d.name !== "CLAUDE.md")
    : found;
  // One doc gets the whole budget; two split it, so adding an AGENTS.md never
  // costs a repo the README opening that says what it is.
  const share = Math.floor(MAX_DOC / docs.length);
  return docs.map((d) => `${d.name}:\n${clampDoc(d.text, share)}`).join("\n\n");
}

/** `git -C <dir>`, empty string on any failure. Async because the catalog is
 *  built behind a cache on a request path: nine checkouts' worth of
 *  `ls-tree` is not something to block the server's only thread on. */
async function git(dir: string, args: string[]): Promise<string> {
  try {
    const child = Bun.spawn(["git", "-C", dir, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [stdout, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      return code === 0 ? stdout : "";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "";
  }
}

async function readLayout(repoPath: string): Promise<string[]> {
  // Tracked directories only: `git ls-tree` skips node_modules, build output
  // and every other gitignored thing that would otherwise dominate the list.
  const out = await git(repoPath, [
    "ls-tree",
    "-d",
    "-r",
    "--name-only",
    "HEAD",
  ]);
  if (!out) return [];
  const dirs = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line.split("/").length <= MAX_DEPTH);
  // Shortest first, so truncation removes detail rather than orientation.
  dirs.sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  return dirs.slice(0, MAX_DIRS);
}

/** Every registered repo, described for a model that has to choose one. */
export async function repoRoutingCatalog(): Promise<RepoCard[]> {
  const repos = Object.values(configuredRepos());
  // Re-read when the registry itself changes, not just on the timer: adding a
  // repo should make it routable immediately rather than in ten minutes.
  const key = repos
    .map((r) => `${r.id}:${r.repo}:${r.description || ""}`)
    .join("|");
  if (cache.key === key && Date.now() - cache.at < CACHE_TTL_MS)
    return cache.cards;

  const cards = await Promise.all(
    repos.map(async (repo): Promise<RepoCard> => {
      const onDisk = !!repo.repo && existsSync(repo.repo);
      return {
        id: repo.id,
        label: repo.label,
        ghRepo: repo.ghRepo || "",
        description: repo.description || "",
        layout: onDisk ? await readLayout(repo.repo) : [],
        doc: onDisk ? readDoc(repo.repo) : "",
        sharedCheckout: !!repo.sharedCheckout,
      };
    }),
  );
  cache.at = Date.now();
  cache.key = key;
  cache.cards = cards;
  return cards;
}

/**
 * The catalog as prompt text. One block per repo, description first (it is the
 * human's thumb on the scale), then what the checkout actually contains.
 */
export function renderRepoCatalog(cards: RepoCard[]): string {
  return cards
    .map((card) => {
      const lines = [
        `### ${card.id}${card.label && card.label !== card.id ? ` (${card.label})` : ""}`,
      ];
      if (card.ghRepo) lines.push(`GitHub: ${card.ghRepo}`);
      if (card.description) lines.push(card.description);
      if (card.layout.length)
        lines.push(`Directories: ${card.layout.join(", ")}`);
      if (card.doc) lines.push(`From its own docs —\n${card.doc}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
