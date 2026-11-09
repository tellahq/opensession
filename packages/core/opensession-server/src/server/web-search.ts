/**
 * Web search for agents, served by Claude Code's own WebSearch tool.
 *
 * Every engine has its built-in search switched off (the Agent SDK bridge
 * blocks `WebSearch` along with every other SDK built-in, because the client
 * owns execution), so `opensession-web` brings it back as one bounded tool.
 * Nothing here ranks the web: a small Agent SDK run on a Claude subscription
 * account is allowed exactly one tool, `WebSearch`, and Claude Code performs
 * the search through Anthropic's server-side web search, the same results a
 * Claude Code session gets. No search vendor and no API key.
 *
 * The shape mirrors fetch_url: a search returns titles and URLs (plus the
 * search model's short summary, labelled as such), never page bodies. Reading
 * a result is a separate `fetch_url`, so the caller decides what it pays for.
 *
 * Cost control: the run uses a small model, stops as soon as the search
 * result is captured (the model's follow-up turn never happens), and has a
 * hard timeout. Account choice is pickBridgeAccount's, so designated bridge
 * accounts, personal-first routing and utilization gating all apply.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  ensureAnthropicBridgeCwd,
  pickBridgeAccount,
} from "./anthropic-bridge";
import { audit } from "./audit";
import { CLAUDE_CODE_BIN } from "./runner-shared";
import { spawnClaudeCodeInWorkload } from "./workload-scope";

export const WEB_SEARCH_MODEL = "claude-haiku-5-5";
const SEARCH_TIMEOUT_MS = 90_000;
const MAX_ACCOUNT_ATTEMPTS = 2;
const MAX_SUMMARY_CHARS = 4000;

export interface WebSearchRequest {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface WebSearchHit {
  title: string;
  url: string;
}

export interface WebSearchOutcome {
  query: string;
  hits: WebSearchHit[];
  /** The search model's own write-up of the results. Unverified. */
  summary: string;
}

/** Claude Code's WebSearch tool_response: `results` mixes hit groups
 *  (`{tool_use_id, content: [{title, url}]}`) with the model's commentary
 *  strings. Hits are deduplicated by URL in rank order. */
export function parseWebSearchResponse(
  response: unknown,
  fallbackQuery: string,
): WebSearchOutcome {
  const r = (response ?? {}) as { query?: unknown; results?: unknown };
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const entry of Array.isArray(r.results) ? r.results : []) {
    if (typeof entry === "string") {
      if (entry.trim()) notes.push(entry.trim());
      continue;
    }
    const content = (entry as { content?: unknown })?.content;
    for (const hit of Array.isArray(content) ? content : []) {
      const url = typeof hit?.url === "string" ? hit.url.trim() : "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = typeof hit?.title === "string" ? hit.title.trim() : "";
      hits.push({ title: title || url, url });
    }
  }
  return {
    query: typeof r.query === "string" && r.query ? r.query : fallbackQuery,
    hits,
    summary: notes.join("\n\n"),
  };
}

export function formatWebSearch(outcome: WebSearchOutcome): string {
  const lines = [
    `Web search: ${JSON.stringify(outcome.query)} (${outcome.hits.length} result${outcome.hits.length === 1 ? "" : "s"})`,
    "",
  ];
  if (!outcome.hits.length) lines.push("No results.");
  outcome.hits.forEach((hit, i) => {
    lines.push(`${i + 1}. ${hit.title}`, `   ${hit.url}`);
  });
  if (outcome.summary) {
    const summary =
      outcome.summary.length > MAX_SUMMARY_CHARS
        ? `${outcome.summary.slice(0, MAX_SUMMARY_CHARS)}…`
        : outcome.summary;
    lines.push(
      "",
      "Summary written by the search model (unverified; open the sources before relying on it):",
      summary,
    );
  }
  lines.push(
    "",
    "Read a result with fetch_url, then read_page to search inside it.",
  );
  return lines.join("\n");
}

/** One SDK run on one account. Resolves with the captured WebSearch result,
 *  or rejects with the run's own error text. */
