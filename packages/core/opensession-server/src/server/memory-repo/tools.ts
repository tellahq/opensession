/**
 * opensession-memory in repo mode.
 *
 * Runs with a local checkout write memory with file tools and git, so they
 * get one tool: `search_memory`, ranked search over the derived index for
 * fuzzy queries that grep handles badly.
 *
 * Runs that cannot write files on this machine (ask-mode automations such as
 * Dreaming, Sandbox and Runner sessions) also get file tools that commit
 * through the memory service: list, read, write, delete. Each write is one
 * commit attributed to the session, validated like any push.
 */

import { z } from "zod";
import { createSdkMcpServer, tool } from "../inprocess-mcp";
import type { MemoryRecord } from "../memory-v2/types";
import { MEMORY_KINDS } from "../memory-v2/types";
import { memoryRepo } from "./client";
import { reposForScopes } from "./layout";

export interface RepoMemoryToolContext {
  /** Scope keys this run can see (its own plus checked-out participants'). */
  scopeKeys: () => string[] | Promise<string[]>;
  sessionId?: string;
  sessionLink?: string;
  /** Commit author for tool writes. */
  author?: string;
  /** Mount the file tools (the run cannot write a checkout itself). */
  fileTools: () => boolean;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function line(record: MemoryRecord): string {
  const where = [record.scopeKey, record.kind, record.path]
    .filter(Boolean)
    .join(" · ");
  return `- [${record.id}] (${where}) ${record.summary}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRepoMemoryMcpServer(ctx: RepoMemoryToolContext) {
  const repos = async () => reposForScopes(await ctx.scopeKeys());
  const checkRepo = async (repo: string): Promise<string | null> => {
    const visible = await repos();
    return visible.includes(repo)
      ? null
      : `This run cannot see memory repository "${repo}". Visible: ${visible.join(", ") || "none"}.`;
  };

  const search = [
    tool(
      "search_memory",
      "Ranked search over this run's memory repositories (team, personal, channel). Returns one line per entry with its file path; open the file for context. Use grep in the checkout for exact strings.",
      {
        query: z.string().trim().min(1).max(500),
        kind: z.enum(MEMORY_KINDS).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      async (args) => {
        try {
          const scopeKeys = await ctx.scopeKeys();
          await memoryRepo.service("fresh", reposForScopes(scopeKeys));
          const page = await memoryRepo.index("search", args.query, {
            scopeKeys,
            kinds: args.kind ? [args.kind] : undefined,
            limit: args.limit ?? 10,
            matchAny: true,
            includeDetails: false,
          });
          if (!page.items.length)
            return text(`No memory matches "${args.query}".`);
          return text(page.items.map(line).join("\n"));
        } catch (error) {
          return text(`Memory search failed: ${errorText(error)}`);
        }
      },
    ),
  ];

  const files = !ctx.fileTools()
    ? []
    : [
        tool(
          "list_memory_files",
          "List every file in one memory repository.",
          { repo: z.string().trim().min(1) },
          async (args) => {
            const denied = await checkRepo(args.repo);
            if (denied) return text(denied);
            const files = await memoryRepo.service("listFiles", args.repo);
            return text(
              files.length ? files.join("\n") : "The repository is empty.",
            );
          },
        ),
        tool(
          "read_memory_file",
          "Read one file from a memory repository (latest version).",
          { repo: z.string().trim().min(1), path: z.string().trim().min(1) },
          async (args) => {
            const denied = await checkRepo(args.repo);
            if (denied) return text(denied);
            const content = await memoryRepo.service(
              "readFile",
              args.repo,
              args.path,
            );
            return text(
              content ?? `${args.path} does not exist in ${args.repo}.`,
            );
          },
        ),
        tool(
          "write_memory_file",
          "Create or replace one file in a memory repository and commit it. Read the file first and send the whole new content. Entries are one bullet per line with `[key: value]` metadata at the end.",
          {
            repo: z.string().trim().min(1),
            path: z.string().trim().min(1).max(300),
            content: z.string().max(1_000_000),
            message: z.string().trim().min(1).max(200),
          },
          async (args) => {
            const denied = await checkRepo(args.repo);
            if (denied) return text(denied);
            try {
              await memoryRepo.service(
                "writeFile",
                args.repo,
                args.path,
                args.content,
                {
                  message: args.message,
                  author: ctx.author ? { name: ctx.author } : undefined,
                  session: ctx.sessionId,
                  sessionLink: ctx.sessionLink,
                },
              );
              return text(`Committed ${args.path} to ${args.repo}.`);
            } catch (error) {
              return text(`Not saved: ${errorText(error)}`);
            }
          },
        ),
        tool(
          "delete_memory_file",
          "Delete one file from a memory repository and commit. History keeps it.",
          {
            repo: z.string().trim().min(1),
            path: z.string().trim().min(1),
            message: z.string().trim().min(1).max(200),
          },
          async (args) => {
            const denied = await checkRepo(args.repo);
            if (denied) return text(denied);
            try {
              await memoryRepo.service(
                "writeFile",
                args.repo,
                args.path,
                null,
                {
                  message: args.message,
                  author: ctx.author ? { name: ctx.author } : undefined,
                  session: ctx.sessionId,
                  sessionLink: ctx.sessionLink,
                },
              );
              return text(`Deleted ${args.path} from ${args.repo}.`);
            } catch (error) {
              return text(`Not deleted: ${errorText(error)}`);
            }
          },
        ),
      ];

  const sync = !ctx.fileTools()
    ? []
    : [
        tool(
          "sync_memory_repository",
          "Sync one visible memory repository with its configured upstream and report the result. This commits no changes; file writes already commit separately.",
          { repo: z.string().trim().min(1) },
          async ({ repo }) => {
            const denied = await checkRepo(repo);
            if (denied) return text(denied);
            try {
              const result = await memoryRepo.service("syncRemote", repo);
              return text(JSON.stringify(result));
            } catch (error) {
              return text(`Memory sync failed: ${errorText(error)}`);
            }
          },
        ),
      ];

  return createSdkMcpServer({
    name: "opensession-memory",
    version: "3.0.0",
    tools: [...search, ...files, ...sync],
  });
}
