/**
 * `opensession-web` — the in-process MCP server that lets a run read the web.
 *
 * Three tools, and the shape of each is the point:
 *  - `fetch_url` returns a bounded head plus a handle, never the whole page.
 *    A doc page is often 80k tokens; pouring that into the transcript to
 *    answer one question makes every later turn pay for it forever.
 *  - `read_page` pulls the rest by SEARCH or by offset, so the model chooses
 *    how much of a page it buys.
 *  - `clone_repo` (and `fetch_url` on a GitHub repo URL) clones rather than
 *    scrapes. Rendered GitHub HTML is chrome around the thing you wanted;
 *    a shallow clone hands over the real files and a path to explore with
 *    the tools the run already has.
 *
 * There is deliberately no search. This turns a URL you have into text you
 * can read; ranking the web is a different product and belongs to whichever
 * MCP server an instance chooses to mount.
 *
 * In-process on purpose: it reaches every engine at once, needs no API key,
 * no subprocess and no network mount, and its address safety (see
 * web-fetch.ts) is enforced in our own code rather than trusted to a vendor.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { stateDir } from "./paths";
import { ensureSessionScratch } from "./session-scratch";
import { fetchWeb, readFetched } from "./web-fetch";

const CLONE_TIMEOUT_MS = 120_000;
const TREE_LIMIT = 200;

/** A GitHub repo ROOT — not a blob, tree, issue or pull URL. */
const GITHUB_REPO =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;
/** A file view, which is worth reading as raw text rather than as a page. */
const GITHUB_BLOB =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/]+)\/(.+)$/i;

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Where clones land: the session's swept scratch when there is one, else a
 *  shared cache dir. Never the worktree — a clone is not the run's work. */
function cloneRoot(sessionId?: string): string {
  const scratch = sessionId ? ensureSessionScratch(sessionId) : undefined;
  const root = scratch ? `${scratch}/repos` : `${stateDir("web-cache")}/repos`;
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

async function run(
  cmd: string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), CLONE_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function cloneRepo(
  owner: string,
  repo: string,
  sessionId?: string,
): Promise<string> {
  const dir = `${cloneRoot(sessionId)}/${owner}-${repo}`;
  if (existsSync(`${dir}/.git`)) {
    const summary = await describeClone(dir);
    return `Already cloned at ${dir} (reused).\n\n${summary}`;
  }
  rmSync(dir, { recursive: true, force: true });
  const url = `https://github.com/${owner}/${repo}.git`;
  const cloned = await run([
    "git",
    "clone",
    "--depth",
    "1",
    "--single-branch",
    url,
    dir,
  ]);
  if (!cloned.ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `Could not clone ${owner}/${repo}: ${cloned.stderr.trim().split("\n").slice(-3).join(" ") || "git failed"}`,
    );
  }
  const summary = await describeClone(dir);
  return `Cloned ${owner}/${repo} (shallow, single branch) to:\n${dir}\n\n${summary}\n\nRead files there with the normal read/grep/find tools.`;
}

async function describeClone(dir: string): Promise<string> {
  const listed = await run(["git", "ls-files"], dir);
  const files = listed.stdout.split("\n").filter(Boolean);
  const shown = files.slice(0, TREE_LIMIT);
  const lines = [
    `${files.length} tracked file${files.length === 1 ? "" : "s"}${files.length > TREE_LIMIT ? ` (first ${TREE_LIMIT} shown)` : ""}:`,
    ...shown.map((f) => `  ${f}`),
  ];
  for (const name of ["README.md", "readme.md", "README.rst", "README"]) {
    const path = `${dir}/${name}`;
    if (!existsSync(path)) continue;
    try {
      const head = readFileSync(path, "utf8").slice(0, 1500);
      lines.push("", `--- ${name} (first 1500 chars) ---`, head);
    } catch {}
    break;
  }
  return lines.join("\n");
}