async function searchOnAccount(
  request: WebSearchRequest,
  token: string,
): Promise<WebSearchOutcome> {
  let captured: { response: unknown } | undefined;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), SEARCH_TIMEOUT_MS);
  const domains = [
    request.allowedDomains?.length
      ? `allowed_domains: ${JSON.stringify(request.allowedDomains)}`
      : "",
    request.blockedDomains?.length
      ? `blocked_domains: ${JSON.stringify(request.blockedDomains)}`
      : "",
  ].filter(Boolean);
  const q = query({
    prompt: [`query: ${JSON.stringify(request.query)}`, ...domains].join("\n"),
    options: {
      cwd: await ensureAnthropicBridgeCwd(),
      model: WEB_SEARCH_MODEL,
      maxTurns: 2,
      systemPrompt:
        "You run web searches. Call the WebSearch tool exactly once, with the given query " +
        "verbatim and any given domain filters. Do not answer from memory and do not " +
        "call it again.",
      settingSources: [],
      persistSession: false,
      mcpServers: {},
      strictMcpConfig: true,
      tools: ["WebSearch"],
      allowedTools: ["WebSearch"],
      pathToClaudeCodeExecutable: CLAUDE_CODE_BIN,
      executable: "bun" as const,
      spawnClaudeCodeProcess: spawnClaudeCodeInWorkload("web-search"),
      abortController,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        CLAUDE_CODE_OAUTH_TOKEN: token,
      },
      hooks: {
        PreToolUse: [
          {
            matcher: "",
            hooks: [
              async (input: any) =>
                input.tool_name === "WebSearch"
                  ? {}
                  : {
                      decision: "block" as const,
                      reason: "Only WebSearch is available.",
                    },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "",
            hooks: [
              async (input: any) => {
                if (input.tool_name === "WebSearch" && !captured)
                  captured = { response: input.tool_response };
                return {};
              },
            ],
          },
        ],
      },
    },
  });
  let failure = "";
  try {
    for await (const msg of q) {
      // The search result is all we wanted: stop before the model spends a
      // second turn writing about it.
      if (captured) break;
      if (msg.type === "result") {
        const rm = msg as any;
        failure =
          (typeof rm.result === "string" && rm.result) ||
          rm.errors?.join(", ") ||
          rm.subtype ||
          "search run ended without a result";
        break;
      }
    }
  } catch (error) {
    if (!captured) {
      failure = abortController.signal.aborted
        ? `timed out after ${SEARCH_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
    }
  } finally {
    clearTimeout(timer);
    q.close();
  }
  if (captured) return parseWebSearchResponse(captured.response, request.query);
  throw new Error(failure || "the search model did not run a search");
}

/** Run a web search on a Claude account, trying a second account when the
 *  first one fails (an account at its limit is the usual cause). */
export async function claudeWebSearch(
  request: WebSearchRequest,
  opts: { user?: string; sessionId?: string } = {},
): Promise<WebSearchOutcome> {
  const tried: string[] = [];
  const errors: string[] = [];
  for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
    const account = pickBridgeAccount(WEB_SEARCH_MODEL, {
      user: opts.user,
      excludeIds: tried,
    });
    if ("error" in account) {
      errors.push(account.error);
      break;
    }
    tried.push(account.id);
    const started = Date.now();
    try {
      const outcome = await searchOnAccount(request, account.token);
      audit({
        msg: "web_search",
        session_id: opts.sessionId,
        account: account.name,
        model: WEB_SEARCH_MODEL,
        results: outcome.hits.length,
        ms: Date.now() - started,
      });
      return outcome;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      audit({
        msg: "web_search_failed",
        session_id: opts.sessionId,
        account: account.name,
        model: WEB_SEARCH_MODEL,
        ms: Date.now() - started,
        detail: detail.slice(0, 300),
      });
      errors.push(`${account.name}: ${detail}`);
    }
  }
  throw new Error(`Web search failed: ${errors.join("; ")}`);
}