export function createWebMcpServer(opts: { sessionId?: string } = {}) {
  return createSdkMcpServer({
    name: "opensession-web",
    version: "1.0.0",
    tools: [
      tool(
        "fetch_url",
        [
          "Fetch a URL and return its readable text.",
          "",
          "Returns the first part of the page inline plus a `handle`; the whole body is kept",
          "on disk for an hour, so use `read_page` with that handle to search the rest rather",
          "than re-fetching. This keeps a long page out of the conversation unless you ask",
          "for the part you need.",
          "",
          "A GitHub repository URL is CLONED instead of scraped, and the result is a local",
          "path you can read with the normal file tools. A GitHub file URL is read as raw",
          "text rather than as a rendered page.",
          "",
          "Private, loopback and link-local addresses are refused, redirects included.",
          "This does not search the web: pass a URL you already have.",
        ].join("\n"),
        {
          url: z.string().describe("Absolute http(s) URL."),
          mode: z
            .enum(["text", "raw"])
            .optional()
            .describe(
              "text (default) extracts readable prose from HTML; raw keeps the body verbatim, for JSON, plain text, or when you need to see the markup.",
            ),
          headChars: z
            .number()
            .optional()
            .describe("Characters returned inline. Default 4000, max 40000."),
          refresh: z
            .boolean()
            .optional()
            .describe("Re-fetch instead of serving a cached copy of this URL."),
        },
        async (args) => {
          const raw = String(args.url ?? "").trim();
          const repo = GITHUB_REPO.exec(raw);
          if (repo)
            return text(await cloneRepo(repo[1], repo[2], opts.sessionId));

          const blob = GITHUB_BLOB.exec(raw);
          const target = blob
            ? `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`
            : raw;

          const page = await fetchWeb(target, {
            mode: blob ? "raw" : args.mode,
            headChars: args.headChars,
            refresh: args.refresh,
          });
          const header = [
            `${page.status} ${page.contentType || "unknown type"} — ${page.chars.toLocaleString()} chars`,
            page.title ? `title: ${page.title}` : undefined,
            page.finalUrl !== page.url
              ? `redirected to: ${page.finalUrl}`
              : undefined,
            blob ? `read as raw file from: ${target}` : undefined,
            `handle: ${page.handle}`,
          ]
            .filter(Boolean)
            .join("\n");
          const footer = page.truncated
            ? `\n\n[showing the first ${page.head.length.toLocaleString()} of ${page.chars.toLocaleString()} chars — read_page({handle: "${page.handle}", find: "..."}) to search the rest]`
            : "";
          return text(`${header}\n\n${page.head}${footer}`);
        },
      ),
      tool(
        "read_page",
        [
          "Read more of a page fetched earlier in this session, by its handle.",
          "",
          "Prefer `find` over paging: it returns just the passages containing your term,",
          "with context, plus how many times it occurs in the whole page. Use `offset` only",
          "when you genuinely want to read straight through.",
          "",
          "Pages expire an hour after they are fetched; fetch the URL again if a handle has",
          "gone.",
        ].join("\n"),
        {
          handle: z.string().describe("The handle returned by fetch_url."),
          find: z
            .string()
            .optional()
            .describe(
              "Return passages around this text instead of a positional slice.",
            ),
          caseSensitive: z
            .boolean()
            .optional()
            .describe("Match case exactly. Default false."),
          context: z
            .number()
            .optional()
            .describe(
              "Characters of context each side of a match. Default 500.",
            ),
          offset: z
            .number()
            .optional()
            .describe("Character offset to read from. Ignored with find."),
          limit: z
            .number()
            .optional()
            .describe("Maximum characters to return. Default 20000."),
        },
        async (args) => {
          const slice = readFetched(String(args.handle ?? ""), {
            find: args.find,
            caseSensitive: args.caseSensitive,
            context: args.context,
            offset: args.offset,
            limit: args.limit,
          });
          const header =
            slice.matches === undefined
              ? `${slice.url} — chars ${slice.offset?.toLocaleString()}–${((slice.offset ?? 0) + slice.text.length).toLocaleString()} of ${slice.chars.toLocaleString()}`
              : `${slice.url} — ${slice.matches} match${slice.matches === 1 ? "" : "es"} in ${slice.chars.toLocaleString()} chars`;
          const footer = slice.truncated
            ? "\n\n[truncated — raise limit or narrow the search]"
            : "";
          return text(`${header}\n\n${slice.text}${footer}`);
        },
      ),
      tool(
        "clone_repo",
        [
          "Shallow-clone a public GitHub repository and return the local path, its file",
          "list and the head of its README.",
          "",
          "Use this instead of fetching GitHub pages when you want to read a project's",
          "actual source: the clone is real files, so read/grep/find work on it normally.",
          "The clone lands in scratch, not in the session's worktree.",
        ].join("\n"),
        {
          repo: z.string().describe('"owner/name" or a github.com URL.'),
        },
        async (args) => {
          const input = String(args.repo ?? "").trim();
          const fromUrl = GITHUB_REPO.exec(input);
          const pair = fromUrl
            ? [fromUrl[1], fromUrl[2]]
            : /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(input)?.slice(1);
          if (!pair) {
            throw new Error(
              `Not a GitHub repository: ${input}. Use "owner/name" or a github.com URL.`,
            );
          }
          return text(await cloneRepo(pair[0], pair[1], opts.sessionId));
        },
      ),
    ],
  });
}
